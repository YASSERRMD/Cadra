import type { AssetKind, SceneNode, SceneState } from "@cadra/core";
import { resolveVideoSourceFrame } from "@cadra/core";

/**
 * Names which `AssetKind` `assetRef` refers to, or `undefined` if `assetRef`
 * is not known at all. `@cadra/core`'s scene graph itself has no opinion on
 * this for an `ImageNode` (its own `assetRef` is just a string id, possibly
 * naming a video asset - see `collectVideoBackedNodes`'s own doc), so this is
 * always injected: a real host looks it up against whatever asset registry/
 * manifest it already maintains; tests supply a plain fixed map. A
 * `VideoNode`'s own `assetRef` needs no such lookup at all (its node kind
 * alone already means "video", unambiguously).
 */
export type AssetKindOfFn = (assetRef: string) => AssetKind | undefined;

/** One video-backed node found in a resolved `SceneState`, and the exact source frame it needs. */
export interface VideoBackedFrame {
  /** The video asset this node's content is sampled from. */
  assetRef: string;
  /**
   * The source-video-local frame `sampleVideoFrame` would need for this
   * node (video sampling is frame-index-driven, see `@cadra/renderer`'s
   * `sampleVideoFrame`) - see `collectVideoBackedNodes`'s own doc for
   * exactly how this is computed per node kind, since a `VideoNode`'s own
   * trim/speed fields make it a different computation than a legacy
   * video-backed `ImageNode`'s.
   */
  frame: number;
}

/**
 * Walks `node` and every descendant, collecting one `VideoBackedFrame` for:
 *
 * - Every `video`-kind node (`VideoNode`): its own source frame, via
 *   `resolveVideoSourceFrame({inFrame, outFrame, playbackRate,
 *   outOfRangeBehavior}, compositionFrame)` - the exact same computation
 *   `@cadra/renderer`'s own `computeVideoFrameRenderKey` uses to decide what
 *   the real renderer will actually sample, so this readiness check primes/
 *   tests the identical `(assetRef, sourceFrame)` pair the renderer will
 *   look up. Deliberately keyed on `compositionFrame` (the composition-
 *   absolute frame), not `localFrame`: verified against the real reconciler
 *   (`node-factory.ts`'s `applyVideoNodeProperties`, and every other
 *   `Property<T>` resolution alongside it, e.g. `resolveNumberProperty(node.opacity,
 *   frame)`) that nothing upstream rebases a node's own per-frame
 *   resolution to be clip-local before the reconciler sees it (see
 *   `@cadra/renderer`'s `three-renderer.ts`'s own `buildSceneStateRoot`,
 *   which discards `ResolvedLayer.localFrame` entirely) - using `localFrame`
 *   here instead would compute readiness for the wrong source frame for any
 *   clip not starting at the composition's own frame 0.
 * - Every `image`-kind node whose `assetRef` names a video asset (per
 *   `assetKindOf`): `localFrame` directly, unchanged from this function's
 *   own original behavior. `ImageNode` has no `inFrame`/`outFrame`/
 *   `playbackRate` fields of its own to remap with (see its own doc in
 *   `packages/core/src/scene-graph/scene-node.ts`), so a raw 1:1
 *   `localFrame` passthrough remains the only sensible interpretation for
 *   this legacy path - `VideoNode` (added after this path was written) is
 *   now the sanctioned way to place video content with real trim/speed/loop
 *   semantics; this case is kept for whatever, if anything, still
 *   constructs an `ImageNode` this way.
 *
 * Any other node kind (or an `image` node whose `assetRef` is a static
 * image) contributes nothing.
 */
function collectVideoBackedNodes(
  node: SceneNode,
  localFrame: number,
  compositionFrame: number,
  assetKindOf: AssetKindOfFn,
  out: VideoBackedFrame[],
): void {
  if (node.kind === "video") {
    const sourceFrame = resolveVideoSourceFrame(
      {
        inFrame: node.inFrame,
        outFrame: node.outFrame,
        playbackRate: node.playbackRate,
        outOfRangeBehavior: node.outOfRangeBehavior,
      },
      compositionFrame,
    );
    out.push({ assetRef: node.assetRef, frame: sourceFrame });
  }
  if (node.kind === "image" && assetKindOf(node.assetRef) === "video") {
    out.push({ assetRef: node.assetRef, frame: localFrame });
  }
  for (const child of node.children) {
    collectVideoBackedNodes(child, localFrame, compositionFrame, assetKindOf, out);
  }
}

/**
 * Every video-backed `(assetRef, frame)` pair referenced anywhere in
 * `sceneState`'s layers, walking each layer's `node` subtree since a layer's
 * root can itself have children (see `ResolvedLayer.node`'s own doc). See
 * `collectVideoBackedNodes`'s own doc for exactly which frame value each
 * node kind's own entry is keyed by - it is not uniformly `sceneState.frame`
 * nor uniformly each layer's own `localFrame`, since a `VideoNode` and a
 * legacy video-backed `ImageNode` need genuinely different computations.
 */
export function findVideoBackedFrames(
  sceneState: SceneState,
  assetKindOf: AssetKindOfFn,
): VideoBackedFrame[] {
  const out: VideoBackedFrame[] = [];
  for (const layer of sceneState.layers) {
    collectVideoBackedNodes(layer.node, layer.localFrame, sceneState.frame, assetKindOf, out);
  }
  return out;
}

/** Composite key for the readiness cache: distinct assets never collide, and distinct frames of the same asset never collide. */
function cacheKey(assetRef: string, frame: number): string {
  return `${assetRef}:${frame}`;
}

/**
 * In-memory record of which `(assetRef, frame)` pairs have already been
 * decoded/cached, checked synchronously: this is what lets video readiness
 * act as `Transport`'s synchronous `IsFrameReadyFn` (see that type's own doc
 * for why synchronous, not a `Promise`, is the right shape here).
 *
 * A real sampler (or a test fake) is the only thing that ever calls
 * `markReady`; this cache itself never decodes anything, it only remembers
 * what already has been.
 */
export interface VideoReadinessCache {
  /** Whether `assetRef`'s `frame` has already been decoded/cached. */
  isReady(assetRef: string, frame: number): boolean;
  /** Records that `assetRef`'s `frame` has finished decoding. */
  markReady(assetRef: string, frame: number): void;
}

/** Creates an empty, `Map`-backed `VideoReadinessCache`. */
export function createVideoReadinessCache(): VideoReadinessCache {
  const readyKeys = new Set<string>();
  return {
    isReady(assetRef, frame) {
      return readyKeys.has(cacheKey(assetRef, frame));
    },
    markReady(assetRef, frame) {
      readyKeys.add(cacheKey(assetRef, frame));
    },
  };
}

/**
 * Reports whether every video-backed node in `sceneState` is ready per
 * `cache`: a scene with no video-backed content at all is vacuously ready
 * (matching `IsFrameReadyFn`'s "always ready" default for a scene with no
 * asset-readiness concerns), and a scene with any not-yet-cached video frame
 * is not ready.
 */
export function isSceneStateVideoReady(
  sceneState: SceneState,
  cache: VideoReadinessCache,
  assetKindOf: AssetKindOfFn,
): boolean {
  return findVideoBackedFrames(sceneState, assetKindOf).every(({ assetRef, frame }) =>
    cache.isReady(assetRef, frame),
  );
}
