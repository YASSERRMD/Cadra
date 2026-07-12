import { resolveVideoSourceFrame, type VideoNode } from "@cadra/core";

/** Everything the reconciler needs to place one `VideoNode`'s already-decoded current-frame pixels: just the pixels themselves, the same "resolve-only" shape `TextRenderRegistry`/`SatoriLayerRenderRegistry` already establish. */
export interface VideoFrameRenderEntry {
  /** The decoded frame, ready for `createImageTexture` to wrap - reusing the exact same wrap this reconciler already uses for a resolved `ImageNode`. */
  image: ImageBitmap;
}

/**
 * Resolves a `VideoNode` (at a specific frame) to its already-decoded
 * current-frame `VideoFrameRenderEntry`. Resolve-only, mirroring
 * `SatoriLayerRenderRegistry`'s own contract exactly: something else
 * (a browser-side preparation step, since decoding an arbitrary uploaded
 * video format needs a real browser's own decoder - no Node-only
 * equivalent exists the way `pngjs` covers PNG for images) samples and
 * registers entries ahead of a `reconcile` call, the same "not yet ready
 * is an expected runtime state, not a programming error" shape every
 * other registry-resolved node kind in this codebase already has.
 */
export interface VideoFrameRegistry {
  resolve(cacheKey: string): VideoFrameRenderEntry | undefined;
}

/** A `VideoFrameRegistry` a caller can also populate. */
export interface MutableVideoFrameRegistry extends VideoFrameRegistry {
  register(cacheKey: string, entry: VideoFrameRenderEntry): void;
}

/**
 * The cache key a `VideoFrameRegistry` is keyed by for a given `VideoNode`
 * at a given `frame`: `assetRef` plus the exact source-video-local frame
 * `@cadra/core`'s own `resolveVideoSourceFrame` maps this frame to (via
 * `inFrame`/`outFrame`/`playbackRate`/`outOfRangeBehavior`) - not `frame`
 * itself, mirroring `computeSatoriLayerRenderKey`'s own "key by the
 * resolved content, not the raw frame number" reasoning: two different
 * composition frames that happen to map to the same source frame (e.g.
 * `playbackRate < 1`, or `outOfRangeBehavior: "hold"` past the trim range)
 * collapse to one cache entry instead of needing two identical decodes.
 *
 * `resolveVideoSourceFrame`'s own contract expects a clip-local
 * `localFrame` (frames since the containing `Clip`'s own `startFrame`),
 * but `frame` here is the composition-absolute frame every other
 * `Property<T>` in this reconciler already resolves against (e.g.
 * `resolveNumberProperty(node.opacity, frame)` a few lines away in
 * `node-factory.ts`) - nothing upstream rebases a raw `SceneNode`'s own
 * per-frame resolution to be clip-local (see `three-renderer.ts`'s own
 * `buildSceneStateRoot`, which discards the timeline resolver's own
 * computed `localFrame` before the reconciler ever sees a node). Passing
 * the same absolute `frame` here is therefore consistent with, not a
 * deviation from, how every other animatable field on every other node
 * kind already behaves in this exact reconciler - a systemic
 * characteristic of the whole `Property<T>` system, not something this
 * one node kind should unilaterally special-case.
 */
export function computeVideoFrameRenderKey(node: VideoNode, frame: number): string {
  const sourceFrame = resolveVideoSourceFrame(
    {
      inFrame: node.inFrame,
      outFrame: node.outFrame,
      playbackRate: node.playbackRate,
      outOfRangeBehavior: node.outOfRangeBehavior,
    },
    frame,
  );
  return JSON.stringify({ assetRef: node.assetRef, sourceFrame });
}

/** A simple in-memory `MutableVideoFrameRegistry`, backed by a `Map`. */
export function createInMemoryVideoFrameRegistry(): MutableVideoFrameRegistry {
  const entries = new Map<string, VideoFrameRenderEntry>();

  return {
    resolve(cacheKey: string): VideoFrameRenderEntry | undefined {
      return entries.get(cacheKey);
    },
    register(cacheKey: string, entry: VideoFrameRenderEntry): void {
      entries.set(cacheKey, entry);
    },
  };
}
