/**
 * Phase 36 task 5: wires a composition's not-yet-ready generation-backed
 * `VideoNode`s into the existing Phase 18 asset-readiness gate
 * (`@cadra/headless`'s `renderComposition` `getPendingAssets` option,
 * `@cadra/core`'s `waitForAssets`/`Pending`), so a render correctly refuses
 * to proceed against a `cadra-generation://<slotId>` placeholder ref rather
 * than treating it as if it were already a real, resolvable asset.
 *
 * `createGenerationPendingAssets(store)` returns a `GetPendingAssetsFn`
 * (`(frame, sceneState) => Iterable<Pending>`, exactly
 * `RenderCompositionOptions.getPendingAssets`'s own shape): for every
 * `VideoNode` in that frame's resolved `SceneState.layers` whose `assetRef`
 * is still a `cadra-generation://<slotId>` ref (via
 * `./generation-asset-binding.ts`'s `parseGenerationRef`), it contributes one
 * `Pending` whose `ready` promise:
 *
 * - resolves once that slot's status is `"ready"`;
 * - rejects with a descriptive error if the slot's status is `"failed"`
 *   (carrying the vendor's own failure reason) or still
 *   `"pending"`/`"running"`.
 *
 * Rejecting (rather than resolving, or hanging forever) on a still-pending
 * slot is deliberate, not an oversight: `waitForAssets`
 * (`Promise.all(...).ready)`) requires every pending asset to resolve
 * before a render proceeds, and this package's own `GenerationStore` design
 * note is explicit that nothing in this codebase builds a background timer/
 * polling loop (`GenerationStore.refresh()` is caller-paced by design). A
 * `Pending` whose promise simply never settled would violate `Promise.all`'s
 * contract in a much worse way (an indefinitely hung render, with no error
 * to act on); rejecting immediately with a clear "not ready yet, try the
 * render again once generation finishes" message is the correct, honest
 * "gates the render rather than proceeding against a broken/placeholder
 * ref" behavior instead, and matches this codebase's every other "caller
 * retries later" pattern (e.g. `render_scene`/`get_render_status`/
 * `get_render_output`'s own "submit, poll, fetch" shape) rather than
 * inventing new scheduling infrastructure.
 *
 * Before resolving/rejecting any of a frame's pending nodes, this function
 * calls `store.refresh()` exactly once per distinct slot id encountered
 * across the whole render pass (not once per frame that slot's node
 * happens to be visible in, and never again once that slot has reached a
 * terminal `"ready"`/`"failed"` state): refreshing talks to a vendor (a real
 * one in production, a fake one in every test in this codebase), so
 * re-refreshing an already-terminal slot on every subsequent frame would be
 * pure waste for no behavior change.
 */
import type { Pending, SceneNode, SceneState } from "@cadra/core";
import type { GetPendingAssetsFn } from "@cadra/headless";
import type { GenerationStore } from "@cadra/providers";

import { parseGenerationRef } from "./generation-asset-binding.js";

/** Recursively collects every generation slot id referenced by a `cadra-generation://<slotId>` `VideoNode.assetRef` anywhere in `node`'s subtree. */
function collectGenerationSlotIds(node: SceneNode, into: Set<string>): void {
  if (node.kind === "video") {
    const slotId = parseGenerationRef(node.assetRef);
    if (slotId !== undefined) {
      into.add(slotId);
    }
  }
  for (const child of node.children) {
    collectGenerationSlotIds(child, into);
  }
}

/** Every distinct generation slot id referenced anywhere in `sceneState`'s resolved layers. */
function collectSceneStateSlotIds(sceneState: SceneState): Set<string> {
  const slotIds = new Set<string>();
  for (const layer of sceneState.layers) {
    collectGenerationSlotIds(layer.node, slotIds);
  }
  return slotIds;
}

/**
 * Builds a `GetPendingAssetsFn` gating a render behind `store`'s
 * generation-slot readiness, for every `cadra-generation://<slotId>`
 * `VideoNode` a rendered composition's frames reference. See this module's
 * own top-level doc for the full readiness/rejection contract.
 *
 * Pass the result directly as `RenderCompositionOptions.getPendingAssets`
 * (`@cadra/headless`'s `renderComposition`), or compose it with another
 * `GetPendingAssetsFn` (e.g. concatenating both functions' iterables) if a
 * caller already has its own asset-readiness gate for other asset kinds.
 */
export function createGenerationPendingAssets(store: GenerationStore): GetPendingAssetsFn {
  /** Slot ids this function instance has already confirmed reached a terminal ready/failed state; never refreshed again once here. */
  const settledSlotIds = new Set<string>();

  return function getPendingAssets(_frame: number, sceneState: SceneState): Iterable<Pending> {
    const slotIds = collectSceneStateSlotIds(sceneState);
    if (slotIds.size === 0) {
      return [];
    }

    const pending: Pending[] = [];
    for (const slotId of slotIds) {
      pending.push({ ready: resolveSlotReadiness(store, slotId, settledSlotIds) });
    }
    return pending;
  };
}

/**
 * Resolves one slot's readiness for the current frame: refreshes `store`
 * first, unless `slotId` was already observed terminal (`"ready"`/
 * `"failed"`) by an earlier call within this same `createGenerationPendingAssets`
 * instance, then resolves if ready, or rejects (carrying a descriptive
 * message; see this module's own top-level doc for why rejection, not an
 * indefinite hang, is correct here) if failed or still pending/running.
 */
async function resolveSlotReadiness(
  store: GenerationStore,
  slotId: string,
  settledSlotIds: Set<string>,
): Promise<void> {
  if (!settledSlotIds.has(slotId)) {
    await store.refresh();
  }

  const resolution = store.getSlotStatus(slotId);

  if (resolution.status === "ready") {
    settledSlotIds.add(slotId);
    return;
  }

  if (resolution.status === "failed") {
    settledSlotIds.add(slotId);
    throw new Error(
      `Generation slot "${slotId}" failed and cannot back this render: ${resolution.error}`,
    );
  }

  throw new Error(
    `Generation slot "${slotId}" is not ready yet (status: ${resolution.status}). ` +
      "This render references a VideoNode still waiting on a generation job; submit " +
      "the render again once get_generation_status reports it ready.",
  );
}
