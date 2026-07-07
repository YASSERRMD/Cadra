/**
 * Phase 36 task 1: binds a generation job's eventual output onto the one
 * `VideoNode` waiting on it, automatically, the next time something already
 * checks that generation slot's status.
 *
 * Mirrors Phase 30's `cadra-asset://<hash>` scheme (`./asset-store.ts`'s
 * `ASSET_REF_SCHEME`/`buildAssetRef`/`parseAssetRef`) with a new, parallel
 * `cadra-generation://<slotId>` scheme (`GENERATION_REF_SCHEME`/
 * `buildGenerationRef`/`parseGenerationRef`): a freshly-added `VideoNode`'s
 * `assetRef` starts as `cadra-generation://<slotId>`, a placeholder-in-
 * waiting rather than a real asset ref, exactly identifying which
 * `GenerationStore` slot this node depends on with no separate out-of-band
 * tracking table - the scheme is parsed straight out of the one `assetRef`
 * field every `VideoNode` already has.
 *
 * "Binding a generation job output to a clip layer automatically on
 * completion" means: once a slot's status (as observed via
 * `GenerationStore.refresh()` plus `getSlotStatus()`) is `"ready"`, this
 * module ingests that slot's `outputUrl` into the durable, content-addressed
 * asset store (`./asset-store.ts`'s `ingestAssetFromUrl`, the exact same
 * function `upload_asset` itself calls - reused directly, not merely
 * available through that tool's own MCP boundary) to get a real
 * `cadra-asset://<hash>` ref, then rewrites that one `VideoNode`'s
 * `assetRef` field in the persisted scene document from the generation ref
 * to the real asset ref, via `./scene-patch.ts`'s `applyScenePatchOperation`
 * (an `updateNode` patch operation), reusing the same outer `Project`-level
 * navigation `update_scene`'s own "patch" mode already applies, since
 * `@cadra/core`'s `updateNode` itself only knows how to operate on a single
 * clip's node subtree.
 *
 * This codebase deliberately does not build a standing background timer/
 * cron process anywhere (see `GenerationStore.refresh()`'s own "caller-
 * paced" design): "automatically on completion" here means "the very next
 * time something that already naturally checks this slot's status runs,"
 * not that this module invents its own scheduling. See
 * `bindReadyGenerationsForScene`'s own doc for exactly which call sites in
 * this package perform this rewrite as a side effect of work they were
 * already doing.
 */
import type { Project, SceneNode, VideoNode } from "@cadra/core";
import type { GenerationStore } from "@cadra/providers";
import { parseScene, type SceneDocument } from "@cadra/schema";

import { ingestAssetFromUrl } from "./asset-store.js";
import type { Logger } from "./logger.js";
import { applyScenePatchOperation } from "./scene-patch.js";
import { readSceneFile, writeSceneDocument } from "./scene-store.js";

/** The MCP-facing generation-slot ref scheme this module mints and parses: `cadra-generation://<slotId>`, mirroring `./asset-store.ts`'s `ASSET_REF_SCHEME`. */
export const GENERATION_REF_SCHEME = "cadra-generation://";

/** Builds the generation ref string for `slotId`, valid to place directly into a freshly-added `VideoNode`'s `assetRef` field while its backing generation job has not finished yet. */
export function buildGenerationRef(slotId: string): string {
  return `${GENERATION_REF_SCHEME}${slotId}`;
}

/**
 * Parses a generation ref built by {@link buildGenerationRef} back into its
 * slot id, or returns `undefined` if `ref` does not use the
 * `cadra-generation://` scheme this module mints (e.g. it is already a real
 * `cadra-asset://<hash>` ref, or some other opaque string).
 */
export function parseGenerationRef(ref: string): string | undefined {
  if (!ref.startsWith(GENERATION_REF_SCHEME)) {
    return undefined;
  }
  return ref.slice(GENERATION_REF_SCHEME.length);
}

/** One `VideoNode` found somewhere in a `Project`'s clips whose `assetRef` is a `cadra-generation://<slotId>` placeholder, together with enough addressing to rewrite it in place. */
export interface PendingGenerationNode {
  /** The waiting `VideoNode` itself, unchanged. */
  node: VideoNode;
  /** The generation slot id parsed out of `node.assetRef`. */
  slotId: string;
}

/** Recursively collects every `VideoNode` in `node`'s subtree whose `assetRef` parses as a `cadra-generation://<slotId>` ref, in depth-first pre-order. */
function collectPendingGenerationNodes(node: SceneNode): PendingGenerationNode[] {
  const found: PendingGenerationNode[] = [];

  if (node.kind === "video") {
    const slotId = parseGenerationRef(node.assetRef);
    if (slotId !== undefined) {
      found.push({ node, slotId });
    }
  }

  for (const child of node.children) {
    found.push(...collectPendingGenerationNodes(child));
  }

  return found;
}

/**
 * Collects every `VideoNode` anywhere in `project`'s compositions/tracks/
 * clips whose `assetRef` is still a `cadra-generation://<slotId>`
 * placeholder, i.e. every node this project has waiting on a not-yet-bound
 * generation job.
 */
export function findPendingGenerationNodes(project: Project): PendingGenerationNode[] {
  const found: PendingGenerationNode[] = [];
  for (const composition of project.compositions) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        found.push(...collectPendingGenerationNodes(clip.node));
      }
    }
  }
  return found;
}

/** One binding attempt's outcome for a single pending node, as returned by {@link bindReadyGenerations}. */
export type GenerationBindingOutcome =
  | { nodeId: string; slotId: string; outcome: "bound"; assetRef: string }
  | { nodeId: string; slotId: string; outcome: "stillPending" }
  | { nodeId: string; slotId: string; outcome: "failed"; error: string }
  | { nodeId: string; slotId: string; outcome: "ingestError"; error: string };

/**
 * Checks every `VideoNode` in `pendingNodes` against `store`'s *current*
 * (already-{@link GenerationStore.refresh}ed, if the caller wants a live
 * check) slot status, and for every slot that is `"ready"`, ingests its
 * `outputUrl` into the durable asset store (`ingestAssetFromUrl`) and
 * rewrites that node's `assetRef` in `project` from the generation ref to
 * the freshly-ingested `cadra-asset://<hash>` ref.
 *
 * Does not call `store.refresh()` itself: refreshing talks to a vendor (or,
 * in tests, a fake standing in for one) and is a deliberately separate,
 * caller-paced step (see `GenerationStore.refresh`'s own doc); a caller that
 * wants this binding pass to reflect the vendor's very latest status calls
 * `refresh()` immediately before this function, exactly like
 * `getSlotStatus` itself expects.
 *
 * Returns the possibly-updated `project` (structurally-sharing every
 * composition/track/clip/node this pass did not touch, via `updateNode`'s
 * own sharing guarantee) alongside one {@link GenerationBindingOutcome} per
 * pending node, so a caller can log or report exactly what happened to each
 * one. A node whose slot is `"pending"`/`"running"` is left completely
 * untouched (`"stillPending"`); a node whose slot terminally `"failed"` is
 * also left untouched, rather than silently clearing or replacing its
 * placeholder ref (`"failed"`, carrying the vendor's own error, so a caller
 * can surface it - deciding what an agent should do next, e.g. regenerate
 * or give up, is that caller's call, not this function's); a node whose
 * slot is `"ready"` but whose ingest itself throws (e.g. the vendor's
 * `outputUrl` is no longer fetchable) is reported as `"ingestError"`.
 */
export async function bindReadyGenerations(
  project: Project,
  pendingNodes: readonly PendingGenerationNode[],
  store: GenerationStore,
  workspaceRoot: string,
): Promise<{ project: Project; outcomes: GenerationBindingOutcome[] }> {
  let currentProject = project;
  const outcomes: GenerationBindingOutcome[] = [];

  for (const pending of pendingNodes) {
    const resolution = store.getSlotStatus(pending.slotId);

    // Checked as "is this ready" first (rather than excluding pending/failed
    // via `!==`/`||`), since TypeScript's discriminated-union narrowing does
    // not fully eliminate a status literal covered by an `||`-combined
    // equality check the way it does a single positive `===` check; this
    // ordering is what lets `resolution.outputUrl` below narrow to
    // `SlotReady` alone with no cast.
    if (resolution.status !== "ready") {
      if (resolution.status === "failed") {
        outcomes.push({
          nodeId: pending.node.id,
          slotId: pending.slotId,
          outcome: "failed",
          error: resolution.error,
        });
        continue;
      }
      outcomes.push({ nodeId: pending.node.id, slotId: pending.slotId, outcome: "stillPending" });
      continue;
    }

    let assetRef: string;
    try {
      const summary = await ingestAssetFromUrl(workspaceRoot, resolution.outputUrl);
      assetRef = summary.assetRef;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({ nodeId: pending.node.id, slotId: pending.slotId, outcome: "ingestError", error: message });
      continue;
    }

    currentProject = applyScenePatchOperation(currentProject, {
      type: "updateNode",
      nodeId: pending.node.id,
      fields: { assetRef },
    });
    outcomes.push({ nodeId: pending.node.id, slotId: pending.slotId, outcome: "bound", assetRef });
  }

  return { project: currentProject, outcomes };
}

/**
 * Full end-to-end binding pass for one persisted scene: loads `sceneId`'s
 * current document, finds every `VideoNode` still waiting on a generation
 * ref, binds every one whose slot `store` currently reports `"ready"`
 * (`bindReadyGenerations`), and - only if at least one node was actually
 * bound - re-validates and re-persists the updated document.
 *
 * This is the one function every "automatically on completion" call site in
 * this package shares (see this module's own top-level doc for which those
 * are): `get_generation_status` (an agent polling a slot's status) and
 * `render_scene`'s pending-assets gate both call this before doing their
 * own real work, so a scene's generation-backed nodes get rewritten to real
 * asset refs the very next time anything already checks on them, with no
 * separate background process ever needing to exist for it to happen.
 *
 * Returns `undefined` if `sceneId` does not name a persisted scene, or if
 * its persisted document no longer validates (mirroring
 * `scene-tools.ts`'s own "re-validate on every read" discipline); returns
 * `{ document, outcomes: [] }` (a no-op) if the scene has no pending
 * generation-backed nodes at all, which is the common case for most scenes
 * most of the time this runs.
 */
export async function bindReadyGenerationsForScene(
  workspaceRoot: string,
  sceneId: string,
  store: GenerationStore,
  logger?: Logger,
): Promise<{ document: SceneDocument; outcomes: GenerationBindingOutcome[] } | undefined> {
  const file = await readSceneFile(workspaceRoot, sceneId);
  if (file === undefined) {
    return undefined;
  }

  const parsed = parseScene(file.raw);
  if (!parsed.success) {
    logger?.warn("bindReadyGenerationsForScene found a persisted scene that no longer validates", {
      sceneId,
      diagnosticCount: parsed.diagnostics.length,
    });
    return undefined;
  }

  const pendingNodes = findPendingGenerationNodes(parsed.document.project);
  if (pendingNodes.length === 0) {
    return { document: parsed.document, outcomes: [] };
  }

  const { project: updatedProject, outcomes } = await bindReadyGenerations(
    parsed.document.project,
    pendingNodes,
    store,
    workspaceRoot,
  );

  const boundCount = outcomes.filter((outcome) => outcome.outcome === "bound").length;
  if (boundCount === 0) {
    return { document: parsed.document, outcomes };
  }

  const candidate: SceneDocument = {
    schemaVersion: parsed.document.schemaVersion,
    project: updatedProject,
  };
  const revalidated = parseScene(candidate);
  if (!revalidated.success) {
    // Rewriting only a VideoNode.assetRef field to another string cannot by
    // itself invalidate an already-valid document (assetRef is validated as
    // a plain, unconstrained string on every kind that has one), so this
    // should be unreachable in practice; guarded rather than asserted so a
    // future change to that invariant fails loudly here instead of silently
    // persisting an invalid document.
    logger?.error("bindReadyGenerationsForScene produced an invalid document; leaving the scene unchanged", {
      sceneId,
      diagnosticCount: revalidated.diagnostics.length,
    });
    return { document: parsed.document, outcomes };
  }

  await writeSceneDocument(workspaceRoot, sceneId, revalidated.document);
  logger?.info("bindReadyGenerationsForScene bound one or more generation slots to real asset refs", {
    sceneId,
    boundCount,
    totalPending: pendingNodes.length,
  });

  return { document: revalidated.document, outcomes };
}
