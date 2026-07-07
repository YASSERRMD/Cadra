import { createSvgRasterCache, type SvgRasterCache } from "./svg-raster-cache.js";

/**
 * The process-wide default rasterization cache any caller rasterizes an
 * SVG through unless it injects its own (e.g. for test isolation). Mirrors
 * `@cadra/text`'s `sharedAtlasCache` and `@cadra/satori-layer`'s
 * `sharedRenderLayerCache` exactly.
 */
export const sharedSvgRasterCache: SvgRasterCache = createSvgRasterCache();
