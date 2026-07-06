import type { ResolvedLayer, SceneState } from "@cadra/core";

import type { DiffedLayer, DiffedSceneState, UnchangedLayerRef } from "./worker-protocol.js";
import { isUnchangedLayerRef } from "./worker-protocol.js";

/** Builds the cache key `diffSceneStateLayers`/`reconstructSceneState` key layer identity by. */
function layerKey(layer: Pick<ResolvedLayer, "compositionId" | "trackId" | "clipId">): string {
  return `${layer.compositionId}::${layer.trackId}::${layer.clipId}`;
}

/**
 * A layer's identity/content fingerprint as of the last `renderFrame` call,
 * keyed by `compositionId`/`trackId`/`clipId` (not array position): a track
 * being added, removed, or reordered must never cause this diff to compare
 * the wrong two layers against each other purely because they now share an
 * index.
 */
type LastSentLayerCache = Map<string, ResolvedLayer>;

/**
 * Sender-side diff state: the last full `SceneState.layers` this call
 * observed, keyed for lookup by `layerKey`. Opaque to callers; construct via
 * `createSceneStateDiffTracker` and thread the same instance across
 * successive `diffSceneStateLayers` calls for the same worker/renderer.
 */
export interface SceneStateDiffTracker {
  /** @internal exposed only for this module's own reconstruction-side tests to build fixtures against. */
  readonly lastSent: LastSentLayerCache;
}

/** Creates a fresh `SceneStateDiffTracker` with no prior layers recorded. */
export function createSceneStateDiffTracker(): SceneStateDiffTracker {
  return { lastSent: new Map() };
}

/**
 * A layer is "unchanged" (safe to send as a lightweight `UnchangedLayerRef`
 * instead of in full) when its `node` reference, `opacity`, and `localFrame`
 * are all identical (`===`, not deep-equal) to the previous layer recorded
 * under the same `compositionId`/`trackId`/`clipId` key. `node` identity is
 * the dominant cost signal (a scene-node subtree is the only field that can
 * be arbitrarily large), and `opacity`/`localFrame` are cheap scalars that
 * both affect what actually gets drawn, so all three must hold for a layer
 * to be safely treated as a no-op from the worker-host's perspective.
 * `zIndex` is deliberately excluded from this check: it is still forwarded
 * on the `UnchangedLayerRef` itself (see that type's doc) so the
 * worker-host can place a reused layer at its current position even when
 * the *set* of layers is unchanged but their order shifted.
 */
function layersAreEquivalent(previous: ResolvedLayer, next: ResolvedLayer): boolean {
  return (
    previous.node === next.node &&
    previous.opacity === next.opacity &&
    previous.localFrame === next.localFrame
  );
}

/**
 * Diffs `sceneState.layers` against `tracker`'s record of the last
 * `SceneState` sent (for the same tracker instance), replacing every
 * unchanged layer with a lightweight `UnchangedLayerRef` and leaving new or
 * changed layers in full. Updates `tracker` in place to reflect
 * `sceneState` as the new "last sent" baseline for the next call.
 *
 * Positional, not just presence-based: a layer already seen at a *different*
 * key context still authors its own fresh comparison via `layerKey`, so
 * layers that persist across frames (the common case: nothing changed but
 * the composition's own frame ticked forward) are the ones that collapse to
 * references, while genuinely new content (a clip starting, a track added)
 * is always sent in full on the frame it first appears.
 */
export function diffSceneStateLayers(
  sceneState: SceneState,
  tracker: SceneStateDiffTracker,
): DiffedSceneState {
  const diffedLayers: DiffedLayer[] = sceneState.layers.map((layer) => {
    const key = layerKey(layer);
    const previous = tracker.lastSent.get(key);
    if (previous !== undefined && layersAreEquivalent(previous, layer)) {
      const reference: UnchangedLayerRef = {
        compositionId: layer.compositionId,
        trackId: layer.trackId,
        clipId: layer.clipId,
        zIndex: layer.zIndex,
      };
      return reference;
    }
    return layer;
  });

  tracker.lastSent.clear();
  for (const layer of sceneState.layers) {
    tracker.lastSent.set(layerKey(layer), layer);
  }

  return { ...sceneState, layers: diffedLayers };
}

/** Thrown by `reconstructSceneState` when an `UnchangedLayerRef` names a layer the cache has no record of. */
export class UnknownUnchangedLayerError extends Error {
  constructor(key: string) {
    super(
      `Worker-host received an UnchangedLayerRef for "${key}" with no matching layer in its cache.`,
    );
    this.name = "UnknownUnchangedLayerError";
  }
}

/**
 * Worker-host-side reconstruction cache: the last full `ResolvedLayer` seen
 * per `layerKey`, used to resolve `UnchangedLayerRef`s back into real
 * layers. Deliberately the same key scheme as `SceneStateDiffTracker` (by
 * construction, not by coincidence): both sides must agree on layer
 * identity for reconstruction to ever hit the cache.
 */
export interface WorkerLayerCache {
  /** @internal exposed only for this module's own tests to inspect cache contents directly. */
  readonly byKey: LastSentLayerCache;
}

/** Creates a fresh `WorkerLayerCache` with no layers recorded. */
export function createWorkerLayerCache(): WorkerLayerCache {
  return { byKey: new Map() };
}

/**
 * Reconstructs the effective, full `SceneState` a `DiffedSceneState`
 * represents, resolving every `UnchangedLayerRef` against `cache` and
 * updating `cache` in place so subsequent calls can resolve references
 * against *this* call's full layers.
 *
 * Throws `UnknownUnchangedLayerError` if a reference names a layer the
 * cache has never seen a full copy of: this indicates a protocol
 * violation (e.g. the very first `renderFrame` diffed a layer that was
 * never actually sent in full first), not a recoverable runtime state, so
 * it is a thrown error rather than a silently-dropped layer.
 */
export function reconstructSceneState(
  diffed: DiffedSceneState,
  cache: WorkerLayerCache,
): SceneState {
  const layers: ResolvedLayer[] = diffed.layers.map((layer) => {
    if (!isUnchangedLayerRef(layer)) {
      return layer;
    }
    const key = layerKey(layer);
    const cached = cache.byKey.get(key);
    if (cached === undefined) {
      throw new UnknownUnchangedLayerError(key);
    }
    // The reference's own zIndex wins over the cached copy's: stacking
    // order can shift between frames even for a layer whose content did
    // not change (see layersAreEquivalent's doc for why zIndex is excluded
    // from the equivalence check itself).
    return { ...cached, zIndex: layer.zIndex };
  });

  cache.byKey.clear();
  for (const layer of layers) {
    cache.byKey.set(layerKey(layer), layer);
  }

  return { ...diffed, layers };
}
