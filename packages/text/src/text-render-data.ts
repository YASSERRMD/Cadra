import { computeGlyphLayout, type PositionedGlyph } from "./glyph-layout.js";
import type { MsdfAtlasOptions, MsdfAtlasPage } from "./msdf-atlas.js";
import type { MsdfAtlasCache } from "./msdf-atlas-cache.js";
import type { ParsedFont } from "./parsed-font.js";
import { shapeText, type ShapeTextOptions } from "./shape-text.js";
import { sharedAtlasCache } from "./shared-atlas-cache.js";

/** Everything a renderer needs to draw a block of text: atlas textures plus every glyph's em-space position and UVs. */
export interface TextRenderData {
  readonly atlasPages: readonly MsdfAtlasPage[];
  readonly glyphs: readonly PositionedGlyph[];
  readonly lineCount: number;
}

export interface PrepareTextRenderDataOptions extends ShapeTextOptions {
  atlasOptions?: MsdfAtlasOptions;
  /** Em-unit line-to-line baseline spacing. Defaults to the atlas's own line height. */
  lineHeight?: number;
}

/**
 * Combines HarfBuzz shaping, MSDF atlas generation, and glyph layout into
 * the one call a renderer needs: `content` is split on `\n` into
 * independently-shaped lines (rich multi-line paragraph layout - breaking,
 * justification, alignment - is Phase 45's job; this lays out only what
 * explicit newlines already say), each line's glyphs are shaped, every
 * distinct glyph id used across every line drives one atlas generation
 * request (deduplicated and cached by the atlas cache), and the result is
 * laid out in em space via `computeGlyphLayout`.
 */
export async function prepareTextRenderData(
  font: ParsedFont,
  content: string,
  options: PrepareTextRenderDataOptions = {},
  atlasCache: MsdfAtlasCache = sharedAtlasCache,
): Promise<TextRenderData> {
  const lines = content.split("\n").map((line) => shapeText(font, line, options));

  const usedGlyphIds = new Set<number>();
  for (const line of lines) {
    for (const run of line) {
      for (const glyph of run.glyphs) {
        usedGlyphIds.add(glyph.glyphId);
      }
    }
  }

  const atlas = await atlasCache.getOrGenerate(font, usedGlyphIds, options.atlasOptions);
  const layout = computeGlyphLayout(lines, atlas, {
    unitsPerEm: font.metrics.unitsPerEm,
    lineHeight: options.lineHeight,
  });

  return { atlasPages: atlas.pages, glyphs: layout.glyphs, lineCount: layout.lineCount };
}

/**
 * Deterministic cache key for one `prepareTextRenderData` request. Does not
 * need to know the actual glyph set (unlike the MSDF atlas cache's own key,
 * which this does not call into): the same `content` plus the same font
 * plus the same options always shapes to the same glyphs, so `content`
 * itself already stands in for "which glyphs".
 */
export function computeTextRenderCacheKey(
  font: ParsedFont,
  content: string,
  options: PrepareTextRenderDataOptions = {},
): string {
  const featuresKey = Object.entries(options.features ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([tag, enabled]) => `${tag}=${enabled ? 1 : 0}`)
    .join(",");
  const atlasOptions = options.atlasOptions ?? {};
  const atlasOptionsKey = [
    atlasOptions.fontSize ?? "",
    atlasOptions.range ?? "",
    atlasOptions.maxWidth ?? "",
    atlasOptions.maxHeight ?? "",
    atlasOptions.padding ?? "",
  ].join(",");

  return [
    font.contentHash,
    content,
    options.direction ?? "",
    options.language ?? "",
    featuresKey,
    options.lineHeight ?? "",
    atlasOptionsKey,
  ].join(":");
}
