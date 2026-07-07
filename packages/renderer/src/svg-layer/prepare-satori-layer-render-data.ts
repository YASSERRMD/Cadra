import { resolveSatoriElementStyles, type SatoriNode } from "@cadra/core";
import {
  applyElementAnimations,
  type RenderLayerCache,
  type SatoriLayerFont,
  sharedRenderLayerCache,
} from "@cadra/satori-layer";
import { type RasterizedSvg, sharedSvgRasterCache, type SvgRasterCache } from "@cadra/svg-raster";

/**
 * Node-only: pulls in the full (not `/browser`) `@cadra/satori-layer` and
 * `@cadra/svg-raster` entries, backed respectively by `satori`/`harfbuzzjs`-
 * via-`@cadra/text` and `@resvg/resvg-js`, a native Node addon. Never
 * imported by `node-factory.ts`/`reconciler.ts` (which only ever consume a
 * `SatoriLayerRenderRegistry`'s already-resolve-only entries), so this
 * never reaches the browser-bundled render page - mirroring exactly how
 * `@cadra/text`'s own `prepareTextRenderData` (also Node-only, also never
 * imported by the reconciler directly) stays out of that bundle.
 */

export interface PrepareSatoriLayerRenderDataOptions {
  /** Supersample factor passed straight through to `rasterizeSvg`. Defaults to `1` (no supersampling). */
  supersample?: number;
  renderLayerCache?: RenderLayerCache;
  svgRasterCache?: SvgRasterCache;
}

/**
 * Renders and rasterizes one `SatoriNode` at one specific `frame`: resolves
 * `elementAnimations` at `frame` (`resolveSatoriElementStyles`), applies the
 * result onto a per-frame copy of `node.layer` (`applyElementAnimations`),
 * renders that to SVG (`renderLayerToSvg`, through the shared render-layer
 * cache by default) and rasterizes it (`rasterizeSvg`, through the shared
 * raster cache by default) at `node.width`/`node.height`.
 *
 * `fonts` must already be resolved to real `ParsedFont` bytes (a
 * `SatoriLayerFont[]`, `@cadra/satori-layer`'s own shape) - this function
 * does not resolve `node.fonts`' own `SatoriLayerFontRef.fontRef` strings
 * against a font registry itself, the same "not yet wired into a font
 * registry" scope boundary `TextNode.fontRef` itself is still under (see
 * `TextRenderRegistry`'s own doc comment).
 *
 * Caching happens at two independent layers (render-to-SVG, then
 * SVG-to-pixels), each keyed by its own content hash, so a caller that
 * re-renders the same layer at a frame whose resolved element styles
 * happen to be unchanged (e.g. every frame before an animation's first
 * keyframe) never re-runs Satori or resvg at all, satisfying Phase 48's
 * own "re-render the layer only when its inputs change across frames,
 * caching otherwise for speed."
 */
export async function prepareSatoriLayerRenderData(
  node: SatoriNode,
  frame: number,
  fonts: readonly SatoriLayerFont[],
  options: PrepareSatoriLayerRenderDataOptions = {},
): Promise<RasterizedSvg> {
  const renderLayerCache = options.renderLayerCache ?? sharedRenderLayerCache;
  const svgRasterCache = options.svgRasterCache ?? sharedSvgRasterCache;

  const resolvedElementStyles = resolveSatoriElementStyles(node.elementAnimations, frame);
  const perFrameLayer = applyElementAnimations(node.layer, resolvedElementStyles);

  const svg = await renderLayerCache.getOrRender(perFrameLayer, {
    width: node.width,
    height: node.height,
    fonts,
  });

  return svgRasterCache.getOrRasterize(svg, {
    width: node.width,
    height: node.height,
    supersample: options.supersample,
  });
}
