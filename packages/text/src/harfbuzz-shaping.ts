import * as hb from "harfbuzzjs";

import type { ParsedFont } from "./parsed-font.js";
import type { ShapedGlyph } from "./shaped-run.js";

/**
 * Per-run shaping options. `script` is an ISO 15924 tag (see
 * `unicodeScriptToIso15924`); `features` toggles OpenType features
 * (`kern`, `liga`, `calt`, script-specific features, ...) on or off for
 * this run, applied to the whole run (HarfBuzz features can target a
 * sub-range, but a per-run toggle is all this layer exposes; nothing above
 * it needs finer granularity yet).
 */
export interface ShapeRunOptions {
  script: string;
  direction: "ltr" | "rtl";
  language?: string;
  features?: Readonly<Record<string, boolean>>;
}

interface CachedHarfbuzzFont {
  face: hb.Face;
  font: hb.Font;
}

/**
 * Compiled HarfBuzz `Face`/`Font` objects are expensive to build (they
 * parse the whole font's GSUB/GPOS/GDEF into wasm memory) and safe to
 * reuse across shape calls, so this caches one per (font content hash,
 * variation coordinates) pair. harfbuzzjs frees the underlying wasm
 * allocations itself via a `FinalizationRegistry` once a `Face`/`Font`
 * wrapper is garbage collected, so nothing here needs explicit disposal.
 */
const fontCache = new Map<string, CachedHarfbuzzFont>();

function variationCacheKeySuffix(coordinates: Readonly<Record<string, number>> | undefined): string {
  if (coordinates === undefined) {
    return "";
  }
  const sortedTags = Object.keys(coordinates).sort();
  return sortedTags.map((tag) => `:${tag}=${coordinates[tag]}`).join("");
}

function getOrCreateHarfbuzzFont(parsedFont: ParsedFont): hb.Font {
  const cacheKey = `${parsedFont.contentHash}${variationCacheKeySuffix(parsedFont.variationCoordinates)}`;
  const cached = fontCache.get(cacheKey);
  if (cached !== undefined) {
    return cached.font;
  }

  const bytes = parsedFont.bytes;
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new hb.Blob(arrayBuffer);
  const face = new hb.Face(blob);
  const font = new hb.Font(face);
  // Scale to the face's own upem so shaped advances/offsets come out in the
  // same font-unit space Phase 41's FontMetrics already use.
  font.setScale(face.upem, face.upem);
  if (parsedFont.variationCoordinates !== undefined) {
    font.setVariations(
      Object.entries(parsedFont.variationCoordinates).map(([tag, value]) => new hb.Variation(tag, value)),
    );
  }

  fontCache.set(cacheKey, { face, font });
  return font;
}

/**
 * Shapes one run of text (a single script and direction; see
 * `computeItemizedRuns`) with HarfBuzz, returning positioned glyphs with
 * cluster mapping back to `text`'s UTF-16 indices.
 */
export function shapeRun(
  parsedFont: ParsedFont,
  text: string,
  options: ShapeRunOptions,
): ShapedGlyph[] {
  const font = getOrCreateHarfbuzzFont(parsedFont);

  const buffer = new hb.Buffer();
  buffer.addText(text);
  buffer.setDirection(options.direction === "rtl" ? hb.Direction.RTL : hb.Direction.LTR);
  buffer.setScript(options.script);
  if (options.language !== undefined) {
    buffer.setLanguage(options.language);
  }
  buffer.setClusterLevel(hb.ClusterLevel.MONOTONE_CHARACTERS);

  const features = Object.entries(options.features ?? {}).map(
    ([tag, enabled]) => new hb.Feature(tag, enabled ? 1 : 0),
  );
  hb.shape(font, buffer, features);

  const infos = buffer.getGlyphInfos();
  const positions = buffer.getGlyphPositions();
  return infos.map((info, index) => {
    const position = positions[index] as hb.GlyphPosition;
    return {
      glyphId: info.codepoint,
      cluster: info.cluster,
      xAdvance: position.xAdvance,
      yAdvance: position.yAdvance,
      xOffset: position.xOffset,
      yOffset: position.yOffset,
      flags: info.flags,
    };
  });
}
