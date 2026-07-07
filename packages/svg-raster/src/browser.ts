/**
 * @cadra/svg-raster/browser
 *
 * The subset of this package's surface that is safe to bundle into a
 * browser-executed context (`packages/renderer` consumes from here, the
 * same way it consumes `@cadra/text/browser`): pure data types only.
 * `rasterizeSvg` and `createSvgRasterCache` are deliberately not
 * re-exported here - both are backed by `@resvg/resvg-js`, a native Node
 * addon with no browser build at all, so rasterization always happens
 * ahead of time (wherever `rasterizeSvg` is called, e.g. server-side, the
 * same architecture Phase 44's MSDF text atlas generation already
 * established), with the result handed to the renderer as plain
 * `RasterizedSvg` pixels.
 */
export type { RasterizedSvg, RasterizeSvgOptions } from "./rasterize-svg.js";
