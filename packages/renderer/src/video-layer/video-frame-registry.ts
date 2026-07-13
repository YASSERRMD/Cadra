import { resolveVideoSourceFrame, type VideoNode } from "@cadra/core";

/**
 * Everything the reconciler needs to place one `VideoNode`'s already-decoded
 * current-frame pixels: just the pixels themselves, the same "resolve-only"
 * shape `TextRenderRegistry`/`SatoriLayerRenderRegistry` already establish.
 * Two shapes, one per decode path (see `VideoFrameRegistry`'s own doc):
 * `{ image }` for a real browser's own `<video>`-element decode (an
 * `ImageBitmap`, ready for `createImageTexture` to wrap - reusing the exact
 * same wrap this reconciler already uses for a resolved `ImageNode`); `{
 * pixels, width, height }` for a Node-only decode with no `ImageBitmap`
 * available at all (`@cadra/encode`'s own `ffmpeg-video-frame-decoder.ts`),
 * ready for `createDataTexture` to wrap instead - the same raw-RGBA8 path
 * `TextureRegistry`'s own Node-side `pngjs` decode already establishes for
 * images. Discriminated structurally (by which key is present), not via an
 * explicit tag: this way every existing `{ image }` construction site
 * (browser-side preparation, test fixtures) keeps working unchanged.
 */
export type VideoFrameRenderEntry = { image: ImageBitmap } | { pixels: Uint8Array; width: number; height: number };

/**
 * Resolves a `VideoNode` (at a specific frame) to its already-decoded
 * current-frame `VideoFrameRenderEntry`. Resolve-only, mirroring
 * `SatoriLayerRenderRegistry`'s own contract exactly: something else
 * samples and registers entries ahead of a `reconcile` call - a browser-side
 * preparation step (a real `<video>` element's own decode) for
 * `render_scene`'s own browser-based path, or a real `ffmpeg` child process
 * (`@cadra/encode`'s own `ffmpeg-video-frame-decoder.ts`, `buildVideoFrameRegistryForProject`)
 * for `render_frames`' own same-process native-GPU path, which has no
 * browser page (and so no `<video>` element, and no Node-built-in video
 * decode either) to decode with at all - the same "not yet ready is an
 * expected runtime state, not a programming error" shape every other
 * registry-resolved node kind in this codebase already has.
 */
export interface VideoFrameRegistry {
  resolve(cacheKey: string): VideoFrameRenderEntry | undefined;
}

/** A `VideoFrameRegistry` a caller can also populate. */
export interface MutableVideoFrameRegistry extends VideoFrameRegistry {
  register(cacheKey: string, entry: VideoFrameRenderEntry): void;
}

/**
 * The cache key a `VideoFrameRegistry` is keyed by for a given `assetRef` at
 * a given already-resolved source-video-local frame - the same shape both
 * `computeVideoFrameRenderKey` below (given a live `VideoNode` plus a
 * composition frame to resolve) and a Node-side render-job's own per-range
 * sample preparation (given only the raw `assetRef`/`sourceFrame` pair it
 * already computed via `resolveVideoSourceFrame` itself, with no `VideoNode`
 * in hand at all - see `@cadra/encode`'s own `render-job.ts`) need to
 * produce, so both sides of the `page.evaluate` structured-clone boundary
 * are guaranteed to agree on one key format from a single source of truth,
 * rather than two independently-hand-written `JSON.stringify` call sites
 * silently drifting apart.
 */
export function computeVideoFrameCacheKey(assetRef: string, sourceFrame: number): string {
  return JSON.stringify({ assetRef, sourceFrame });
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
  return computeVideoFrameCacheKey(node.assetRef, sourceFrame);
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
