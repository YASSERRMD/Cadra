/**
 * Phase 72 task 3: `apply_look_preset`, the one-step MCP tool that applies a
 * named `LookPreset` (`@cadra/core`'s `applyLookPreset`) - a lighting rig,
 * post-processing stack, color grade, and image-based-lighting environment,
 * bundled together - onto an existing composition, so an agent can request
 * a cinematic look in one call instead of hand-assembling lights and
 * effects field by field.
 *
 * Mirrors `add_generated_clip`'s own "read, validate, mutate the in-memory
 * Project, re-validate, persist" shape (`./generation-clip-tools.ts`), just
 * without any track-insertion selector of its own: `applyLookPreset` always
 * adds its own fresh tracks (one per preset light).
 */
import { applyLookPreset, createIdGenerator, LOOK_PRESETS, UnknownLookPresetError } from "@cadra/core";
import { parseScene, type SceneDocument } from "@cadra/schema";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CadraMcpServerConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { readSceneFile, sanitizeSceneId, writeSceneDocument } from "./scene-store.js";
import { singleDiagnosticFailure, type TrackInsertionFailurePayload } from "./track-insertion.js";

/** Registered tool name for the look-preset application tool. */
export const APPLY_LOOK_PRESET_TOOL_NAME = "apply_look_preset";

/** `apply_look_preset`'s success payload: the updated (persisted) scene document. */
interface ApplyLookPresetSuccessPayload {
  success: true;
  /** `presetName`'s own light node ids, in `LOOK_PRESETS[presetName].lights` order, so a caller can address them individually afterward (e.g. to tweak one light's own intensity via `update_scene`). */
  lightNodeIds: string[];
  document: SceneDocument;
}

/** Wraps a JSON-serializable payload as a single-text-block MCP tool result, matching every other tool in this package. */
function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * Registers `apply_look_preset` on `server`, persisting through the same
 * `scene-store.ts` primitives every other scene-writing tool in this
 * package uses.
 */
export function registerCadraLookPresetTools(
  server: McpServer,
  config: CadraMcpServerConfig,
  logger: Logger,
): RegisteredTool {
  const toolLogger = logger.child("look-preset-tools");
  const presetNames = Object.keys(LOOK_PRESETS);

  return server.registerTool(
    APPLY_LOOK_PRESET_TOOL_NAME,
    {
      title: "Apply look preset",
      description:
        "Applies a named look preset (a lighting rig, post-processing stack, color grade, and " +
        "image-based-lighting environment, bundled together) onto an existing composition, in " +
        "one step. Adds one new track per preset light (spanning the composition's full " +
        "duration); overwrites the composition's own postProcessing/colorGrading/environment " +
        `with whichever of those the preset defines. Known presets: ${presetNames.join(", ")}.`,
      inputSchema: {
        sceneId: z.string().describe("Id of the persisted scene to apply the preset to."),
        compositionId: z.string().describe("Id of the composition, within that scene, to apply the preset to."),
        presetName: z
          .enum(presetNames as [string, ...string[]])
          .describe("Which look preset to apply."),
        idSeed: z
          .string()
          .optional()
          .describe(
            "Seed for the new tracks'/lights' own generated ids (this codebase's own deterministic " +
              "id source: the same seed always produces the same ids). Defaults to " +
              "`${sceneId}:${compositionId}:${presetName}`, so a plain repeated call is already " +
              "reproducible without needing to pass this explicitly.",
          ),
      },
    },
    async ({ sceneId, compositionId, presetName, idSeed }) => {
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
            "Call list_scenes to see every scene id currently persisted in this workspace, or " +
              "create_scene to create it first.",
          ),
        );
      }

      const parsed = parseScene(file.raw);
      if (!parsed.success) {
        toolLogger.warn("apply_look_preset found a persisted scene that no longer validates", {
          sceneId: idValidation.sceneId,
          diagnosticCount: parsed.diagnostics.length,
        });
        return jsonResult({
          success: false,
          diagnostics: parsed.diagnostics,
        } satisfies TrackInsertionFailurePayload);
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

      const generateId = createIdGenerator(idSeed ?? `${idValidation.sceneId}:${compositionId}:${presetName}`);

      let updatedComposition;
      try {
        updatedComposition = applyLookPreset(composition, presetName, generateId);
      } catch (error) {
        if (error instanceof UnknownLookPresetError) {
          return jsonResult(
            singleDiagnosticFailure("presetName", error.message, "UNKNOWN_LOOK_PRESET"),
          );
        }
        throw error;
      }

      const lightNodeIds = updatedComposition.tracks
        .slice(composition.tracks.length)
        .map((track) => track.clips[0]?.node.id)
        .filter((id): id is string => id !== undefined);

      const updatedProject = {
        ...parsed.document.project,
        compositions: parsed.document.project.compositions.map((c) =>
          c.id === compositionId ? updatedComposition : c,
        ),
      };

      const candidate = { schemaVersion: parsed.document.schemaVersion, project: updatedProject };
      const revalidated = parseScene(candidate);
      if (!revalidated.success) {
        toolLogger.debug("apply_look_preset produced an invalid document", {
          sceneId: idValidation.sceneId,
          diagnosticCount: revalidated.diagnostics.length,
        });
        return jsonResult({
          success: false,
          diagnostics: revalidated.diagnostics,
        } satisfies TrackInsertionFailurePayload);
      }

      await writeSceneDocument(config.workspaceRoot, idValidation.sceneId, revalidated.document);
      toolLogger.info("apply_look_preset applied a preset", {
        sceneId: idValidation.sceneId,
        compositionId,
        presetName,
        lightNodeIds,
      });

      return jsonResult({
        success: true,
        lightNodeIds,
        document: revalidated.document,
      } satisfies ApplyLookPresetSuccessPayload);
    },
  );
}
