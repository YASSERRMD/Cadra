/**
 * MCP tools that close the loop from prompt to finished video: `render_scene`
 * submits a render job against the Phase 25 `@cadra/encode` orchestrator
 * (`submitEncodedRenderJob`) and returns a job id immediately, without
 * blocking on the whole render finishing; `get_render_status` polls that
 * job's live per-range progress (reusing `@cadra/encode`'s own
 * `RenderJobStatusSnapshot` shape rather than inventing a parallel one); and
 * `get_render_output` returns a reference to the finished file, once done.
 *
 * `render_scene` loads the named scene from the Phase 29 scene store,
 * validates the named composition exists within it, mints a fresh
 * server-controlled job id and output path under `config.outputDirectory`
 * (see `./render-store.ts` for the exact sandboxing this applies, mirroring
 * `scene-store.ts`'s own discipline), opens a real `fs.createWriteStream`
 * onto that path, and hands it all to `submitEncodedRenderJob` together with
 * `@cadra/encode`'s own exported `BROWSER_HEADLESS_RENDER_ENTRY_PATH` (never
 * a hand-guessed path into that package).
 *
 * Phase 36 adds a generation-readiness pre-flight check before any of that:
 * `submitEncodedRenderJob`'s own deep dependency chain (`@cadra/encode` ->
 * `@cadra/headless` -> a bundled browser-side render entry script) has no
 * `getPendingAssets`-style seam to plug a live async status check into (see
 * `./generation-pending-assets.ts`'s own doc for the lower-level
 * `renderComposition` `getPendingAssets` gate this phase adds for any
 * caller driving that loop directly - `render_scene` itself does not go
 * through that loop, it goes through the browser-bundled range-parallel
 * pipeline instead). So `render_scene` achieves the same "gate the render
 * on generation readiness" outcome at this outer, MCP-tool level instead:
 * before ever calling `submitEncodedRenderJob`, it binds any newly-ready
 * generation slots onto their waiting `VideoNode`s (`./generation-asset-
 * binding.ts`'s `bindReadyGenerationsForScene`, this being exactly one of
 * the "something already checks a slot's status" call sites that performs
 * the "bind on completion" rewrite, persisting that rewrite if anything
 * changed), and refuses to submit the render (with an actionable diagnostic
 * naming every still-not-ready node) if any generation-backed node in the
 * target composition remains unresolved.
 */
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { Composition, Project } from "@cadra/core";
import {
  BROWSER_HEADLESS_RENDER_ENTRY_PATH,
  getEncodedRenderJobStatus,
  submitEncodedRenderJob,
} from "@cadra/encode";
import { RenderJobNotFoundError } from "@cadra/headless";
import { createGenerationStore, type GenerationStore } from "@cadra/providers";
import { compositionRenderModeSchema, parseScene, pathTracingConfigSchema } from "@cadra/schema";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CadraMcpServerConfig } from "./config.js";
import {
  bindReadyGenerationsForScene,
  findPendingGenerationNodes,
} from "./generation-asset-binding.js";
import type { Logger } from "./logger.js";
import {
  getRenderJobRecord,
  mintRenderJobId,
  registerRenderJob,
  resolveRenderOutputPath,
  serializeJobStatus,
  trackRenderJobOutcome,
} from "./render-store.js";
import { readSceneFile, sanitizeSceneId } from "./scene-store.js";

/** Registered tool name for submitting a render job. */
export const RENDER_SCENE_TOOL_NAME = "render_scene";
/** Registered tool name for polling a render job's status. */
export const GET_RENDER_STATUS_TOOL_NAME = "get_render_status";
/** Registered tool name for fetching a finished render job's output reference. */
export const GET_RENDER_OUTPUT_TOOL_NAME = "get_render_output";
/** Registered tool name for submitting a fast, low-resolution draft render job. */
export const PROBE_RENDER_TOOL_NAME = "probe_render";

/** `probe_render`'s default `resolutionScale` when the caller omits one: half linear size (a quarter the pixel count), a reasonable "fast but still legible" default. */
export const DEFAULT_PROBE_RESOLUTION_SCALE = 0.5;
/** `probe_render`'s fixed bitrate: low enough to encode fast at a draft's own reduced resolution, matching its "fast return" purpose - not a caller-tunable field, since a draft's own visual quality is not the point. */
export const DEFAULT_PROBE_BITRATE = 500_000;

/** Options accepted by {@link registerCadraRenderTools}, beyond the `(server, config, logger)` triple every other tool-registration function in this package already takes. */
export interface RegisterCadraRenderToolsOptions {
  /**
   * The {@link GenerationStore} `render_scene`'s pre-flight generation-
   * readiness check reads from (see this module's own doc). Must be the
   * *same* store instance `add_generated_clip`/`get_generation_status`
   * submit into and read from, so a slot this store knows about is actually
   * observable here; `./server.ts` constructs one shared store and passes
   * it to all three. Defaults to a freshly constructed, empty store (no
   * providers registered) when omitted, matching `./generation-tools.ts`'s
   * own default rationale: with no shared store injected, every
   * generation-backed node this check encounters resolves to
   * `"unknownSlot"` (refusing the render), which is the conservative,
   * correct behavior for a scene referencing a slot this process cannot
   * possibly know about. Always inject a pre-populated fake-provider-backed
   * store in tests that exercise this gate; no test in this package's
   * suite may make a real network/vendor call.
   */
  generationStore?: GenerationStore;
}

/** Wraps a JSON-serializable payload as a single-text-block MCP tool result, matching the convention `scene-tools.ts` already established. */
function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** A `{ success: false, message }` tool result payload, shared by every failure mode this module can produce. */
interface RenderToolFailurePayload {
  success: false;
  message: string;
}

/** `render_scene`'s success payload: the job id an agent polls/fetches with, plus the render's own basic parameters echoed back for convenience. */
interface RenderSceneSuccessPayload {
  success: true;
  jobId: string;
  sceneId: string;
  compositionId: string;
  format: "mp4" | "webm";
}

/** `get_render_status`'s success payload: this job's own metadata plus its live `@cadra/encode` status snapshot (serialized; see `./render-store.ts`'s `serializeJobStatus`). */
interface RenderStatusSuccessPayload {
  success: true;
  jobId: string;
  sceneId: string;
  compositionId: string;
  format: "mp4" | "webm";
  submittedAt: string;
  /** Overall outcome once the whole job (every range plus the final mux pass) has settled; `undefined` while still in flight. */
  outcome?: { ok: true } | { ok: false; message: string };
  jobStatus: ReturnType<typeof serializeJobStatus>;
}

/** `get_render_output`'s success payload: a reference to the finished file, not its inlined bytes (see this module's own doc for why). */
interface RenderOutputSuccessPayload {
  success: true;
  jobId: string;
  /** Absolute path to the finished output file on this server. */
  outputPath: string;
  /** `outputPath`'s filename alone, i.e. the reference relative to `outputDirectory`, convenient for a caller that only needs to name the file (e.g. to construct its own download URL). */
  outputFileName: string;
  format: "mp4" | "webm";
}

/** `probe_render`'s success payload: the job id (poll/fetch it exactly like `render_scene`'s own), plus the actual (post-scaling/capping) parameters this draft render used. */
interface ProbeRenderSuccessPayload {
  success: true;
  jobId: string;
  sceneId: string;
  compositionId: string;
  format: "mp4" | "webm";
  width: number;
  height: number;
  durationInFrames: number;
}

/**
 * Scales `value` by `scale`, rounded to the nearest even integer (several
 * video codecs require even width/height for 4:2:0 chroma subsampling),
 * clamped to a minimum of 2 (0 is never a valid dimension).
 */
function scaleDimension(value: number, scale: number): number {
  const scaled = Math.round((value * scale) / 2) * 2;
  return Math.max(2, scaled);
}

/**
 * Ensures `path`'s parent directory exists (creating it, and any missing
 * ancestors, if needed) before a write stream is opened onto it; mirrors
 * `writeSceneDocument`'s own `mkdir(..., { recursive: true })` call in
 * `scene-store.ts`.
 */
async function ensureParentDirectoryExists(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

/** `loadRenderableComposition`'s result once every check has passed: the resolved scene id plus the generation-binding-applied project and the target composition within it. */
interface LoadRenderableCompositionSuccess {
  ok: true;
  sceneId: string;
  project: Project;
  composition: Composition;
}

/** `loadRenderableComposition`'s result when any check fails, carrying the exact payload a caller should return as-is. */
interface LoadRenderableCompositionFailure {
  ok: false;
  payload: RenderToolFailurePayload;
}

type LoadRenderableCompositionResult = LoadRenderableCompositionSuccess | LoadRenderableCompositionFailure;

/**
 * Loads `sceneId`'s persisted document, validates it still parses and has a
 * `compositionId` composition, and runs the generation-readiness pre-flight
 * (binds any newly-ready generation slot, refuses if any generation-backed
 * node in the target composition is still pending) - every check
 * `render_scene`'s own handler ran inline before `probe_render` needed the
 * exact same sequence too. See `registerCadraRenderTools`'s own top-level
 * doc for why this check happens here (an outer MCP-tool pre-flight) rather
 * than deep inside `submitEncodedRenderJob`'s own render loop.
 */
async function loadRenderableComposition(
  workspaceRoot: string,
  toolLogger: Logger,
  generationStore: GenerationStore,
  sceneId: string,
  compositionId: string,
): Promise<LoadRenderableCompositionResult> {
  const idValidation = sanitizeSceneId(sceneId);
  if (!idValidation.valid) {
    return { ok: false, payload: { success: false, message: idValidation.reason } };
  }

  const file = await readSceneFile(workspaceRoot, idValidation.sceneId);
  if (file === undefined) {
    return {
      ok: false,
      payload: {
        success: false,
        message:
          `No scene with id "${idValidation.sceneId}" was found in this workspace. Call ` +
          "list_scenes to see every scene id currently persisted, or create_scene to create it first.",
      },
    };
  }

  const parsed = parseScene(file.raw);
  if (!parsed.success) {
    toolLogger.warn("render tool found a persisted scene file that no longer validates", {
      sceneId: idValidation.sceneId,
      diagnosticCount: parsed.diagnostics.length,
    });
    return {
      ok: false,
      payload: {
        success: false,
        message:
          `Scene "${idValidation.sceneId}" is persisted but no longer validates against the ` +
          "current scene schema; call get_scene or validate_scene for full diagnostics.",
      },
    };
  }

  const composition = parsed.document.project.compositions.find((c) => c.id === compositionId);
  if (composition === undefined) {
    const availableIds = parsed.document.project.compositions.map((c) => c.id);
    return {
      ok: false,
      payload: {
        success: false,
        message:
          `Scene "${idValidation.sceneId}" has no composition with id "${compositionId}". ` +
          `Available composition ids: ${availableIds.length > 0 ? availableIds.join(", ") : "(none)"}.`,
      },
    };
  }

  const bindingResult = await bindReadyGenerationsForScene(
    workspaceRoot,
    idValidation.sceneId,
    generationStore,
    toolLogger,
  );
  const effectiveProject = bindingResult?.document.project ?? parsed.document.project;
  const stillPendingInComposition = findPendingGenerationNodes({
    ...effectiveProject,
    compositions: effectiveProject.compositions.filter((c) => c.id === compositionId),
  });
  if (stillPendingInComposition.length > 0) {
    const nodeIds = stillPendingInComposition.map((pending) => pending.node.id).join(", ");
    return {
      ok: false,
      payload: {
        success: false,
        message:
          `Composition "${compositionId}" of scene "${idValidation.sceneId}" has ` +
          `${stillPendingInComposition.length} VideoNode(s) still waiting on a generation job (${nodeIds}). ` +
          "Call get_generation_status for each slot id (matching the node's own id) to check on it, " +
          "and submit render_scene again once every one reports ready.",
      },
    };
  }

  const effectiveComposition = effectiveProject.compositions.find((c) => c.id === compositionId)!;
  return { ok: true, sceneId: idValidation.sceneId, project: effectiveProject, composition: effectiveComposition };
}

/**
 * Registers `render_scene`, `get_render_status`, and `get_render_output` on
 * `server`. Render jobs are tracked in this process' own in-memory registry
 * (see `./render-store.ts`); job ids from a prior server process are not
 * recognized after a restart, matching `@cadra/headless`'s own
 * per-process job registry.
 */
export function registerCadraRenderTools(
  server: McpServer,
  config: CadraMcpServerConfig,
  logger: Logger,
  options: RegisterCadraRenderToolsOptions = {},
): RegisteredTool[] {
  const toolLogger = logger.child("render-tools");
  const generationStore = options.generationStore ?? createGenerationStore({ providers: {} });

  const renderSceneTool = server.registerTool(
    RENDER_SCENE_TOOL_NAME,
    {
      title: "Render scene",
      description:
        "Submits a render job for one composition within an existing scene, returning a job id " +
        "immediately without waiting for the render to finish. Poll get_render_status with the " +
        "returned job id to track progress, and call get_render_output once it reports done.",
      inputSchema: {
        sceneId: z
          .string()
          .describe("Id of the scene (as persisted by create_scene/update_scene) to render."),
        compositionId: z.string().describe("Id of the composition, within that scene, to render."),
        seed: z
          .union([z.string(), z.number()])
          .describe(
            "Base seed for every frame's rendering; the same seed renders deterministically.",
          ),
        format: z.enum(["mp4", "webm"]).describe("Output container format."),
        bitrate: z.number().positive().describe("Target video bitrate, in bits per second."),
        rangeSizeFrames: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Target frames per parallel render range, before keyframe-alignment rounding. Optional; defaults to @cadra/encode's own default.",
          ),
        maxConcurrency: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Maximum ranges rendered concurrently (i.e. concurrent headless browser instances). Optional; defaults to @cadra/encode's own default.",
          ),
        renderMode: compositionRenderModeSchema
          .optional()
          .describe(
            "Overrides the target composition's own renderMode for this render call only, " +
              "without persisting it onto the scene document (call update_scene for that). " +
              "Omitted uses the composition's own already-persisted renderMode (defaults to raster).",
          ),
        pathTracing: pathTracingConfigSchema
          .optional()
          .describe(
            "Overrides the target composition's own path-traced tuning for this render call " +
              "only, without persisting it onto the scene document. Read only when the effective " +
              "renderMode (this call's own override above, or the composition's persisted value) " +
              "is 'pathTraced'.",
          ),
      },
    },
    async ({
      sceneId,
      compositionId,
      seed,
      format,
      bitrate,
      rangeSizeFrames,
      maxConcurrency,
      renderMode,
      pathTracing,
    }) => {
      const loaded = await loadRenderableComposition(
        config.workspaceRoot,
        toolLogger,
        generationStore,
        sceneId,
        compositionId,
      );
      if (!loaded.ok) {
        return jsonResult(loaded.payload);
      }
      const { sceneId: resolvedSceneId, project: effectiveProject } = loaded;

      // Applies this call's own optional renderMode/pathTracing override onto
      // the target composition only, without persisting either onto the
      // scene document itself - a caller wanting a permanent change still
      // calls update_scene. Every other composition in the project passes
      // through untouched (same object reference, no unnecessary copies).
      const projectToRender =
        renderMode === undefined && pathTracing === undefined
          ? effectiveProject
          : {
              ...effectiveProject,
              compositions: effectiveProject.compositions.map((c) =>
                c.id === compositionId
                  ? {
                      ...c,
                      ...(renderMode !== undefined && { renderMode }),
                      ...(pathTracing !== undefined && { pathTracing }),
                    }
                  : c,
              ),
            };

      const jobId = mintRenderJobId();
      const outputPath = resolveRenderOutputPath(config.outputDirectory, jobId, format);
      await ensureParentDirectoryExists(outputPath);
      const destination = createWriteStream(outputPath);

      let handle;
      try {
        handle = await submitEncodedRenderJob({
          project: projectToRender,
          compositionId,
          seed,
          format,
          bitrate,
          destination,
          entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
          ...(rangeSizeFrames !== undefined ? { rangeSizeFrames } : {}),
          ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toolLogger.error("render_scene failed to submit the render job", {
          sceneId: resolvedSceneId,
          compositionId,
          message,
        });
        return jsonResult({ success: false, message } satisfies RenderToolFailurePayload);
      }

      registerRenderJob({
        jobId,
        encodedJobId: handle.jobId,
        sceneId: resolvedSceneId,
        compositionId,
        format,
        outputPath,
        submittedAt: new Date().toISOString(),
      });
      trackRenderJobOutcome(jobId, handle);

      toolLogger.info("render_scene submitted a render job", {
        jobId,
        encodedJobId: handle.jobId,
        sceneId: resolvedSceneId,
        compositionId,
        format,
      });

      return jsonResult({
        success: true,
        jobId,
        sceneId: resolvedSceneId,
        compositionId,
        format,
      } satisfies RenderSceneSuccessPayload);
    },
  );

  const getRenderStatusTool = server.registerTool(
    GET_RENDER_STATUS_TOOL_NAME,
    {
      title: "Get render status",
      description:
        "Reports a previously-submitted render job's current status: overall status " +
        "(queued/running/done/failed) and every parallel range's own progress, plus the whole " +
        "job's own final outcome once settled (including the final mux pass, which runs after " +
        "every range succeeds).",
      inputSchema: {
        jobId: z.string().describe("Job id returned by a prior render_scene call."),
      },
    },
    ({ jobId }) => {
      const record = getRenderJobRecord(jobId);
      if (record === undefined) {
        return jsonResult({
          success: false,
          message:
            `No render job with id "${jobId}" is known to this server. It may not exist, or ` +
            "this server process may have restarted since it was submitted.",
        } satisfies RenderToolFailurePayload);
      }

      let jobStatus;
      try {
        jobStatus = serializeJobStatus(getEncodedRenderJobStatus(record.encodedJobId));
      } catch (error) {
        if (error instanceof RenderJobNotFoundError) {
          return jsonResult({
            success: false,
            message:
              `Render job "${jobId}" is registered but its underlying render status is no ` +
              "longer available.",
          } satisfies RenderToolFailurePayload);
        }
        throw error;
      }

      return jsonResult({
        success: true,
        jobId,
        sceneId: record.sceneId,
        compositionId: record.compositionId,
        format: record.format,
        submittedAt: record.submittedAt,
        ...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
        jobStatus,
      } satisfies RenderStatusSuccessPayload);
    },
  );

  const getRenderOutputTool = server.registerTool(
    GET_RENDER_OUTPUT_TOOL_NAME,
    {
      title: "Get render output",
      description:
        "Returns a reference (absolute path plus filename) to a render job's finished output " +
        "file, once done. Fails with an actionable message if the job is not yet finished or " +
        "failed. Returns a path reference rather than inlining the file's bytes, since a rendered " +
        "video can be arbitrarily large; read the file directly from outputPath if you need its " +
        "actual bytes.",
      inputSchema: {
        jobId: z.string().describe("Job id returned by a prior render_scene call."),
      },
    },
    ({ jobId }) => {
      const record = getRenderJobRecord(jobId);
      if (record === undefined) {
        return jsonResult({
          success: false,
          message:
            `No render job with id "${jobId}" is known to this server. It may not exist, or ` +
            "this server process may have restarted since it was submitted.",
        } satisfies RenderToolFailurePayload);
      }

      if (record.outcome === undefined) {
        return jsonResult({
          success: false,
          message:
            `Render job "${jobId}" has not finished yet. Call get_render_status to check its ` +
            "current progress.",
        } satisfies RenderToolFailurePayload);
      }

      if (!record.outcome.ok) {
        return jsonResult({
          success: false,
          message: `Render job "${jobId}" failed: ${record.outcome.message}`,
        } satisfies RenderToolFailurePayload);
      }

      return jsonResult({
        success: true,
        jobId,
        outputPath: record.outputPath,
        outputFileName: `${jobId}.${record.format}`,
        format: record.format,
      } satisfies RenderOutputSuccessPayload);
    },
  );

  const probeRenderTool = server.registerTool(
    PROBE_RENDER_TOOL_NAME,
    {
      title: "Probe render",
      description:
        "Submits a fast, low-resolution draft render of a scene's composition - the same " +
        "job/poll/fetch flow as render_scene (use get_render_status/get_render_output with the " +
        "returned jobId), just at a smaller frame size and, optionally, a shorter duration, so the " +
        "whole thing renders much faster. Use this to sanity-check timing/motion/overall " +
        "composition before committing to a full render_scene call; use render_frames instead if " +
        "you only need to see specific frames, not a full clip.",
      inputSchema: {
        sceneId: z
          .string()
          .describe("Id of the scene (as persisted by create_scene/update_scene) to render."),
        compositionId: z.string().describe("Id of the composition, within that scene, to render."),
        seed: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Base seed for every frame\'s rendering. Defaults to "probe" - a draft render\'s own determinism rarely matters.'),
        resolutionScale: z
          .number()
          .positive()
          .max(1)
          .optional()
          .describe(
            "Scales the composition's own width/height by this factor (each rounded to the " +
              `nearest even pixel count, minimum 2). Defaults to ${DEFAULT_PROBE_RESOLUTION_SCALE}.`,
          ),
        maxDurationInFrames: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Caps the render to at most this many frames from the start (frame 0). Omitted " +
              "renders the composition's own full duration.",
          ),
        format: z
          .enum(["mp4", "webm"])
          .optional()
          .describe('Output container format. Defaults to "mp4".'),
        renderMode: compositionRenderModeSchema
          .optional()
          .describe(
            "Overrides the target composition's own renderMode for this render call only; see " +
              "render_scene's own field of the same name.",
          ),
        pathTracing: pathTracingConfigSchema
          .optional()
          .describe(
            "Overrides the target composition's own path-traced tuning for this render call " +
              "only; see render_scene's own field of the same name.",
          ),
      },
    },
    async ({
      sceneId,
      compositionId,
      seed,
      resolutionScale,
      maxDurationInFrames,
      format,
      renderMode,
      pathTracing,
    }) => {
      const loaded = await loadRenderableComposition(
        config.workspaceRoot,
        toolLogger,
        generationStore,
        sceneId,
        compositionId,
      );
      if (!loaded.ok) {
        return jsonResult(loaded.payload);
      }
      const { sceneId: resolvedSceneId, project: effectiveProject, composition } = loaded;

      const effectiveFormat = format ?? "mp4";
      const effectiveSeed = seed ?? "probe";
      const probeWidth = scaleDimension(composition.width, resolutionScale ?? DEFAULT_PROBE_RESOLUTION_SCALE);
      const probeHeight = scaleDimension(composition.height, resolutionScale ?? DEFAULT_PROBE_RESOLUTION_SCALE);
      const probeDurationInFrames =
        maxDurationInFrames !== undefined
          ? Math.min(maxDurationInFrames, composition.durationInFrames)
          : composition.durationInFrames;

      const projectToRender = {
        ...effectiveProject,
        compositions: effectiveProject.compositions.map((c) =>
          c.id === compositionId
            ? {
                ...c,
                width: probeWidth,
                height: probeHeight,
                durationInFrames: probeDurationInFrames,
                ...(renderMode !== undefined && { renderMode }),
                ...(pathTracing !== undefined && { pathTracing }),
              }
            : c,
        ),
      };

      const jobId = mintRenderJobId();
      const outputPath = resolveRenderOutputPath(config.outputDirectory, jobId, effectiveFormat);
      await ensureParentDirectoryExists(outputPath);
      const destination = createWriteStream(outputPath);

      let handle;
      try {
        handle = await submitEncodedRenderJob({
          project: projectToRender,
          compositionId,
          seed: effectiveSeed,
          format: effectiveFormat,
          bitrate: DEFAULT_PROBE_BITRATE,
          destination,
          entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toolLogger.error("probe_render failed to submit the render job", {
          sceneId: resolvedSceneId,
          compositionId,
          message,
        });
        return jsonResult({ success: false, message } satisfies RenderToolFailurePayload);
      }

      registerRenderJob({
        jobId,
        encodedJobId: handle.jobId,
        sceneId: resolvedSceneId,
        compositionId,
        format: effectiveFormat,
        outputPath,
        submittedAt: new Date().toISOString(),
      });
      trackRenderJobOutcome(jobId, handle);

      toolLogger.info("probe_render submitted a draft render job", {
        jobId,
        encodedJobId: handle.jobId,
        sceneId: resolvedSceneId,
        compositionId,
        width: probeWidth,
        height: probeHeight,
        durationInFrames: probeDurationInFrames,
      });

      return jsonResult({
        success: true,
        jobId,
        sceneId: resolvedSceneId,
        compositionId,
        format: effectiveFormat,
        width: probeWidth,
        height: probeHeight,
        durationInFrames: probeDurationInFrames,
      } satisfies ProbeRenderSuccessPayload);
    },
  );

  return [renderSceneTool, getRenderStatusTool, getRenderOutputTool, probeRenderTool];
}
