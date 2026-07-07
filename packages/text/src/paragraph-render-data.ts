import type { ColorRGBA } from "@cadra/core";

import { buildGlyphAtlasLookup, placeGlyphQuad, type PositionedGlyph } from "./glyph-layout.js";
import type { ParagraphSpan } from "./inline-text-style.js";
import type { MsdfAtlasOptions, MsdfAtlasPage } from "./msdf-atlas.js";
import type { MsdfAtlasCache } from "./msdf-atlas-cache.js";
import { layoutParagraphLines, type ParagraphLayoutOptions, type ParagraphLineMetrics } from "./paragraph-layout.js";
import type { ParsedFont } from "./parsed-font.js";
import { sharedAtlasCache } from "./shared-atlas-cache.js";

/** A `PositionedGlyph` with its inline style span's resolved color attached, when it has one (a plain, unstyled paragraph never sets this - a renderer with no per-glyph styling need can ignore it and fall back to its own uniform color, same as Phase 44's plain text path). */
export interface StyledPositionedGlyph extends PositionedGlyph {
  color?: ColorRGBA;
}

export interface PrepareParagraphRenderDataOptions extends ParagraphLayoutOptions {
  atlasOptions?: MsdfAtlasOptions;
}

/** Everything a renderer needs to draw a laid-out paragraph: every distinct font's atlas pages merged into one flat list, plus every glyph's em-space position, UVs, resolved style, and line metrics. */
export interface ParagraphRenderData {
  readonly atlasPages: readonly MsdfAtlasPage[];
  readonly glyphs: readonly StyledPositionedGlyph[];
  readonly lineCount: number;
  readonly lines: readonly ParagraphLineMetrics[];
}

/**
 * Runs `layoutParagraphLines` (bidi, itemization, shaping, line breaking,
 * alignment and justification - see its own doc), then resolves the one
 * remaining atlas-dependent step: an MSDF atlas per distinct font any span
 * actually used (an inline style span's `font` override is a genuinely
 * different font file, see `InlineTextStyle`'s own doc), merged into one
 * flat `atlasPages` list with each glyph's `page` remapped from its own
 * font-local atlas index to a global one, so a renderer never needs to
 * know how many distinct fonts contributed.
 */
export async function prepareParagraphRenderData(
  spans: readonly ParagraphSpan[],
  options: PrepareParagraphRenderDataOptions,
  atlasCache: MsdfAtlasCache = sharedAtlasCache,
): Promise<ParagraphRenderData> {
  const linesLayout = layoutParagraphLines(spans, options);

  const usedGlyphIdsByFont = new Map<string, { font: ParsedFont; glyphIds: Set<number> }>();
  for (const glyph of linesLayout.glyphs) {
    let entry = usedGlyphIdsByFont.get(glyph.font.contentHash);
    if (entry === undefined) {
      entry = { font: glyph.font, glyphIds: new Set() };
      usedGlyphIdsByFont.set(glyph.font.contentHash, entry);
    }
    entry.glyphIds.add(glyph.glyphId);
  }

  const atlasPages: MsdfAtlasPage[] = [];
  const lookupByFont = new Map<string, ReturnType<typeof buildGlyphAtlasLookup>>();
  const pageOffsetByFont = new Map<string, number>();
  for (const [contentHash, entry] of usedGlyphIdsByFont) {
    const atlas = await atlasCache.getOrGenerate(entry.font, entry.glyphIds, options.atlasOptions);
    pageOffsetByFont.set(contentHash, atlasPages.length);
    atlasPages.push(...atlas.pages);
    lookupByFont.set(contentHash, buildGlyphAtlasLookup(atlas));
  }

  const glyphs: StyledPositionedGlyph[] = [];
  for (const glyph of linesLayout.glyphs) {
    const lookup = lookupByFont.get(glyph.font.contentHash);
    if (lookup === undefined) {
      continue;
    }
    const placed = placeGlyphQuad(
      { glyphId: glyph.glyphId, xOffset: glyph.xOffset, yOffset: glyph.yOffset },
      glyph.penX,
      glyph.penY,
      lookup,
      1,
      glyph.scale,
    );
    if (placed === undefined) {
      continue;
    }
    const pageOffset = pageOffsetByFont.get(glyph.font.contentHash) as number;
    glyphs.push({
      glyphId: glyph.glyphId,
      cluster: glyph.cluster,
      lineIndex: glyph.lineIndex,
      wordIndex: glyph.wordIndex,
      origin: placed.origin,
      quad: placed.quad,
      page: placed.page + pageOffset,
      uv: placed.uv,
      ...(glyph.color !== undefined && { color: glyph.color }),
    });
  }

  return { atlasPages, glyphs, lineCount: linesLayout.lineCount, lines: linesLayout.lines };
}
