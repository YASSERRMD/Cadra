import {
  type AssetRegistry,
  type ContentHash,
  createInMemoryAssetRegistry,
  hashAssetBytes,
} from "@cadra/core";

import { type RasterizedSvg, rasterizeSvg, type RasterizeSvgOptions } from "./rasterize-svg.js";

/**
 * Deterministic cache key for one `rasterizeSvg` request: the SVG's own
 * content hash plus every option that affects its output pixels. Mirrors
 * `@cadra/text`'s `computeMsdfAtlasCacheKey`/`computeTextRenderCacheKey`
 * (same "hash the exact inputs that affect output, resolve defaults first
 * so an explicit default-valued option hashes the same as an omitted one"
 * shape).
 */
export function computeSvgRasterCacheKey(svg: string, options: RasterizeSvgOptions = {}): ContentHash {
  const svgHash = hashAssetBytes(new TextEncoder().encode(svg));
  const optionsKey = [
    options.width ?? "",
    options.height ?? "",
    options.supersample ?? 1,
    options.background ?? "",
  ].join(":");
  return hashAssetBytes(new TextEncoder().encode(`${svgHash}:${optionsKey}`));
}

export interface SvgRasterCache {
  /** Returns the cached rasterization for this exact (svg, options) request, rasterizing and caching it if this is the first time it has been asked for. */
  getOrRasterize(svg: string, options?: RasterizeSvgOptions): RasterizedSvg;
  has(cacheKey: ContentHash): boolean;
}

/**
 * Content-hashed cache over `rasterizeSvg`, so the same SVG plus the same
 * rasterization options is only ever rendered once per process, no matter
 * how many scene nodes or frames reference it (a static layer, e.g. one
 * with no per-frame keyframes on any of its own inputs, produces the exact
 * same SVG and so hits this cache on every later frame).
 */
export function createSvgRasterCache(): SvgRasterCache {
  const registry: AssetRegistry<RasterizedSvg> = createInMemoryAssetRegistry<RasterizedSvg>();

  return {
    getOrRasterize(svg: string, options: RasterizeSvgOptions = {}): RasterizedSvg {
      const cacheKey = computeSvgRasterCacheKey(svg, options);
      const cached = registry.resolve(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
      const rasterized = rasterizeSvg(svg, options);
      registry.register(cacheKey, rasterized);
      return rasterized;
    },
    has: (cacheKey: ContentHash) => registry.has(cacheKey),
  };
}
