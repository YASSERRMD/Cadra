/**
 * @cadra/text
 *
 * Phase 41: the font subsystem. Fonts are parsed to real glyph outlines and
 * metrics (via `fontkit` and `opentype.js`), not a canvas font string;
 * variable fonts expose their named instances and variation axes; fonts
 * register into a content-hashed registry that gates rendering until every
 * referenced font has resolved, via the same `Pending`/`waitForAssets`
 * contract `@cadra/core`'s asset pipeline (base Phase 12) already
 * establishes. Deterministic subsetting (`subsetFontToCodePoints`, backed by
 * HarfBuzz's `hb-subset` wasm build via `subset-font`) keys a subset by the
 * exact set of code points a scene actually uses.
 *
 * Two parsing backends produce the same `ParsedFont` shape (see
 * `parsed-font.ts` for why): `fontkit` is authoritative (real `gvar`
 * variable-font interpolation, full metrics, named-instance enumeration)
 * but Node-only; `opentype.js` is lighter and universal, for contexts like
 * a browser-bundled render page where fontkit cannot run.
 *
 * Phase 42: real text shaping. `shapeText` resolves Unicode bidi (via
 * `bidi-js`), itemizes into single-script single-direction runs (script
 * detection via `unicode-properties`), shapes each run with real HarfBuzz
 * (via `harfbuzzjs`, applying OpenType features and variable-font
 * coordinates), and reorders the runs into visual order per UAX #9 rule
 * L2. Every shaped glyph carries a `cluster` mapping back to the original
 * string, for later phases' per-glyph animation and grapheme-safe
 * splitting.
 *
 * Phase 43: MSDF glyph atlases. `generateMsdfAtlas` (via `msdfgen-wasm`,
 * a real wasm build of Chlumsky's msdfgen) packs exactly the glyphs a
 * scene's shaped runs use into a multi-channel signed distance field
 * atlas, so text stays crisp under arbitrary 2D or 3D scale.
 * `createMsdfAtlasCache` content-hashes a request (font, glyph set,
 * options) so the same glyphs are only ever generated once.
 *
 * Phase 44: renderer-agnostic glyph layout. `prepareTextRenderData`
 * combines shaping, atlas generation, and `computeGlyphLayout` into the
 * one call a 3D (or 2D) renderer needs: every glyph's em-space quad
 * (world-independent - a renderer multiplies by its own `fontSize` to get
 * world units, so geometry never needs rebuilding just because `fontSize`
 * animates), atlas UV rectangle, and line/word grouping.
 */

export const VERSION = "0.0.0";

/** Identifies this package at runtime, useful for diagnostics. */
export const PACKAGE_NAME = "@cadra/text";

export type { BidiParagraph, BidiResolution, TextDirection } from "./bidi-resolution.js";
export { isRtlLevel, resolveBidi } from "./bidi-resolution.js";
export type { FontMetrics } from "./font-metrics.js";
export {
  resolveFontVariationInstance,
  UnsupportedFontCollectionError,
} from "./font-parser-fontkit.js";
export { parseFontWithFontkit } from "./font-parser-fontkit.js";
export { parseFontWithOpentype } from "./font-parser-opentype.js";
export type { FontRegistration, FontRegistry, FontRegistryOptions } from "./font-registry.js";
export { createFontRegistry } from "./font-registry.js";
export type { FontSubsetOptions } from "./font-subset.js";
export { codePointSetKey, subsetFontToCodePoints } from "./font-subset.js";
export type { GlyphLayoutOptions, GlyphLayoutResult, PositionedGlyph } from "./glyph-layout.js";
export { computeGlyphLayout } from "./glyph-layout.js";
export type { GlyphPathCommand } from "./glyph-path.js";
export { getGlyphPathCommands } from "./glyph-path.js";
export type { ShapeRunOptions } from "./harfbuzz-shaping.js";
export { shapeRun } from "./harfbuzz-shaping.js";
export type {
  MsdfAtlas,
  MsdfAtlasOptions,
  MsdfAtlasPage,
  MsdfFontMetrics,
  MsdfGlyphPlacement,
} from "./msdf-atlas.js";
export { generateMsdfAtlas } from "./msdf-atlas.js";
export type { MsdfAtlasCache } from "./msdf-atlas-cache.js";
export { computeMsdfAtlasCacheKey, createMsdfAtlasCache } from "./msdf-atlas-cache.js";
export type { FontParseBackend, ParsedFont } from "./parsed-font.js";
export type { ItemizedRun } from "./script-runs.js";
export { computeItemizedRuns } from "./script-runs.js";
export {
  SCRIPT_LESS_UNICODE_SCRIPTS,
  UNICODE_SCRIPT_TO_ISO_15924,
  unicodeScriptToIso15924,
} from "./script-tags.js";
export type { ShapeTextOptions } from "./shape-text.js";
export { shapeText } from "./shape-text.js";
export type { ShapedGlyph, ShapedTextRun } from "./shaped-run.js";
export type { PrepareTextRenderDataOptions, TextRenderData } from "./text-render-data.js";
export { computeTextRenderCacheKey, prepareTextRenderData } from "./text-render-data.js";
export type { NamedInstance, VariationAxis } from "./variable-font.js";
export { clampToAxisRange, findNamedInstance } from "./variable-font.js";
export { reorderRunsToVisualOrder } from "./visual-run-order.js";
