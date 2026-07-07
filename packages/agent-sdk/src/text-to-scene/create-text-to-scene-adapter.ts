import { applyPatchAtPath, parseScene, type SceneParseDiagnostic } from "@cadra/schema";

import { extractJsonFromLlmResponse } from "./json-extraction.js";
import type { LlmCompletionFn } from "./llm-completion.js";
import { buildTextToScenePrompt, type PriorAttempt } from "./prompt-building.js";
import type { TextToScene, TextToSceneRequest, TextToSceneResult } from "./text-to-scene.js";

/** Default number of completion attempts (the first attempt plus every retry) before giving up. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Options accepted by {@link createTextToSceneAdapter}. */
export interface CreateTextToSceneAdapterOptions {
  /**
   * The completion function to prompt. Defaults to a real
   * `@anthropic-ai/sdk`-backed implementation (see
   * `./anthropic-adapter.ts`'s `createAnthropicLlmCompletionFn`) if omitted,
   * matching every other `*Like`/`*Constructor` real-by-default,
   * injectable-for-tests seam in this codebase. Tests must always supply
   * their own fake here; see this module's own test suite for why (no test
   * in this package's suite ever constructs the default).
   */
  completionFn?: LlmCompletionFn;
  /**
   * Maximum number of completion attempts (the first attempt plus every
   * retry) before giving up and returning a {@link TextToSceneFailure}.
   * Defaults to {@link DEFAULT_MAX_ATTEMPTS}. Must be at least 1.
   */
  maxAttempts?: number;
}

/**
 * A single synthetic {@link SceneParseDiagnostic} describing a JSON-extraction
 * failure (the model's raw response contained no parseable JSON at all),
 * used both as this generation's final failure diagnostic and folded into
 * the next retry prompt exactly like a real `parseScene` diagnostic. Shares
 * `parseScene`'s own diagnostic shape (rather than a bespoke error type) so
 * every consumer of a `TextToSceneFailure` (this adapter's own retry loop,
 * the `generate_scene_from_text` MCP tool, any future caller) handles this
 * failure mode identically to a schema-validation failure, with no separate
 * code path to special-case "the model's text was not JSON at all" versus
 * "the model's JSON was not a valid scene".
 */
function jsonExtractionFailureDiagnostic(reason: string): SceneParseDiagnostic {
  return {
    path: "<root>",
    message: reason,
    code: "JSON_EXTRACTION_FAILED",
    suggestedFix: "Reply with a single JSON document (a fenced ```json code block is fine) and nothing else.",
  };
}

/**
 * Attempts the cheap first pass described in this phase's task 2: applies
 * every `suggestedPatch` the failed candidate's diagnostics carry (via
 * `@cadra/schema`'s `applyPatchAtPath`, the exact same primitive
 * `@cadra/mcp-server`'s `repair_scene` tool already uses for the identical
 * purpose) and re-validates. Returns the repaired, now-valid document if
 * this succeeds, or `undefined` if no diagnostic carried a patch, a patch
 * failed to apply, or the patched result still does not validate; either way
 * the caller falls through to a full model re-prompt with the *original*
 * (unpatched) diagnostics, exactly as if this cheap pass had never been
 * tried.
 *
 * See this module's own doc, and the phase report, for why this pass exists
 * at all: it is a deliberately narrow, free win (no model call, no latency,
 * no attempt budget spent) for exactly the same safe/unambiguous error
 * classes `repair_scene` already covers (a missing numeric field with a
 * conservative default, an out-of-range number clamped to its bound, an
 * unrecognized field removed, a padded asset ref trimmed); it is not a
 * substitute for the model re-prompt loop, which remains the only recourse
 * for anything this cheap pass cannot fix (headline example: an unknown node
 * `kind`, which `parseScene` deliberately never attaches a `suggestedPatch`
 * to at all).
 */
function tryCheapPatchRepair(rawCandidate: unknown, diagnostics: readonly SceneParseDiagnostic[]) {
  let patched = rawCandidate;
  let appliedAny = false;

  for (const diagnostic of diagnostics) {
    const patch = diagnostic.suggestedPatch;
    if (patch === undefined) {
      continue;
    }
    try {
      patched = applyPatchAtPath(patched, patch.path, patch.op, patch.value);
      appliedAny = true;
    } catch {
      // This specific patch no longer applies cleanly (e.g. an earlier patch
      // in this same batch already changed the location it targets); skip it
      // and continue with the rest of the batch, matching
      // `repair_scene`'s own `applySuggestedPatches` behavior.
    }
  }

  if (!appliedAny) {
    return undefined;
  }

  const repaired = parseScene(patched);
  return repaired.success ? repaired.document : undefined;
}

/**
 * Derives `TextToSceneSuccess.rationale` from a successful JSON extraction's
 * leftover text: trims it, and additionally strips a bare closing code-fence
 * backtick sequence some models leave dangling when the JSON block was
 * opened with a language tag but the surrounding prose parser only matched
 * part of the fence. Returns `undefined` (never a fabricated placeholder
 * string) whenever there is genuinely nothing left over, matching
 * `TextToSceneSuccess.rationale`'s own documented "never fabricated" contract.
 */
function deriveRationale(leftoverText: string | undefined): string | undefined {
  if (leftoverText === undefined) {
    return undefined;
  }
  const cleaned = leftoverText.replace(/^```+\s*|```+\s*$/g, "").trim();
  return cleaned.length === 0 ? undefined : cleaned;
}

/**
 * Creates a {@link TextToScene} adapter: a self-correcting text-to-scene
 * generator built purely against the vendor-neutral `LlmCompletionFn` seam
 * (see `./llm-completion.ts`), with zero knowledge of which (if any) real
 * vendor is behind `options.completionFn`.
 *
 * Generation proceeds, for up to `options.maxAttempts` attempts:
 *
 * 1. Build a prompt (`buildTextToScenePrompt`): the Phase 27 contract plus
 *    curated examples, the caller's brief/constraints, and (from the second
 *    attempt onward) the previous attempt's raw output and exact
 *    diagnostics.
 * 2. Call `completionFn` with that prompt.
 * 3. Extract a JSON value from the raw response (`extractJsonFromLlmResponse`,
 *    tolerating a fenced code block or surrounding prose). A candidate whose
 *    JSON cannot be extracted at all is treated as a failed attempt with a
 *    single synthetic `JSON_EXTRACTION_FAILED` diagnostic, exactly like a
 *    `parseScene` failure, so the retry prompt still has something concrete
 *    to correct.
 * 4. Validate the extracted JSON with `@cadra/schema`'s `parseScene`.
 * 5. On a validation failure only (not a JSON-extraction failure, which has
 *    nothing to patch), try the cheap `suggestedPatch`-application pass
 *    (`tryCheapPatchRepair`) before spending another model call: if every
 *    diagnostic that carries a patch resolves the document to a fully valid
 *    one with no model round trip at all, succeed immediately without
 *    consuming a retry attempt. Otherwise fall through to a genuine retry
 *    with the *original* diagnostics fed back to the model.
 *
 * Succeeds as soon as any attempt (or that attempt's cheap-patch pass)
 * yields a valid document. Fails, returning the last attempt's diagnostics,
 * once `maxAttempts` is exhausted with no success.
 *
 * This function itself is synchronous (the async work happens inside the
 * returned adapter's `generate` method); it never calls `completionFn`
 * during construction, so constructing an adapter (even with the real
 * default, uninjected) never makes a network call on its own; only calling
 * `.generate(...)` does.
 */
export function createTextToSceneAdapter(options: CreateTextToSceneAdapterOptions = {}): TextToScene {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be at least 1 (received ${maxAttempts}).`);
  }

  return {
    async generate(request: TextToSceneRequest): Promise<TextToSceneResult> {
      // The real default (`createAnthropicLlmCompletionFn`) is resolved lazily,
      // only once `generate` is actually called, and only if no
      // `completionFn` was injected: constructing the adapter must never
      // require an API key or touch `@anthropic-ai/sdk` at all when a caller
      // (e.g. every test in this package's own suite) always injects a fake.
      const completionFn = options.completionFn ?? (await resolveDefaultCompletionFn());

      let priorAttempt: PriorAttempt | undefined;
      let lastDiagnostics: SceneParseDiagnostic[] = [];

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const prompt = buildTextToScenePrompt(request.brief, request.constraints, priorAttempt);
        const rawOutput = await completionFn(prompt);

        const extraction = extractJsonFromLlmResponse(rawOutput);
        if (!extraction.success) {
          const diagnostic = jsonExtractionFailureDiagnostic(extraction.reason);
          lastDiagnostics = [diagnostic];
          priorAttempt = { rawOutput, diagnostics: lastDiagnostics };
          continue;
        }

        const parsed = parseScene(extraction.value);
        if (parsed.success) {
          return {
            success: true,
            document: parsed.document,
            attempts: attempt,
            ...(deriveRationale(extraction.leftoverText) !== undefined
              ? { rationale: deriveRationale(extraction.leftoverText) }
              : {}),
          };
        }

        lastDiagnostics = parsed.diagnostics;

        const cheapRepair = tryCheapPatchRepair(extraction.value, parsed.diagnostics);
        if (cheapRepair !== undefined) {
          return {
            success: true,
            document: cheapRepair,
            attempts: attempt,
            ...(deriveRationale(extraction.leftoverText) !== undefined
              ? { rationale: deriveRationale(extraction.leftoverText) }
              : {}),
          };
        }

        priorAttempt = { rawOutput, diagnostics: lastDiagnostics };
      }

      return { success: false, diagnostics: lastDiagnostics, attempts: maxAttempts };
    },
  };
}

/**
 * Lazily imports and constructs the real `@anthropic-ai/sdk`-backed default
 * `LlmCompletionFn`, only reached when `generate` is called with no injected
 * `completionFn`. A dynamic `import()` here (rather than a static top-level
 * import of `./anthropic-adapter.js`) keeps constructing an `Anthropic`
 * client (which reads `process.env.ANTHROPIC_API_KEY` the moment it is
 * instantiated) entirely out of the module-load path for every caller that
 * always injects its own `completionFn`, which is every test in this
 * package's suite and, in production, the `generate_scene_from_text` MCP
 * tool whenever it is given an explicit key via `providerKeys.anthropic`.
 */
async function resolveDefaultCompletionFn(): Promise<LlmCompletionFn> {
  const { createAnthropicLlmCompletionFn } = await import("./anthropic-adapter.js");
  return createAnthropicLlmCompletionFn();
}
