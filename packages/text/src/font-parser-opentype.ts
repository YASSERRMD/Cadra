import { hashAssetBytes } from "@cadra/core";
import * as opentype from "opentype.js";

import type { FontMetrics } from "./font-metrics.js";
import type { ParsedFont } from "./parsed-font.js";

/**
 * Picks out the real, callable `opentype.js` module object from whatever
 * `import * as opentype from "opentype.js"` actually bound at runtime.
 * `@types/opentype.js` (see this module's own doc below) declares every
 * export as if `opentype.js` were a genuine ES module (`export function
 * parse`, `export as namespace opentype`), which is also what that
 * namespace import is for: every type reference in this file
 * (`opentype.Font`, `opentype.LocalizedName`) resolves correctly against
 * it. The *installed* `opentype.js@2.0.0` package, though, actually ships
 * as a CJS UMD bundle with no statically analyzable named exports, so plain
 * Node's own ESM/CJS interop for `import * as` yields an object with only a
 * synthetic `default` property holding the real module (verified directly:
 * `Object.keys(opentype)` is exactly `["default", "module.exports"]` when
 * this file's own compiled output runs under plain `node`, even though a
 * dev-server bundler's own more permissive interop can paper over this and
 * let `opentype.parse` resolve directly there too - which is why this gap
 * went unnoticed until real compiled output was actually executed outside
 * of a bundler, in this codebase's own golden-frame harness, Phase 71).
 * This picks whichever shape actually carries the real exports at runtime,
 * so `parseFontWithOpentype` below works identically under a bundler and
 * under plain Node.
 *
 * Exported as a plain, dependency-free function (rather than inlined at
 * module scope) so a test can exercise both real shapes directly without
 * needing to fake how `opentype.js` itself resolves, matching this
 * codebase's own preference for pure-function/injected-fake tests over
 * module mocking.
 */
export function resolveOpentypeModuleExports(namespaceImport: typeof opentype): typeof opentype {
  return typeof (namespaceImport as { parse?: unknown }).parse === "function"
    ? namespaceImport
    : (namespaceImport as unknown as { default: typeof opentype }).default;
}

const opentypeModule: typeof opentype = resolveOpentypeModuleExports(opentype);

/**
 * `opentype.js` is the universal parsing backend: pure JS/ArrayBuffer based,
 * so unlike `fontkit` (Node's `Buffer`-only) it also runs inside a
 * browser-bundled render page. It does not do variable-font `gvar`
 * interpolation for us at this layer (that stays fontkit's job, see
 * `font-parser-fontkit.ts`); this module reads the font's own current
 * default state (its default instance, for a variable font).
 *
 * `@types/opentype.js` (published for the 1.x API) predates opentype.js
 * 2.0's typed surface for a few fields this module needs directly from the
 * font's tables. Those exact shapes are declared locally below, verified
 * against the installed `opentype.js@2.0.0` source rather than guessed.
 */

/** The subset of the OS/2 table this module reads; not covered by `@types/opentype.js`. */
interface OpenTypeOs2Table {
  sTypoLineGap?: number;
  sCapHeight?: number;
  sxHeight?: number;
}

/** The subset of a parsed GSUB/GPOS table this module reads to list feature tags. */
interface OpenTypeFeatureListTable {
  features?: ReadonlyArray<{ tag: string }>;
}

/**
 * `opentype.js` 2.0's real `name` table shape nests every field under a
 * platform (`windows`/`macintosh`/`unicode`), each holding the friendly
 * fields (`fontFamily`, `preferredFamily`, ...) alongside raw numeric
 * `fvar` axis/instance name IDs as sibling keys - not the flat
 * `{fontFamily, fontSubfamily, ...}` shape `@types/opentype.js` (1.x)
 * declares directly on `Font.names`. Verified empirically against
 * `opentype.js@2.0.0`'s parser (`parseNameTable`, which stores each record
 * at `name[platformName][property][language]`), not guessed.
 */
interface OpenTypePlatformNames {
  fontFamily?: opentype.LocalizedName;
  fontSubfamily?: opentype.LocalizedName;
  preferredFamily?: opentype.LocalizedName;
  preferredSubfamily?: opentype.LocalizedName;
}
interface OpenTypeNamesByPlatform {
  windows?: OpenTypePlatformNames;
  macintosh?: OpenTypePlatformNames;
}

function pickLocalizedName(name: opentype.LocalizedName | undefined): string {
  if (name === undefined) {
    return "";
  }
  return name.en ?? Object.values(name)[0] ?? "";
}

/**
 * Picks one name field, preferring the Windows/Unicode platform entry (UTF-16,
 * more consistently complete) over Macintosh, and the typographic
 * (`preferred*`, nameID 16/17) variant over the legacy RIBBI one
 * (`fontFamily`/`fontSubfamily`, nameID 1/2) when the font declares it.
 */
function pickNameField(
  names: OpenTypeNamesByPlatform,
  legacyField: "fontFamily" | "fontSubfamily",
  preferredField: "preferredFamily" | "preferredSubfamily",
): string {
  const platform = names.windows ?? names.macintosh;
  return pickLocalizedName(platform?.[preferredField] ?? platform?.[legacyField]);
}

function extractMetrics(font: opentype.Font): FontMetrics {
  const os2 = font.tables["os2"] as unknown as OpenTypeOs2Table | undefined;
  return {
    unitsPerEm: font.unitsPerEm,
    ascent: font.ascender,
    descent: font.descender,
    lineGap: os2?.sTypoLineGap ?? 0,
    capHeight: os2?.sCapHeight ?? font.ascender,
    xHeight: os2?.sxHeight ?? Math.round(font.ascender / 2),
  };
}

function extractCharacterSet(font: opentype.Font): Set<number> {
  const cmap = font.tables["cmap"] as unknown as { glyphIndexMap?: Record<number, number> } | undefined;
  if (!cmap?.glyphIndexMap) {
    return new Set();
  }
  return new Set(Object.keys(cmap.glyphIndexMap).map(Number));
}

function extractAvailableFeatures(font: opentype.Font): string[] {
  const tags = new Set<string>();
  for (const tableName of ["gsub", "gpos"] as const) {
    const table = font.tables[tableName] as unknown as OpenTypeFeatureListTable | undefined;
    for (const feature of table?.features ?? []) {
      tags.add(feature.tag.trim());
    }
  }
  return Array.from(tags);
}

/**
 * Parses `bytes` into a `ParsedFont` using the `opentype.js` backend. Does
 * not populate `variationAxes`/`namedInstances` (use
 * `parseFontWithFontkit`/`resolveFontVariationInstance` for variable-font
 * introspection and instancing); this backend exists for contexts where
 * fontkit's Node-only footprint cannot run.
 */
export function parseFontWithOpentype(bytes: Uint8Array): ParsedFont {
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const font = opentypeModule.parse(arrayBuffer);
  const names = font.names as unknown as OpenTypeNamesByPlatform;

  return {
    backend: "opentype",
    bytes,
    contentHash: hashAssetBytes(bytes),
    familyName: pickNameField(names, "fontFamily", "preferredFamily"),
    subfamilyName: pickNameField(names, "fontSubfamily", "preferredSubfamily"),
    metrics: extractMetrics(font),
    variationAxes: [],
    namedInstances: [],
    characterSet: extractCharacterSet(font),
    availableFeatures: extractAvailableFeatures(font),
  };
}
