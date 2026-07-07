import "./fontkit-augmentations.js";

import { hashAssetBytes } from "@cadra/core";
import * as fontkit from "fontkit";

import type { FontMetrics } from "./font-metrics.js";
import type { ParsedFont } from "./parsed-font.js";
import type { NamedInstance, VariationAxis } from "./variable-font.js";

/**
 * `fontkit` is the authoritative parsing backend: real `gvar` glyph
 * interpolation for variable fonts (`Font.getVariation`), full metrics, and
 * named-instance enumeration. It depends on Node's `Buffer`, so this module
 * only ever runs Node-side (registry construction, tests, headless asset
 * preparation), never inside a browser-bundled render page; see
 * `font-parser-opentype.ts` for the universal counterpart used there.
 */

export class UnsupportedFontCollectionError extends Error {
  constructor() {
    super("Font collections (TTC/DFont) are not supported here; provide a single font file.");
    this.name = "UnsupportedFontCollectionError";
  }
}

function assertSingleFont(
  font: fontkit.Font | fontkit.FontCollection,
): asserts font is fontkit.Font {
  if (font.type === "TTC" || font.type === "DFont") {
    throw new UnsupportedFontCollectionError();
  }
}

function toNodeBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function extractMetrics(font: fontkit.Font): FontMetrics {
  return {
    unitsPerEm: font.unitsPerEm,
    ascent: font.ascent,
    descent: font.descent,
    lineGap: font.lineGap,
    capHeight: font.capHeight,
    xHeight: font.xHeight,
  };
}

function extractVariationAxes(font: fontkit.Font): VariationAxis[] {
  const axes: VariationAxis[] = [];
  for (const [tag, axis] of Object.entries(font.variationAxes)) {
    if (axis === undefined) {
      continue;
    }
    axes.push({ tag, name: axis.name, min: axis.min, default: axis.default, max: axis.max });
  }
  return axes;
}

function extractNamedInstances(font: fontkit.Font): NamedInstance[] {
  return Object.entries(font.namedVariations).map(([name, coordinates]) => ({
    name,
    coordinates,
  }));
}

function buildParsedFont(
  font: fontkit.Font,
  bytes: Uint8Array,
  variationCoordinates?: Readonly<Record<string, number>>,
): ParsedFont {
  return {
    backend: "fontkit",
    bytes,
    contentHash: hashAssetBytes(bytes),
    familyName: font.familyName,
    subfamilyName: font.subfamilyName,
    metrics: extractMetrics(font),
    variationAxes: extractVariationAxes(font),
    namedInstances: extractNamedInstances(font),
    characterSet: new Set(font.characterSet),
    availableFeatures: font.availableFeatures,
    ...(variationCoordinates !== undefined ? { variationCoordinates } : {}),
  };
}

/** Parses `bytes` into a `ParsedFont` using the `fontkit` backend. */
export function parseFontWithFontkit(bytes: Uint8Array): ParsedFont {
  const font = fontkit.create(toNodeBuffer(bytes));
  assertSingleFont(font);
  return buildParsedFont(font, bytes);
}

/**
 * Resolves a variable font (parsed via `parseFontWithFontkit`) to a specific
 * instance, either by named-instance name or by explicit axis coordinates.
 * The returned `ParsedFont` retains the original variable-font `bytes`
 * (shaping, Phase 42, needs the full variable font plus these coordinates,
 * not a "baked" static copy) but its metrics reflect the pinned instance.
 */
export function resolveFontVariationInstance(
  parsed: ParsedFont,
  settings: string | Readonly<Record<string, number>>,
): ParsedFont {
  if (parsed.backend !== "fontkit") {
    throw new Error(
      "resolveFontVariationInstance requires a ParsedFont produced by parseFontWithFontkit.",
    );
  }
  const font = fontkit.create(toNodeBuffer(parsed.bytes));
  assertSingleFont(font);
  const instance = font.getVariation(settings);

  const resolvedCoordinates: Record<string, number> =
    typeof settings === "string"
      ? { ...(parsed.namedInstances.find((candidate) => candidate.name === settings)?.coordinates ?? {}) }
      : { ...settings };

  return buildParsedFont(instance, parsed.bytes, resolvedCoordinates);
}
