import { CURRENT_SCHEMA_VERSION, describeCadraContract, type SceneParseDiagnostic } from "@cadra/schema";

import type { TextToSceneConstraints } from "./text-to-scene.js";

/**
 * One prior attempt's raw output plus the exact diagnostics `parseScene` (or
 * this module's own JSON-extraction step) produced against it, folded into
 * the next retry prompt by {@link buildTextToScenePrompt} so the model can
 * see precisely what it got wrong last time rather than being asked to
 * guess blind on a second try.
 */
export interface PriorAttempt {
  /** The previous attempt's raw, unmodified completion text (not the extracted/parsed JSON), so the model can see exactly what it said, fences and all. */
  rawOutput: string;
  /** The exact diagnostics that attempt produced, in the same `{ path, message, code, expected?, suggestedFix? }` shape `parseScene` itself returns. */
  diagnostics: readonly SceneParseDiagnostic[];
}

/** Renders one {@link TextToSceneConstraints} field set as a bullet list, or `undefined` if no constraint was given at all. */
function renderConstraints(constraints: TextToSceneConstraints | undefined): string | undefined {
  if (constraints === undefined) {
    return undefined;
  }

  const lines: string[] = [];
  if (constraints.durationInFrames !== undefined) {
    lines.push(`- The composition's durationInFrames MUST be exactly ${constraints.durationInFrames}.`);
  }
  if (constraints.fps !== undefined) {
    lines.push(`- The composition's fps MUST be exactly ${constraints.fps}.`);
  }
  if (constraints.size !== undefined) {
    lines.push(
      `- The composition's width MUST be exactly ${constraints.size.width}, and height MUST be exactly ${constraints.size.height}.`,
    );
  }
  return lines.length === 0 ? undefined : lines.join("\n");
}

/**
 * Renders one {@link SceneParseDiagnostic} as a single readable line, folding
 * in every field a diagnostic may carry (`expected`, `suggestedFix`) beyond
 * the bare `path`/`message`/`code`, since the whole point of feeding these
 * back is to give the model as much of parseScene's own structured
 * explanation as possible, not just the prose `message`.
 */
function renderDiagnostic(diagnostic: SceneParseDiagnostic): string {
  const parts = [`[${diagnostic.code}] at "${diagnostic.path}": ${diagnostic.message}`];
  if (diagnostic.expected !== undefined) {
    parts.push(`  Expected: ${diagnostic.expected}`);
  }
  if (diagnostic.suggestedFix !== undefined) {
    parts.push(`  Suggested fix: ${diagnostic.suggestedFix}`);
  }
  return parts.join("\n");
}

/**
 * Builds the complete prompt string sent to the underlying `LlmCompletionFn`
 * for one generation attempt.
 *
 * Every prompt (first attempt or retry) includes: the full Phase 27 contract
 * (`describeCadraContract()`'s JSON Schema and capability manifest, so the
 * model has the exact shape it must produce and the exact vocabulary of
 * primitives/properties/easings available to it), the curated example
 * documents (real, valid scenes to pattern-match against), the caller's
 * brief and constraints, and explicit instructions to reply with JSON only
 * (tolerating, but not asking for, a fenced code block) and never to use
 * schemaVersion other than the current one.
 *
 * When `priorAttempt` is given (every retry after the first), the prompt
 * additionally includes that attempt's exact raw output and diagnostics,
 * with an explicit instruction to correct exactly those problems and
 * nothing else. This is the self-correction loop's entire mechanism: no
 * conversation history or vendor-specific multi-turn state is used, just a
 * single self-contained prompt string per attempt, matching the
 * `LlmCompletionFn`'s own single free-text-in/free-text-out contract.
 */
export function buildTextToScenePrompt(
  brief: string,
  constraints: TextToSceneConstraints | undefined,
  priorAttempt?: PriorAttempt,
): string {
  const contract = describeCadraContract();
  const constraintsText = renderConstraints(constraints);

  const sections: string[] = [
    "You are generating a Cadra scene document: a JSON document describing a " +
      "code-first 3D video animation, built on Three.js and WebGPU.",
    "Your entire response MUST be a single JSON document matching the schema " +
      "below (a fenced ```json code block is fine, but nothing else in your " +
      "response should appear outside it). Do not include any explanation of " +
      "your choices inside the JSON itself; if you want to explain your " +
      `reasoning, put a short "rationale" field alongside (not inside) the ` +
      'JSON document, e.g. as a sentence before the ```json block. That ' +
      "rationale is optional; omit it if you have nothing to add.",
    `The JSON document must have schemaVersion exactly ${CURRENT_SCHEMA_VERSION} and match this JSON Schema:\n${JSON.stringify(contract.jsonSchema)}`,
    `The capability manifest below documents every supported node kind, ` +
      `animatable property, easing, and codec extension point:\n${JSON.stringify(contract.capabilities)}`,
    `Here are ${contract.examples.length} real, valid example scene documents to use as a pattern reference:\n` +
      contract.examples
        .map((example) => `Example "${example.name}" (${example.description}):\n${JSON.stringify(example.document)}`)
        .join("\n\n"),
    `Generate a scene document for this brief:\n"${brief}"`,
  ];

  if (constraintsText !== undefined) {
    sections.push(`The generated composition must also satisfy these hard constraints:\n${constraintsText}`);
  }

  if (priorAttempt !== undefined) {
    sections.push(
      "Your previous attempt at this same brief was rejected. Here is exactly " +
        "what you produced last time:\n" +
        priorAttempt.rawOutput,
    );
    sections.push(
      "Here are the exact problems found with that attempt:\n" +
        priorAttempt.diagnostics.map(renderDiagnostic).join("\n\n") +
        "\n\nCorrect exactly these problems in your next attempt. Do not " +
        "otherwise change parts of the document that were not flagged above.",
    );
  }

  return sections.join("\n\n");
}
