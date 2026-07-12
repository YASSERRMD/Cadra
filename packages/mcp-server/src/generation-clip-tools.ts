/**
 * Phase 36 task 4: `add_generated_clip`, the one-step MCP tool that requests
 * a generative-video job and inserts its (eventual) output as a clip layer
 * on an existing scene's timeline, in a single call.
 *
 * Given a scene id, composition id, target track (an existing track id, or
 * a brand-new one to create), placement (`startFrame`/`durationInFrames`),
 * a generation request (`providerName` plus `prompt`/`referenceImageUrls`/
 * `params`, exactly `@cadra/providers`' own `VideoGenerationRequest` shape),
 * and an optional `transitionIn` (Phase 11's existing `Transition` shape,
 * applied to the new clip exactly like any hand-authored one), this tool:
 *
 * 1. Submits the generation via the shared `GenerationStore.submitGeneration`
 *    (Phase 35), keyed by the new `VideoNode`'s own id as its generation
 *    slot id.
 * 2. Constructs a new `VideoNode` whose `assetRef` is the
 *    `cadra-generation://<slotId>` placeholder ref (`./generation-asset-
 *    binding.ts`), optionally carrying `blendMode`/`maskRef` (Phase 36's
 *    data-model addition) if the caller supplied them.
 * 3. Wraps that node in a new `Clip` (with the given placement and
 *    `transitionIn`), and inserts it onto the named track - either an
 *    existing one (by id) or a freshly-created one.
 * 4. Persists the updated scene document (after `parseScene` validates it,
 *    exactly like every other write in this package) and returns
 *    immediately: job/slot info plus the updated scene, without blocking on
 *    generation completion.
 *
 * **Why this constructs the updated `Project` directly, rather than
 * extending `./scene-patch.ts`'s `ScenePatchOperation` system with a new
 * operation**: `ScenePatchOperation` (`addNode`/`updateNode`/`removeNode`)
 * only operates one level of the hierarchy down from where this tool needs
 * to write - it can add/update/remove a *node* within an existing `Clip`'s
 * subtree, addressed by a node id already present in some clip's tree (see
 * `scene-patch.ts`'s own doc: it locates the clip whose tree already
 * contains the operation's anchor id). Inserting a brand-new `Clip` onto a
 * `Track` (or a brand-new `Track` onto a `Composition`) is a different
 * level of the `Project -> Composition -> Track -> Clip -> SceneNode`
 * hierarchy that operation set was never scoped to reach. Extending it
 * would mean adding a new operation kind whose only real caller would be
 * this one tool, plus its own new composition/track lookup-or-create logic
 * - essentially duplicating this module's own `insertClipOntoTrack` either
 * way. Building the modified `Project` directly here, then persisting it
 * through the exact same `writeSceneDocument`/`parseScene` gate
 * `update_scene`'s own "replace" mode already goes through, is simpler,
 * carries the same validation guarantee, and avoids growing the
 * general-purpose patch-operation surface for a single-caller need.
 */
import type { Clip } from "@cadra/core";
import { Video } from "@cadra/core";
import type { GenerationStore } from "@cadra/providers";
import { parseScene, type SceneDocument, type SceneParseDiagnostic, transitionSchema } from "@cadra/schema";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CadraMcpServerConfig } from "./config.js";
import { buildGenerationRef } from "./generation-asset-binding.js";
import type { Logger } from "./logger.js";
import { projectContainsNodeId } from "./scene-patch.js";
import { readSceneFile, sanitizeSceneId, writeSceneDocument } from "./scene-store.js";
import {
  insertClipOntoTrack,
  resolveTrackSelector,
  singleDiagnosticFailure,
  trackSelectorShape,
} from "./track-insertion.js";

/** Registered tool name for the one-step generate-and-insert-clip tool. */
export const ADD_GENERATED_CLIP_TOOL_NAME = "add_generated_clip";

/** Options accepted by {@link registerCadraGenerationClipTools}. */
export interface RegisterCadraGenerationClipToolsOptions {
  /**
   * The {@link GenerationStore} `add_generated_clip` submits generations
   * into. This must be the *same* store instance `get_generation_status`
   * (`./generation-tools.ts`) and the render path's `getPendingAssets` gate
   * (`./generation-pending-assets.ts`) read from, so a slot this tool
   * submits is actually observable by whatever later checks its status;
   * `./server.ts` constructs one shared store and passes it to all three.
   * Always inject a pre-populated fake-provider-backed store in tests (per
   * `./generation-tools.ts`'s own doc); no test in this package's suite may
   * make a real network/vendor call.
   */
  store: GenerationStore;
}

/** Wraps a JSON-serializable payload as a single-text-block MCP tool result, matching every other tool in this package. */
function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** A `{ success: false, diagnostics }` tool result payload, matching every write tool in this package's own failure shape. */
interface AddGeneratedClipFailurePayload {
  success: false;
  diagnostics: SceneParseDiagnostic[];
}

/** `add_generated_clip`'s success payload: the submitted job/slot info, the new clip/node/track ids, and the updated (persisted) scene document. */
interface AddGeneratedClipSuccessPayload {
  success: true;
  /** The generation slot id this new node depends on; identical to `videoNodeId` (see `RegisterCadraGenerationClipToolsOptions`'s own doc on why this tool uses the node's own id as its slot id). Pass this to `get_generation_status` to check on it. */
  slotId: string;
  clipId: string;
  videoNodeId: string;
  trackId: string;
  /** The dedup-cache request hash `GenerationStore.submitGeneration` returned for this submission, exposed for callers/tests that want to inspect the underlying cache entry directly (`GenerationStore.getCacheEntry`). */
  requestHash: string;
  document: SceneDocument;
}

/** Zod shape for the generation request `add_generated_clip` accepts, mirroring `@cadra/providers`' own `VideoGenerationRequest` field-for-field. Exported so `./generation-regenerate-tools.ts` can derive its own all-optional `overrides` shape from the exact same field set/descriptions via `.partial()`, rather than hand-duplicating it. */
export const generationRequestShape = {
  prompt: z.string().describe("The text prompt describing the desired video."),
  referenceImageUrls: z
    .array(z.string())
    .optional()
    .describe(
      "Reference image URL(s) for image-to-video generation, where the named provider supports it.",
    ),
  params: z
    .object({
      durationSeconds: z.number().optional().describe("Requested clip duration in seconds."),
      aspectRatio: z
        .string()
        .optional()
        .describe("Requested aspect ratio, as a 'width:height' string (e.g. '16:9')."),
      seed: z
        .number()
        .optional()
        .describe("Seed for reproducible generation, where the named provider supports it."),
    })
    .optional()
    .describe(
      "Normalized generation params; an omitted field falls back to the named provider's own default.",
    ),
};

/** Zod shape for the new video layer's optional blend/mask fields (Phase 36's data-model addition on `VideoNode`). */
const videoLayerOptionsShape = {
  blendMode: z
    .enum(["normal", "add", "multiply", "screen"])
    .optional()
    .describe(
      "How the new video layer's pixels combine with whatever renders beneath it. Defaults to 'normal'.",
    ),
  maskRef: z
    .string()
    .optional()
    .describe(
      "Optional reference to a mask asset restricting which pixels of the new video layer are visible.",
    ),
};

/**
 * Registers `add_generated_clip` on `server`. Submits into
 * `options.store` (a shared `GenerationStore`; see this module's own doc on
 * why it must be the same instance other generation-aware tools/gates read
 * from), and persists the updated scene through the same `scene-store.ts`
 * primitives every other scene-writing tool in this package uses.
 */
export function registerCadraGenerationClipTools(
  server: McpServer,
  config: CadraMcpServerConfig,
  logger: Logger,
  options: RegisterCadraGenerationClipToolsOptions,
): RegisteredTool[] {
  const toolLogger = logger.child("generation-clip-tools");
  const { store } = options;

  const addGeneratedClipTool = server.registerTool(
    ADD_GENERATED_CLIP_TOOL_NAME,
    {
      title: "Add generated clip",
      description:
        "Requests a generative-video job and inserts its (eventual) output as a new clip layer " +
        "on an existing scene's timeline, in one step. Submits the generation immediately (never " +
        "blocking on it finishing), constructs a new VideoNode whose assetRef starts as a " +
        "cadra-generation://<slotId> placeholder, wraps it in a new Clip (with the given " +
        "placement and optional transitionIn), inserts that clip onto the named track (an " +
        "existing one, or a brand-new one), and persists the updated scene. Call " +
        "get_generation_status with the returned slotId to check on the job; once it reports " +
        "ready, the very next status check or render_scene call rewrites this node's assetRef " +
        "to a real cadra-asset:// ref automatically.",
      inputSchema: {
        sceneId: z
          .string()
          .describe(
            "Id of the scene (as persisted by create_scene/update_scene) to add the clip to.",
          ),
        compositionId: z
          .string()
          .describe("Id of the composition, within that scene, to add the clip to."),
        ...trackSelectorShape,
        clipId: z.string().describe("Unique id for the new clip within the project."),
        videoNodeId: z
          .string()
          .describe(
            "Unique id for the new VideoNode within the project. Also used as this generation's " +
              "own slot id (pass it to get_generation_status to check on it).",
          ),
        startFrame: z
          .number()
          .int()
          .min(0)
          .describe("The frame, relative to the start of the composition, the new clip begins on."),
        durationInFrames: z
          .number()
          .int()
          .positive()
          .describe("How many frames the new clip is visible for."),
        providerName: z
          .string()
          .describe(
            "Name of the registered @cadra/providers VideoProvider to submit this generation to.",
          ),
        request: z.object(generationRequestShape).describe("The generation request to submit."),
        transitionIn: transitionSchema
          .optional()
          .describe(
            "Optional transition the new clip blends in with, applied exactly like any hand-authored clip's transitionIn.",
          ),
        ...videoLayerOptionsShape,
      },
    },
    async ({
      sceneId,
      compositionId,
      existingTrackId,
      newTrackId,
      newTrackName,
      clipId,
      videoNodeId,
      startFrame,
      durationInFrames,
      providerName,
      request,
      transitionIn,
      blendMode,
      maskRef,
    }) => {
      const idValidation = sanitizeSceneId(sceneId);
      if (!idValidation.valid) {
        return jsonResult(
          singleDiagnosticFailure("sceneId", idValidation.reason, "INVALID_SCENE_ID"),
        );
      }

      const file = await readSceneFile(config.workspaceRoot, idValidation.sceneId);
      if (file === undefined) {
        return jsonResult(
          singleDiagnosticFailure(
            "sceneId",
            `No scene with id "${idValidation.sceneId}" was found in this workspace.`,
            "SCENE_NOT_FOUND",
            "Call list_scenes to see every scene id currently persisted in this workspace, or " +
              "create_scene to create it first.",
          ),
        );
      }

      const parsed = parseScene(file.raw);
      if (!parsed.success) {
        toolLogger.warn("add_generated_clip found a persisted scene that no longer validates", {
          sceneId: idValidation.sceneId,
          diagnosticCount: parsed.diagnostics.length,
        });
        return jsonResult({
          success: false,
          diagnostics: parsed.diagnostics,
        } satisfies AddGeneratedClipFailurePayload);
      }

      const composition = parsed.document.project.compositions.find((c) => c.id === compositionId);
      if (composition === undefined) {
        const availableIds = parsed.document.project.compositions.map((c) => c.id);
        return jsonResult(
          singleDiagnosticFailure(
            "compositionId",
            `Scene "${idValidation.sceneId}" has no composition with id "${compositionId}". ` +
              `Available composition ids: ${availableIds.length > 0 ? availableIds.join(", ") : "(none)"}.`,
            "COMPOSITION_NOT_FOUND",
          ),
        );
      }

      const trackResolution = resolveTrackSelector(composition, existingTrackId, newTrackId);
      if (!trackResolution.ok) {
        return jsonResult(trackResolution.failure);
      }

      if (projectContainsNodeId(parsed.document.project, videoNodeId)) {
        return jsonResult(
          singleDiagnosticFailure(
            "videoNodeId",
            `A scene node with id "${videoNodeId}" already exists in this project. Choose a different id.`,
            "DUPLICATE_NODE_ID",
          ),
        );
      }

      if (
        parsed.document.project.compositions.some((c) =>
          c.tracks.some((track) => track.clips.some((clip) => clip.id === clipId)),
        )
      ) {
        return jsonResult(
          singleDiagnosticFailure(
            "clipId",
            `A clip with id "${clipId}" already exists in this project. Choose a different id.`,
            "DUPLICATE_CLIP_ID",
          ),
        );
      }

      let requestHash: string;
      try {
        requestHash = await store.submitGeneration(videoNodeId, providerName, {
          prompt: request.prompt,
          ...(request.referenceImageUrls !== undefined
            ? { referenceImageUrls: request.referenceImageUrls }
            : {}),
          params: request.params ?? {},
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toolLogger.warn("add_generated_clip failed to submit the generation", {
          sceneId: idValidation.sceneId,
          providerName,
          message,
        });
        return jsonResult(
          singleDiagnosticFailure("providerName", message, "GENERATION_SUBMIT_FAILED"),
        );
      }

      const videoNode = Video({
        id: videoNodeId,
        assetRef: buildGenerationRef(videoNodeId),
        ...(blendMode !== undefined ? { blendMode } : {}),
        ...(maskRef !== undefined ? { maskRef } : {}),
      });

      const newClip: Clip = {
        id: clipId,
        startFrame,
        durationInFrames,
        node: videoNode,
        ...(transitionIn !== undefined ? { transitionIn } : {}),
      };

      const updatedProject = insertClipOntoTrack(
        parsed.document.project,
        compositionId,
        trackResolution.trackId,
        trackResolution.createNew,
        newTrackName,
        newClip,
      );

      const candidate = { schemaVersion: parsed.document.schemaVersion, project: updatedProject };
      const revalidated = parseScene(candidate);
      if (!revalidated.success) {
        toolLogger.debug("add_generated_clip produced an invalid document", {
          sceneId: idValidation.sceneId,
          diagnosticCount: revalidated.diagnostics.length,
        });
        return jsonResult({
          success: false,
          diagnostics: revalidated.diagnostics,
        } satisfies AddGeneratedClipFailurePayload);
      }

      await writeSceneDocument(config.workspaceRoot, idValidation.sceneId, revalidated.document);
      toolLogger.info("add_generated_clip submitted a generation and inserted its clip", {
        sceneId: idValidation.sceneId,
        compositionId,
        trackId: trackResolution.trackId,
        clipId,
        videoNodeId,
        providerName,
      });

      return jsonResult({
        success: true,
        slotId: videoNodeId,
        clipId,
        videoNodeId,
        trackId: trackResolution.trackId,
        requestHash,
        document: revalidated.document,
      } satisfies AddGeneratedClipSuccessPayload);
    },
  );

  return [addGeneratedClipTool];
}
