/**
 * @cadra/satori-layer
 *
 * Phase 46: a browserless path to author rich 2D layers in HTML and CSS,
 * rendered deterministically to SVG via Satori (real flexbox layout
 * through Yoga, no Chromium involved) - the direct answer to Remotion's
 * browser-based 2D text and graphics quality, while staying fast and
 * reproducible.
 *
 * `LayerElement`/`LayerStyle` are a typed, curated subset of HTML/CSS (only
 * what Satori itself implements), so an agent can only ever construct
 * something this package knows how to render, not an arbitrary string that
 * might contain an unsupported tag or a typo'd property name. Satori
 * cannot parse a variable font at all (verified empirically; see
 * `satori-font-instancing.ts`), so every font is pinned to a fully static
 * instance and subset to the layer's own text before Satori ever sees it,
 * reusing `@cadra/text`'s own `subsetFontToCodePoints` (the same
 * HarfBuzz-backed subsetter the 3D text engine's font pipeline uses).
 */

export const VERSION = "0.0.0";

/** Identifies this package at runtime, useful for diagnostics. */
export const PACKAGE_NAME = "@cadra/satori-layer";

export type { ResolvedElementStyle } from "./apply-element-animations.js";
export { applyElementAnimations } from "./apply-element-animations.js";
export { resolveEmojiDataUri } from "./emoji-resolver.js";
export type { EmojiResolverCache } from "./emoji-resolver-cache.js";
export { createEmojiResolverCache } from "./emoji-resolver-cache.js";
export { createLoadAdditionalAsset } from "./fallback-font-resolver.js";
export { resolveLucideIconSvgText } from "./icon-assets.js";
export { recolorSvgText, resolveIconDataUri } from "./icon-resolver.js";
export type { IconResolverCache } from "./icon-resolver-cache.js";
export { createIconResolverCache } from "./icon-resolver-cache.js";
export type { LayerElement, LayerElementType, LayerStyle } from "./layer-element.js";
export type { SatoriElement } from "./layer-to-satori-node.js";
export { layerElementToSatoriNode } from "./layer-to-satori-node.js";
export type { RenderLayerCache } from "./render-layer-cache.js";
export { createRenderLayerCache } from "./render-layer-cache.js";
export { computeRenderLayerCacheKey } from "./render-layer-cache-key.js";
export type { LayerDimensions, RenderLayerToSvgOptions, SatoriLayerFont } from "./render-layer-to-svg.js";
export { renderLayerToSvg } from "./render-layer-to-svg.js";
export { resolveIconElements } from "./resolve-icon-elements.js";
export { instanceFontForSatori, resolveFullVariationPin } from "./satori-font-instancing.js";
export { sharedEmojiResolverCache } from "./shared-emoji-resolver-cache.js";
export { sharedIconResolverCache } from "./shared-icon-resolver-cache.js";
export { sharedRenderLayerCache } from "./shared-render-layer-cache.js";
export { resolveTwemojiSvgBytes } from "./twemoji-assets.js";
