/**
 * Phase 35 task 4: `get_generation_status`, the read-only MCP tool an agent
 * calls to check a generative-video slot's current status against Phase
 * 35's `@cadra/providers` job store (`GenerationStore`; see that package's
 * `generation-store.ts` for the full dedup-cache/slot design).
 *
 * This phase's MCP surface is deliberately scoped to status-checking only:
 * there is no `submit_generation`/`add_generated_clip`-style tool here,
 * matching this phase's own scope note ("a one-step 'generate and insert
 * into the scene' tool is explicitly Phase 36's job, not yours"). The
 * `GenerationStore` this tool reads is therefore injectable
 * (`RegisterCadraGenerationToolsOptions.store`), defaulting to a freshly
 * constructed, empty store (`createGenerationStore({ providers: {} })`) when
 * omitted - in production, with no submit-capable tool registered yet in
 * this phase, that default store legitimately starts and stays empty (every
 * `get_generation_status` call reports "unknown slot" until a later phase
 * registers a tool that submits into this same injected store instance).
 * Tests inject their own pre-populated store (built with a fake
 * `VideoProvider`, never a real network call) to exercise every status
 * outcome.
 *
 * Phase 36 adds one optional input, `sceneId`: when given (a caller knows
 * the slot it is checking belongs to a specific scene, e.g. one
 * `add_generated_clip` returned), this call also runs
 * `./generation-asset-binding.ts`'s `bindReadyGenerationsForScene` for that
 * scene before returning, rewriting any of its `VideoNode`s whose
 * generation slot is now `"ready"` from a `cadra-generation://` placeholder
 * ref to a real `cadra-asset://` ref and persisting that change. This makes
 * "check a slot's status" and "bind that scene's now-ready generations onto
 * their nodes" the same call for the common case, per this phase's
 * "automatically on completion" design (see that module's own doc): the
 * very next `get_generation_status` call naming a scene id performs the
 * rewrite, with no separate tool or background process needed for it to
 * happen. Omitting `sceneId` preserves this tool's exact original,
 * scene-agnostic, read-only behavior.
 */
import { createGenerationStore, type GenerationStore } from "@cadra/providers";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CadraMcpServerConfig } from "./config.js";
import { bindReadyGenerationsForScene } from "./generation-asset-binding.js";
import type { Logger } from "./logger.js";
import { sanitizeSceneId } from "./scene-store.js";

/** Registered tool name for checking a generation slot's status. */
export const GET_GENERATION_STATUS_TOOL_NAME = "get_generation_status";

/** Options accepted by {@link registerCadraGenerationTools}, beyond the `(server, config, logger)` triple every other tool-registration function in this package already takes. */
export interface RegisterCadraGenerationToolsOptions {
  /**
   * The {@link GenerationStore} `get_generation_status` reads from. Defaults
   * to a freshly constructed, empty store (no providers registered) when
   * omitted; see this module's own doc for why that default is correct for
   * this phase's read-only scope. Always inject a pre-populated store (built
   * with a fake `VideoProvider`) in tests.
   */
  store?: GenerationStore;
}

/** Wraps a JSON-serializable payload as a single-text-block MCP tool result, matching every other tool in this package. */
function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** A `{ success: false, message }` tool result payload, shared by every failure mode this module can produce, matching `render-tools.ts`'s own `RenderToolFailurePayload`. */
interface GenerationToolFailurePayload {
  success: false;
  message: string;
}

/** `get_generation_status`'s success payload: the slot id echoed back plus its current resolved status, exactly as `GenerationStore.getSlotStatus` returns it (a placeholder while generating, the ready `outputUrl`, or the failed `error`). `bound` (Phase 36) reports whether this call's `sceneId` binding pass (if `sceneId` was given) actually rewrote this slot's node to a real asset ref just now; `undefined` when no `sceneId` was given. */
interface GenerationStatusSuccessPayload {
  success: true;
  slotId: string;
  resolution: ReturnType<GenerationStore["getSlotStatus"]>;
  bound?: boolean;
}

/**
 * Registers `get_generation_status` on `server`. Reads from
 * `options.store` (defaulting to an empty {@link createGenerationStore}
 * result; see this module's own doc), never constructs its own hidden
 * store, matching every real `VideoProvider`/`GenerationStore` in this
 * codebase's "no hidden global state" discipline.
 */
export function registerCadraGenerationTools(
  server: McpServer,
  config: CadraMcpServerConfig,
  logger: Logger,
  options: RegisterCadraGenerationToolsOptions = {},
): RegisteredTool[] {
  const toolLogger = logger.child("generation-tools");
  const store = options.store ?? createGenerationStore({ providers: {} });

  const getGenerationStatusTool = server.registerTool(
    GET_GENERATION_STATUS_TOOL_NAME,
    {
      title: "Get generation status",
      description:
        "Reports a generative-video slot's current status: a placeholder descriptor " +
        "(solid/spinner/lastKnownFrame) while its current generation request is still pending or " +
        "running, the finished clip's outputUrl once the vendor reports success, or the failure " +
        "reason once it terminally fails. If sceneId is given, also binds any of that scene's " +
        "VideoNodes whose generation slot is now ready onto a real cadra-asset:// ref (rewriting " +
        "and persisting the scene document) before returning, so checking a slot you know belongs " +
        "to a scene also resolves that scene's placeholder ref automatically.",
      inputSchema: {
        slotId: z
          .string()
          .describe(
            "Id of the generation slot to check, e.g. a VideoNode's own id in a scene, or any " +
              "other caller-chosen slot key previously submitted against this server's generation store.",
          ),
        sceneId: z
          .string()
          .optional()
          .describe(
            "Optional id of the scene this slot's VideoNode belongs to (as persisted by " +
              "create_scene/update_scene/add_generated_clip). When given, also binds that scene's " +
              "now-ready generation slots onto their real asset refs before returning.",
          ),
      },
    },
    async ({ slotId, sceneId }) => {
      let resolution;
      try {
        resolution = store.getSlotStatus(slotId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toolLogger.debug("get_generation_status found no such slot", { slotId, message });
        return jsonResult({ success: false, message } satisfies GenerationToolFailurePayload);
      }

      let bound: boolean | undefined;
      if (sceneId !== undefined) {
        const idValidation = sanitizeSceneId(sceneId);
        if (!idValidation.valid) {
          return jsonResult({
            success: false,
            message: idValidation.reason,
          } satisfies GenerationToolFailurePayload);
        }
        const bindingResult = await bindReadyGenerationsForScene(
          config.workspaceRoot,
          idValidation.sceneId,
          store,
          toolLogger,
        );
        bound =
          bindingResult?.outcomes.some(
            (outcome) => outcome.slotId === slotId && outcome.outcome === "bound",
          ) ?? false;
      }

      return jsonResult({
        success: true,
        slotId,
        resolution,
        ...(bound !== undefined ? { bound } : {}),
      } satisfies GenerationStatusSuccessPayload);
    },
  );

  return [getGenerationStatusTool];
}
