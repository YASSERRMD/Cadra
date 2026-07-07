/**
 * `repair_scene`: applies every safe `suggestedPatch` a scene document's
 * current diagnostics carry, re-validates the result, and persists it only if
 * the repaired document now actually passes `parseScene`.
 *
 * "Safe" here means exactly, and only: `@cadra/schema`'s `parseScene` itself
 * already decided a given diagnostic's fix was unambiguous enough to carry a
 * `suggestedPatch` (see `deriveSuggestedPatch` in that package's `parse.ts`
 * for exactly which error classes qualify - a missing numeric field with a
 * conservative known-safe default, an out-of-range number clamped to its
 * nearest bound, an unrecognized field removed outright, a padded-but-real
 * asset ref trimmed - and why every other diagnostic, notably an unknown node
 * `kind`, deliberately carries no patch at all rather than a guess). This
 * tool applies exactly those patches, verbatim, in the order `parseScene`
 * returned them, and nothing else: it never invents a fix of its own, and it
 * never persists a result unless re-running `parseScene` on the patched
 * document actually succeeds. A diagnostic with no `suggestedPatch` is left
 * alone and reported back in `remainingDiagnostics`, whether or not the other
 * patches this call did apply were enough to make the document valid.
 */
import { applyPatchAtPath, parseScene, type SceneDocument, type SceneParseDiagnostic } from "@cadra/schema";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Logger } from "./logger.js";
import { readSceneFile, sanitizeSceneId, writeSceneDocument } from "./scene-store.js";

/** Registered tool name for repairing a persisted scene document in place. */
export const REPAIR_SCENE_TOOL_NAME = "repair_scene";

/** One `suggestedPatch` this call actually applied, echoed back so a caller can see exactly what changed. */
interface AppliedPatch {
  path: string;
  op: "replace" | "add" | "remove";
}

/** Result payload `repair_scene` always returns, whether or not the document ended up fully valid. */
interface RepairSceneResult {
  /** True only if the document persisted (or handed back, when no `sceneId` write applies) now passes `parseScene`. */
  success: boolean;
  /** True if at least one patch was applied, regardless of whether the result is now fully valid. */
  repaired: boolean;
  /** Every `suggestedPatch` this call actually applied, in application order. */
  patchesApplied: AppliedPatch[];
  /** Every diagnostic still present after applying `patchesApplied` (an empty array means the document is now fully valid). */
  remainingDiagnostics: SceneParseDiagnostic[];
  /** The repaired document, present whenever `success` is true. */
  document?: SceneDocument;
}

/** Wraps a JSON-serializable payload as a single-text-block MCP tool result, matching every other tool in this package. */
function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * Applies every diagnostic in `diagnostics` that carries a `suggestedPatch`,
 * against `value`, in order. A patch that fails to apply (e.g. because an
 * earlier patch in this same batch already changed the exact location a
 * later one targets, so its path no longer resolves the way it did when
 * `parseScene` first computed it) is skipped rather than allowed to throw and
 * abort every other patch in the batch; its diagnostic simply remains
 * unresolved, exactly as if it had never carried a `suggestedPatch` at all.
 */
function applySuggestedPatches(
  value: unknown,
  diagnostics: readonly SceneParseDiagnostic[],
): { patched: unknown; applied: AppliedPatch[] } {
  let patched = value;
  const applied: AppliedPatch[] = [];

  for (const diagnostic of diagnostics) {
    const patch = diagnostic.suggestedPatch;
    if (patch === undefined) {
      continue;
    }
    try {
      patched = applyPatchAtPath(patched, patch.path, patch.op, patch.value);
      applied.push({ path: patch.path, op: patch.op });
    } catch {
      // This specific patch no longer applies cleanly (see this function's
      // own doc); leave it unapplied and continue with the rest of the
      // batch rather than losing every other safe fix over one bad one.
    }
  }

  return { patched, applied };
}

/**
 * Registers `repair_scene` on `server`: given the id of a scene already
 * persisted in `config.workspaceRoot` (via `create_scene`/`update_scene`),
 * reads its raw file contents (which may or may not currently pass
 * `parseScene`), applies every safe `suggestedPatch` its diagnostics carry,
 * and persists the result in place only if it now actually validates.
 *
 * A scene that already validates (no diagnostics at all) returns
 * immediately with `repaired: false` and the unchanged document, without
 * rewriting the file. A scene with diagnostics but no `suggestedPatch` on any
 * of them (or one for which the applicable patches were not enough to reach
 * a fully valid document) is never persisted or reported as `success`; its
 * `remainingDiagnostics` tells the caller exactly what still needs a manual
 * fix (e.g. via `update_scene`).
 */
export function registerCadraRepairSceneTool(
  server: McpServer,
  workspaceRoot: string,
  logger: Logger,
): RegisteredTool {
  const toolLogger = logger.child("repair-scene-tools");

  return server.registerTool(
    REPAIR_SCENE_TOOL_NAME,
    {
      title: "Repair scene",
      description:
        "Applies every safe, automatically-derivable fix (suggestedPatch) a persisted scene " +
        "document's current validation diagnostics carry, then re-validates the result. Only " +
        "persists the repaired document if it now actually passes validation; a diagnostic with " +
        "no safe automatic fix (e.g. an unknown node kind) is left for a human or agent to " +
        "resolve manually via update_scene, and is reported back in remainingDiagnostics either " +
        "way.",
      inputSchema: {
        sceneId: z.string().describe("Id of the persisted scene to repair."),
      },
    },
    async ({ sceneId }) => {
      const idValidation = sanitizeSceneId(sceneId);
      if (!idValidation.valid) {
        return jsonResult({
          success: false,
          repaired: false,
          patchesApplied: [],
          remainingDiagnostics: [{ path: "sceneId", message: idValidation.reason, code: "INVALID_SCENE_ID" }],
        } satisfies RepairSceneResult);
      }

      const file = await readSceneFile(workspaceRoot, idValidation.sceneId);
      if (file === undefined) {
        return jsonResult({
          success: false,
          repaired: false,
          patchesApplied: [],
          remainingDiagnostics: [
            {
              path: "sceneId",
              message: `No scene with id "${idValidation.sceneId}" was found in this workspace.`,
              code: "SCENE_NOT_FOUND",
            },
          ],
        } satisfies RepairSceneResult);
      }

      const initialParse = parseScene(file.raw);
      if (initialParse.success) {
        toolLogger.debug("repair_scene found nothing to repair", { sceneId: idValidation.sceneId });
        return jsonResult({
          success: true,
          repaired: false,
          patchesApplied: [],
          remainingDiagnostics: [],
          document: initialParse.document,
        } satisfies RepairSceneResult);
      }

      const { patched, applied } = applySuggestedPatches(file.raw, initialParse.diagnostics);

      if (applied.length === 0) {
        toolLogger.debug("repair_scene found no safe patches to apply", {
          sceneId: idValidation.sceneId,
          diagnosticCount: initialParse.diagnostics.length,
        });
        return jsonResult({
          success: false,
          repaired: false,
          patchesApplied: [],
          remainingDiagnostics: initialParse.diagnostics,
        } satisfies RepairSceneResult);
      }

      const repairedParse = parseScene(patched);
      if (!repairedParse.success) {
        toolLogger.debug("repair_scene's applied patches were not enough to reach a valid document", {
          sceneId: idValidation.sceneId,
          patchesApplied: applied.length,
          remainingDiagnosticCount: repairedParse.diagnostics.length,
        });
        return jsonResult({
          success: false,
          repaired: true,
          patchesApplied: applied,
          remainingDiagnostics: repairedParse.diagnostics,
        } satisfies RepairSceneResult);
      }

      await writeSceneDocument(workspaceRoot, idValidation.sceneId, repairedParse.document);
      toolLogger.info("repair_scene persisted a repaired scene document", {
        sceneId: idValidation.sceneId,
        patchesApplied: applied.length,
      });
      return jsonResult({
        success: true,
        repaired: true,
        patchesApplied: applied,
        remainingDiagnostics: [],
        document: repairedParse.document,
      } satisfies RepairSceneResult);
    },
  );
}
