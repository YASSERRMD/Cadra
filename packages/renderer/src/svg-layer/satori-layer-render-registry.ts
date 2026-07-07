import { resolveSatoriElementStyles, type SatoriNode } from "@cadra/core";
// From the browser-safe entry, not the bare "@cadra/svg-raster" barrel:
// this module is part of packages/renderer's own code path that
// packages/headless bundles into the browser-executed render page (via
// esbuild); the main "." entry pulls in @resvg/resvg-js, a native Node
// addon with no browser build at all. See @cadra/svg-raster's own
// browser.ts module doc for the full explanation.
import type { RasterizedSvg } from "@cadra/svg-raster/browser";

/** Everything the reconciler needs to place one `SatoriNode`'s already-rasterized pixels: just the pixels themselves, the same "resolve-only" shape `TextRenderRegistry` already establishes. */
export interface SatoriLayerRenderEntry {
  rasterized: RasterizedSvg;
}

/**
 * Resolves a `SatoriNode` (at a specific frame) to its already-rendered-
 * and-rasterized `SatoriLayerRenderEntry`. Resolve-only, mirroring
 * `TextRenderRegistry`'s own contract: something else (a future headless
 * render loop's own per-frame preparation step, using
 * `prepare-satori-layer-render-data.ts`'s `prepareSatoriLayerRenderData`)
 * renders and rasterizes ahead of a `reconcile` call (both are async; a
 * reconciler's own `createThreeObject`/`applyNodeProperties` are not), the
 * same "not yet ready is an expected runtime state, not a programming
 * error" shape `image`/`video`/`text` nodes already have.
 */
export interface SatoriLayerRenderRegistry {
  resolve(cacheKey: string): SatoriLayerRenderEntry | undefined;
}

/** A `SatoriLayerRenderRegistry` a caller can also populate. */
export interface MutableSatoriLayerRenderRegistry extends SatoriLayerRenderRegistry {
  register(cacheKey: string, entry: SatoriLayerRenderEntry): void;
}

/**
 * The cache key a `SatoriLayerRenderRegistry` is keyed by for a given
 * `SatoriNode` at a given `frame`: unlike `computeTextNodeRenderKey` (a
 * `TextNode`'s own shaped glyphs never depend on which frame it is being
 * evaluated at), a `SatoriNode`'s rendered pixels genuinely can vary by
 * frame, since `elementAnimations` resolves to a different per-element
 * style at each one. Resolving those styles here (not just referencing
 * `frame` directly in the key) means two frames that happen to resolve to
 * the exact same styles (e.g. both before an animation's first keyframe,
 * where every keyframe track simply holds its starting value) collapse to
 * the same key and so share one cache entry, same as
 * `@cadra/satori-layer`'s and `@cadra/svg-raster`'s own content-addressed
 * caches one layer below this.
 *
 * A plain `JSON.stringify` of the relevant fields (not a content hash):
 * `layer`, `fonts` (`SatoriLayerFontRef[]`, plain strings/numbers - no font
 * bytes here to avoid hashing), and the resolved per-element styles are all
 * already plain, directly-comparable data, so there is nothing a hash would
 * buy over a direct string encoding, mirroring `computeTextNodeRenderKey`'s
 * own choice not to hash either.
 */
export function computeSatoriLayerRenderKey(node: SatoriNode, frame: number): string {
  const resolvedElementStyles = resolveSatoriElementStyles(node.elementAnimations, frame);
  return JSON.stringify({
    layer: node.layer,
    width: node.width,
    height: node.height,
    blendMode: node.blendMode ?? "normal",
    fonts: node.fonts ?? [],
    resolvedElementStyles,
  });
}

/** A simple in-memory `MutableSatoriLayerRenderRegistry`, backed by a `Map`. */
export function createInMemorySatoriLayerRenderRegistry(): MutableSatoriLayerRenderRegistry {
  const entries = new Map<string, SatoriLayerRenderEntry>();

  return {
    resolve(cacheKey: string): SatoriLayerRenderEntry | undefined {
      return entries.get(cacheKey);
    },
    register(cacheKey: string, entry: SatoriLayerRenderEntry): void {
      entries.set(cacheKey, entry);
    },
  };
}
