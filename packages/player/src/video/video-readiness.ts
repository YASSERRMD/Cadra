import type { AssetKind, SceneNode, SceneState } from "@cadra/core";

/**
 * Names which `AssetKind` `assetRef` refers to, or `undefined` if `assetRef`
 * is not known at all. `@cadra/core`'s scene graph itself has no opinion on
 * this (an `ImageNode.assetRef` is just a string id), so this is always
 * injected: a real host looks it up against whatever asset registry/manifest
 * it already maintains; tests supply a plain fixed map.
 */
export type AssetKindOfFn = (assetRef: string) => AssetKind | undefined;

/** One video-backed `image`-kind node found in a resolved `SceneState`, and the frame it needs. */
export interface VideoBackedFrame {
  /** The video asset this node's content is sampled from. */
  assetRef: string;
  /**
   * The frame `sampleVideoFrame` would need for this node, i.e. the layer's
   * `localFrame`: video sampling is frame-index-driven (see
   * `@cadra/renderer`'s `sampleVideoFrame`), so readiness is always checked
   * against this local frame, never a global one or a wall-clock position.
   */
  frame: number;
}

/**
 * Walks `node` and every descendant, collecting one `VideoBackedFrame` per
 * `image`-kind node whose `assetRef` names a video asset (per `assetKindOf`).
 * An `image` node whose `assetRef` is a static image, or any unrelated node
 * kind, contributes nothing: video content is modeled as an ordinary
 * `ImageNode` whose `assetRef` happens to resolve to a video asset, there is
 * no separate "video" node kind (see `packages/core/src/scene-graph/scene-node.ts`).
 */
function collectVideoBackedNodes(
  node: SceneNode,
  localFrame: number,
  assetKindOf: AssetKindOfFn,
  out: VideoBackedFrame[],
): void {
  if (node.kind === "image" && assetKindOf(node.assetRef) === "video") {
    out.push({ assetRef: node.assetRef, frame: localFrame });
  }
  for (const child of node.children) {
    collectVideoBackedNodes(child, localFrame, assetKindOf, out);
  }
}

/**
 * Every video-backed `(assetRef, frame)` pair referenced anywhere in
 * `sceneState`'s layers, walking each layer's `node` subtree since a layer's
 * root can itself have children (see `ResolvedLayer.node`'s own doc).
 *
 * Each layer's own `localFrame` (not `sceneState.frame`) is the frame stamped
 * onto every `VideoBackedFrame` found within it: `localFrame` is what a
 * clip-local video asset is actually sampled at (see `sampleVideoFrame`),
 * which for a trimmed/offset clip differs from the composition's global
 * frame.
 */
export function findVideoBackedFrames(
  sceneState: SceneState,
  assetKindOf: AssetKindOfFn,
): VideoBackedFrame[] {
  const out: VideoBackedFrame[] = [];
  for (const layer of sceneState.layers) {
    collectVideoBackedNodes(layer.node, layer.localFrame, assetKindOf, out);
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
