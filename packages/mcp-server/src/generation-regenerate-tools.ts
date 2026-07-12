/**
 * `regenerate_clip`: the MCP tool an agent calls to request a fresh
 * generation for a `VideoNode` `add_generated_clip` previously created,
 * when the first (or a later) attempt's result isn't what was wanted.
 *
 * `@cadra/providers`' own `GenerationStore.regenerateSlot` already does the
 * hard part (computes a fresh request from the slot's current one -
 * defaulting to a freshly randomized seed, or exactly whatever `overrides`
 * the caller supplies - and submits it under a new, independent dedup-cache
 * entry; see that module's own doc). Before this tool, that method was only
 * reachable by an `@cadra/agent-sdk` caller holding the store instance
 * directly - an MCP-connected agent has no store handle at all, only
 * registered tools, and neither `get_generation_status` (read-only) nor
 * `add_generated_clip` (rejects a duplicate `videoNodeId`, so it cannot be
 * reused to request a redo of an existing slot) reaches `regenerateSlot`
 * either. Without this tool, an agent's only option for "this generated
 * clip doesn't look right" was starting an entirely new slot/node/clip,
 * abandoning the original's placement/transitionIn/blendMode/maskRef.
 *
 * Beyond calling `regenerateSlot`, this tool also rewrites the named
 * `VideoNode`'s own `assetRef` in the persisted scene document back to its
 * `cadra-generation://<slotId>` placeholder ref (`./generation-asset-
 * binding.ts`'s `buildGenerationRef`), exactly like `add_generated_clip`
 * sets it initially. This is not optional bookkeeping: `./generation-
 * asset-binding.ts`'s own `findPendingGenerationNodes` (the scan
 * `get_generation_status`'s `sceneId` binding pass and `render_scene`'s
 * pending-assets gate both rely on) only ever looks at nodes whose
 * `assetRef` still parses as a generation ref. A node regenerated without
 * this rewrite would keep pointing at its *previous* (already-bound, real
 * `cadra-asset://`) ref indefinitely - the new job would run to completion
 * in the store but never be discovered or bound onto the scene at all.
 */
import type { Project, VideoNode } from "@cadra/core";
import { findNode } from "@cadra/core";
import { type GenerationStore, UnknownSlotError } from "@cadra/providers";
import { parseScene, type SceneDocument, type SceneParseDiagnostic } from "@cadra/schema";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CadraMcpServerConfig } from "./config.js";
import { buildGenerationRef } from "./generation-asset-binding.js";
import { generationRequestShape } from "./generation-clip-tools.js";
import type { Logger } from "./logger.js";
import { applyScenePatchOperation } from "./scene-patch.js";
import { readSceneFile, sanitizeSceneId, writeSceneDocument } from "./scene-store.js";
import { singleDiagnosticFailure } from "./track-insertion.js";

/** Registered tool name for regenerating an existing generation slot. */
export const REGENERATE_CLIP_TOOL_NAME = "regenerate_clip";

/** Options accepted by {@link registerCadraGenerationRegenerateTools}. */
export interface RegisterCadraGenerationRegenerateToolsOptions {
  /**
   * The {@link GenerationStore} `regenerate_clip` regenerates against. Must
   * be the *same* store instance `add_generated_clip`/`get_generation_status`
   * use (see those modules' own doc on why); `./server.ts` constructs one
   * shared store and passes it to all of them.
   */
  store: GenerationStore;
}

/** Wraps a JSON-serializable payload as a single-text-block MCP tool result, matching every other tool in this package. */
function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** A `{ success: false, diagnostics }` tool result payload, matching every write tool in this package's own failure shape. */
interface RegenerateClipFailurePayload {
  success: false;
  diagnostics: SceneParseDiagnostic[];
}

/** `regenerate_clip`'s success payload: the slot/node id (pass to `get_generation_status` to check on it), the new dedup-cache request hash, and the updated (persisted) scene document. */
interface RegenerateClipSuccessPayload {
  success: true;
  slotId: string;
  videoNodeId: string;
  requestHash: string;
  document: SceneDocument;
}

/**
 * Registers `regenerate_clip` on `server`. Regenerates against
 * `options.store` and persists through the same `scene-store.ts` primitives
 * every other scene-writing tool in this package uses.
 */
export function registerCadraGenerationRegenerateTools(
  server: McpServer,
  config: CadraMcpServerConfig,
  logger: Logger,
  options: RegisterCadraGenerationRegenerateToolsOptions,
): RegisteredTool[] {
  const toolLogger = logger.child("generation-regenerate-tools");
  const { store } = options;

  const regenerateClipTool = server.registerTool(
    REGENERATE_CLIP_TOOL_NAME,
    {
      title: "Regenerate clip",
      description:
        "Requests a fresh generation for a VideoNode add_generated_clip previously created, when " +
        "the current result isn't what was wanted. Computes a new request from the slot's current " +
        "one (a freshly randomized seed by default, or exactly whatever overrides are given), " +
        "submits it as a new, independent job (never reusing or discarding the previous result - " +
        "it stays available until the new one supersedes it), and rewrites the node's assetRef " +
        "back to a cadra-generation:// placeholder so the next get_generation_status/render_scene " +
        "call binds the new result onto it automatically once ready. The clip's own placement " +
        "(startFrame/durationInFrames/transitionIn) and the node's blendMode/maskRef are untouched.",
      inputSchema: {
        sceneId: z
          .string()
          .describe("Id of the scene (as persisted by create_scene/update_scene) the VideoNode belongs to."),
        videoNodeId: z
          .string()
          .describe(
            "Id of the existing VideoNode to regenerate - the same id add_generated_clip's own " +
              "videoNodeId returned, also this generation's slot id.",
          ),
        overrides: z
          .object(generationRequestShape)
          .partial()
          .optional()
          .describe(
            "Optional overrides for the regenerated request. An omitted field keeps the previous " +
              "request's own value (params fields merge individually, not wholesale-replace). " +
              "Omitting overrides entirely regenerates with a freshly randomized seed and every " +
              "other field unchanged from the previous request.",
          ),
      },
    },
    async ({ sceneId, videoNodeId, overrides }) => {
      const idValidation = sanitizeSceneId(sceneId);
      if (!idValidation.valid) {
        return jsonResult(singleDiagnosticFailure("sceneId", idValidation.reason, "INVALID_SCENE_ID"));
      }

      const file = await readSceneFile(config.workspaceRoot, idValidation.sceneId);
      if (file === undefined) {
        return jsonResult(
          singleDiagnosticFailure(
            "sceneId",
            `No scene with id "${idValidation.sceneId}" was found in this workspace.`,
            "SCENE_NOT_FOUND",
            "Call list_scenes to see every scene id currently persisted in this workspace.",
          ),
        );
      }

      const parsed = parseScene(file.raw);
      if (!parsed.success) {
        toolLogger.warn("regenerate_clip found a persisted scene that no longer validates", {
          sceneId: idValidation.sceneId,
          diagnosticCount: parsed.diagnostics.length,
        });
        return jsonResult({
          success: false,
          diagnostics: parsed.diagnostics,
        } satisfies RegenerateClipFailurePayload);
      }

      const node = findVideoNodeById(parsed.document.project.compositions, videoNodeId);
      if (node === "notFound") {
        return jsonResult(
          singleDiagnosticFailure(
            "videoNodeId",
            `No scene node with id "${videoNodeId}" was found in scene "${idValidation.sceneId}".`,
            "NODE_NOT_FOUND",
            "Call describe_scene to see every node id currently in this scene.",
          ),
        );
      }
      if (node === "wrongKind") {
        return jsonResult(
          singleDiagnosticFailure(
            "videoNodeId",
            `Scene node "${videoNodeId}" is not a "video" node. regenerate_clip only regenerates VideoNodes.`,
            "NOT_A_VIDEO_NODE",
          ),
        );
      }

      let requestHash: string;
      try {
        requestHash = await store.regenerateSlot(videoNodeId, overrides);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toolLogger.warn("regenerate_clip failed to regenerate the slot", {
          sceneId: idValidation.sceneId,
          videoNodeId,
          message,
        });
        return jsonResult(
          singleDiagnosticFailure(
            "videoNodeId",
            message,
            error instanceof UnknownSlotError ? "UNKNOWN_SLOT" : "REGENERATION_FAILED",
          ),
        );
      }

      const updatedProject = applyScenePatchOperation(parsed.document.project, {
        type: "updateNode",
        nodeId: videoNodeId,
        fields: { assetRef: buildGenerationRef(videoNodeId) },
      });

      const candidate: SceneDocument = { schemaVersion: parsed.document.schemaVersion, project: updatedProject };
      const revalidated = parseScene(candidate);
      if (!revalidated.success) {
        // Rewriting only a VideoNode.assetRef field to another string
        // cannot by itself invalidate an already-valid document (assetRef
        // is validated as a plain, unconstrained string on every kind that
        // has one), so this should be unreachable in practice; guarded
        // rather than asserted so a future change to that invariant fails
        // loudly here instead of silently persisting an invalid document,
        // mirroring bindReadyGenerationsForScene's own identical guard.
        toolLogger.error("regenerate_clip produced an invalid document; leaving the scene unchanged", {
          sceneId: idValidation.sceneId,
          videoNodeId,
          diagnosticCount: revalidated.diagnostics.length,
        });
        return jsonResult({
          success: false,
          diagnostics: revalidated.diagnostics,
        } satisfies RegenerateClipFailurePayload);
      }

      await writeSceneDocument(config.workspaceRoot, idValidation.sceneId, revalidated.document);
      toolLogger.info("regenerate_clip resubmitted a generation and reset the node's assetRef", {
        sceneId: idValidation.sceneId,
        videoNodeId,
        requestHash,
      });

      return jsonResult({
        success: true,
        slotId: videoNodeId,
        videoNodeId,
        requestHash,
        document: revalidated.document,
      } satisfies RegenerateClipSuccessPayload);
    },
  );

  return [regenerateClipTool];
}

/**
 * Locates the `VideoNode` with id `nodeId` anywhere in `compositions`'
 * clips, distinguishing "no node with this id exists at all" from "a node
 * with this id exists but isn't a video node" - `regenerate_clip`'s own
 * handler reports these as two different diagnostics (`NODE_NOT_FOUND` vs
 * `NOT_A_VIDEO_NODE`) rather than collapsing them into one generic
 * not-found error.
 */
function findVideoNodeById(
  compositions: Project["compositions"],
  nodeId: string,
): VideoNode | "notFound" | "wrongKind" {
  for (const composition of compositions) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        const found = findNode(clip.node, nodeId);
        if (found !== undefined) {
          return found.kind === "video" ? found : "wrongKind";
        }
      }
    }
  }
  return "notFound";
}
