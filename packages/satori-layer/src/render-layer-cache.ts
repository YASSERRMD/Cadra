import { type AssetRegistry, type ContentHash, createInMemoryAssetRegistry } from "@cadra/core";

import type { LayerElement } from "./layer-element.js";
import { computeRenderLayerCacheKey } from "./render-layer-cache-key.js";
import { renderLayerToSvg, type RenderLayerToSvgOptions } from "./render-layer-to-svg.js";

export interface RenderLayerCache {
  /** Returns the cached SVG for this exact (layer, options) request, rendering and caching it if this is the first time it has been asked for. */
  getOrRender(layer: LayerElement, options: RenderLayerToSvgOptions): Promise<string>;
  has(cacheKey: ContentHash): boolean;
}

/**
 * Content-hashed cache over `renderLayerToSvg`, so the same layer tree plus
 * the same options is only ever rendered once per process, no matter how
 * many frames a `SatoriNode` with no changing inputs is asked for (Phase
 * 48's own "re-render the layer only when its inputs change across frames,
 * caching otherwise for speed"). Mirrors `@cadra/svg-raster`'s
 * `createSvgRasterCache` and `@cadra/text`'s `createMsdfAtlasCache` exactly.
 */
export function createRenderLayerCache(): RenderLayerCache {
  const registry: AssetRegistry<Promise<string>> = createInMemoryAssetRegistry<Promise<string>>();

  return {
    getOrRender(layer: LayerElement, options: RenderLayerToSvgOptions): Promise<string> {
      const cacheKey = computeRenderLayerCacheKey(layer, options);
      const cached = registry.resolve(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
      const pending = renderLayerToSvg(layer, options);
      registry.register(cacheKey, pending);
      return pending;
    },
    has: (cacheKey: ContentHash) => registry.has(cacheKey),
  };
}
