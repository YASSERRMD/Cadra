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
 */

export const VERSION = "0.0.0";

/** Identifies this package at runtime, useful for diagnostics. */
export const PACKAGE_NAME = "@cadra/text";

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
export type { FontParseBackend, ParsedFont } from "./parsed-font.js";
export type { NamedInstance, VariationAxis } from "./variable-font.js";
export { clampToAxisRange, findNamedInstance } from "./variable-font.js";
