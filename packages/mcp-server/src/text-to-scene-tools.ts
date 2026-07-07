/**
 * `generate_scene_from_text`: turns a natural-language brief (plus optional
 * duration/fps/size constraints) into a validated Cadra scene document via
 * an LLM, and persists it into this server's workspace exactly like
 * `create_scene` does, reusing the same Phase 29 scene store
 * (`writeSceneDocument`).
 *
 * Built entirely on top of Phase 32's `@cadra/agent-sdk` `TextToScene`
 * adapter (`createTextToSceneAdapter`): this module's own job is purely the
 * MCP-tool wiring around it (input schema, workspace persistence, the
 * `{ success, diagnostics }` failure shape every other write tool in this
 * package already returns), not the generation logic itself, which lives
 * entirely in `@cadra/agent-sdk` and has no knowledge this MCP server, or
 * any workspace, exists.
 *
 * The default adapter this module constructs (when no
 * `TextToSceneAdapterFactory` is injected; see
 * `RegisterCadraTextToSceneToolsOptions`) is wired to the real
 * `@anthropic-ai/sdk`-backed completion function, using
 * `config.providerKeys.anthropic` as its API key (see `./config.ts`'s own
 * doc on `providerKeys`). This factory seam exists for exactly one reason,
 * matching every other real-external-dependency seam in this codebase
 * (`BrowserLauncher`, `VideoEncoderConstructor`): `generate_scene_from_text`
 * talks to a real, metered LLM API in production, and this package's test
 * suite must never spend real API credits or make a real network call, so
 * every test in `./text-to-scene-tools.test.ts` supplies its own fake
 * `TextToScene` adapter (backed by a fake `LlmCompletionFn`, per
 * `@cadra/agent-sdk`'s own injectable design) via this factory, and no test
 * anywhere in this package's suite ever reaches the real default below.
 */
import { createAnthropicLlmCompletionFn, createTextToSceneAdapter, type TextToScene } from "@cadra/agent-sdk";
import { DIAGNOSTIC_CODES, type SceneDocument, type SceneParseDiagnostic } from "@cadra/schema";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CadraMcpServerConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { sanitizeSceneId, writeSceneDocument } from "./scene-store.js";

/** Registered tool name for generating (and persisting) a scene from a natural-language brief. */
export const GENERATE_SCENE_FROM_TEXT_TOOL_NAME = "generate_scene_from_text";

/** Options passed to a {@link TextToSceneAdapterFactory} for one `generate_scene_from_text` call: this server's resolved configuration, plus this particular call's own `maxAttempts` (if the caller supplied one). */
export interface TextToSceneAdapterFactoryOptions {
  /** This server's resolved configuration, e.g. to read `config.providerKeys.anthropic` from. */
  config: CadraMcpServerConfig;
  /** This call's requested attempt limit, if given; `undefined` means "use the adapter's own default". */
  maxAttempts?: number;
}

/** Builds a {@link TextToScene} adapter for one `generate_scene_from_text` call. Injectable for tests; see this module's own doc. */
export type TextToSceneAdapterFactory = (options: TextToSceneAdapterFactoryOptions) => TextToScene;

/** Options accepted by {@link registerCadraTextToSceneTools}, beyond the `(server, config, logger)` triple every other tool-registration function in this package already takes. */
export interface RegisterCadraTextToSceneToolsOptions {
  /**
   * Constructs the {@link TextToScene} adapter `generate_scene_from_text`
   * calls. Defaults to {@link createDefaultTextToSceneAdapter} (a real
   * `@anthropic-ai/sdk`-backed adapter, keyed from
   * `config.providerKeys.anthropic`) when omitted. Always override this in
   * tests with a fake adapter (backed by a fake `LlmCompletionFn`) so no
   * test ever makes a real, paid LLM API call.
   */
  adapterFactory?: TextToSceneAdapterFactory;
}

/** The real default {@link TextToSceneAdapterFactory}: a `createTextToSceneAdapter()` wired to a real `@anthropic-ai/sdk`-backed completion function, keyed from `config.providerKeys.anthropic`. */
export function createDefaultTextToSceneAdapter(options: TextToSceneAdapterFactoryOptions): TextToScene {
  const apiKey = options.config.providerKeys.anthropic;
  return createTextToSceneAdapter({
    completionFn: createAnthropicLlmCompletionFn(apiKey !== undefined ? { apiKey } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });
}

/** Wraps a JSON-serializable payload as a single-text-block MCP tool result, matching every other tool in this package. */
function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** Builds a single-diagnostic failure payload, matching the shape every write tool in this package already returns on a non-`parseScene` rejection (e.g. `scene-tools.ts`'s own `singleDiagnosticFailure`; duplicated here rather than imported since that helper is not exported from that module). */
function singleDiagnosticFailure(path: string, message: string, code: string): GenerateSceneFromTextFailurePayload {
  return { success: false, diagnostics: [{ path, message, code }] };
}

/** `generate_scene_from_text`'s success payload: the persisted document, its rationale (if the model gave one), and how many attempts generation took. */
interface GenerateSceneFromTextSuccessPayload {
  success: true;
  document: SceneDocument;
  rationale?: string;
  attempts: number;
}

/** `generate_scene_from_text`'s failure payload: the final attempt's diagnostics, mirroring every other write tool's `{ success: false, diagnostics }` shape. */
interface GenerateSceneFromTextFailurePayload {
  success: false;
  diagnostics: SceneParseDiagnostic[];
}

/** Zod shape for the optional hard constraints `generate_scene_from_text` accepts, mirroring `@cadra/agent-sdk`'s `TextToSceneConstraints`. */
const constraintsShape = {
  durationInFrames: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Exact total length the generated composition's durationInFrames must match, in whole frames."),
  fps: z.number().int().positive().optional().describe("Frame rate the generated composition's fps must match."),
  size: z
    .object({
      width: z.number().int().positive().describe("Exact output width, in pixels."),
      height: z.number().int().positive().describe("Exact output height, in pixels."),
    })
    .optional()
    .describe("Exact output frame size the generated composition's width/height must match."),
};

/**
 * Registers `generate_scene_from_text` on `server`: generates a scene from a
 * natural-language brief via the configured {@link TextToScene} adapter, and
 * persists it under `config.workspaceRoot`'s `scenes` directory (the same
 * Phase 29 scene store `create_scene`/`update_scene` use) on success.
 *
 * `sceneId` is used only as the storage key (the filename this scene is
 * persisted under); the generated document's own `project.id` is whatever
 * the model produced, which may or may not match `sceneId`. This mirrors
 * `update_scene`'s existing "replace" mode, which likewise never requires a
 * replacement document's `project.id` to equal the `sceneId` it is stored
 * under; nothing elsewhere in this package ties the two together.
 */
export function registerCadraTextToSceneTools(
  server: McpServer,
  config: CadraMcpServerConfig,
  logger: Logger,
  options: RegisterCadraTextToSceneToolsOptions = {},
): RegisteredTool {
  const toolLogger = logger.child("text-to-scene-tools");
  const adapterFactory = options.adapterFactory ?? createDefaultTextToSceneAdapter;

  return server.registerTool(
    GENERATE_SCENE_FROM_TEXT_TOOL_NAME,
    {
      title: "Generate scene from text",
      description:
        "Generates a Cadra scene document from a natural-language brief via an LLM, and persists " +
        "it in the configured workspace under the given scene id, exactly like create_scene. The " +
        "underlying adapter self-corrects on an invalid first draft: on a validation failure, it " +
        "re-prompts the model with the exact diagnostics found, up to a configurable number of " +
        "attempts, before giving up. On success, returns the validated document, the model's " +
        "rationale for its choices (if it gave one), and how many attempts generation took. On " +
        "failure (every attempt exhausted), returns the final attempt's diagnostics and does not " +
        "persist anything.",
      inputSchema: {
        sceneId: z
          .string()
          .describe(
            "Unique id for the new scene; used as the filename this scene is persisted under " +
              "(not necessarily the same as the generated document's own project.id, which comes " +
              "from the model). Letters, digits, hyphens, and underscores only.",
          ),
        brief: z
          .string()
          .describe(
            "Free-text description of the scene to generate, e.g. 'A 5-second title card: our " +
              "logo fades in over a dark background, then the tagline types on underneath it.'",
          ),
        constraints: z
          .object(constraintsShape)
          .optional()
          .describe("Optional hard constraints the generated composition must satisfy exactly."),
        maxAttempts: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Maximum number of completion attempts (the first attempt plus every self-correction " +
              "retry) before giving up. Optional; defaults to the adapter's own default.",
          ),
      },
    },
    async ({ sceneId, brief, constraints, maxAttempts }) => {
      const idValidation = sanitizeSceneId(sceneId);
      if (!idValidation.valid) {
        return jsonResult(singleDiagnosticFailure("sceneId", idValidation.reason, "INVALID_SCENE_ID"));
      }

      if (brief.trim().length === 0) {
        return jsonResult(
          singleDiagnosticFailure("brief", "brief must not be blank.", DIAGNOSTIC_CODES.MISSING_REQUIRED_FIELD),
        );
      }

      const adapter = adapterFactory({ config, ...(maxAttempts !== undefined ? { maxAttempts } : {}) });
      const result = await adapter.generate({ brief, ...(constraints !== undefined ? { constraints } : {}) });

      if (!result.success) {
        toolLogger.debug("generate_scene_from_text exhausted every attempt", {
          sceneId: idValidation.sceneId,
          attempts: result.attempts,
          diagnosticCount: result.diagnostics.length,
        });
        return jsonResult({
          success: false,
          diagnostics: result.diagnostics,
        } satisfies GenerateSceneFromTextFailurePayload);
      }

      await writeSceneDocument(config.workspaceRoot, idValidation.sceneId, result.document);
      toolLogger.info("generate_scene_from_text persisted a generated scene", {
        sceneId: idValidation.sceneId,
        attempts: result.attempts,
      });

      return jsonResult({
        success: true,
        document: result.document,
        attempts: result.attempts,
        ...(result.rationale !== undefined ? { rationale: result.rationale } : {}),
      } satisfies GenerateSceneFromTextSuccessPayload);
    },
  );
}
