/**
 * @cadra/svg-raster
 *
 * Phase 47: deterministic SVG-to-RGBA rasterization via resvg, a fast,
 * from-scratch SVG renderer with no browser or Chromium involved. Written
 * to rasterize `@cadra/satori-layer`'s own SVG output, but takes any valid
 * SVG string; nothing here is Satori-specific.
 *
 * `rasterizeSvg` is the core operation: renders (optionally supersampled,
 * for crisper edges than resvg's own single-pass anti-aliasing alone) and
 * returns straight-alpha RGBA8 pixels ready for direct GPU texture upload,
 * the same convention `@cadra/text`'s MSDF atlas pages already establish.
 * `createSvgRasterCache` content-hashes a request (SVG bytes plus every
 * option affecting output) so identical requests across frames or scene
 * nodes only ever rasterize once.
 */

export const VERSION = "0.0.0";

/** Identifies this package at runtime, useful for diagnostics. */
export const PACKAGE_NAME = "@cadra/svg-raster";

export type { RasterizedSvg, RasterizeSvgOptions } from "./rasterize-svg.js";
export { rasterizeSvg } from "./rasterize-svg.js";
export { downsamplePremultipliedRgba, unpremultiplyRgba } from "./rgba-pixel-math.js";
export type { SvgRasterCache } from "./svg-raster-cache.js";
export { computeSvgRasterCacheKey, createSvgRasterCache } from "./svg-raster-cache.js";
