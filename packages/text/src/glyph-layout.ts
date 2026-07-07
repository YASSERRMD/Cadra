import type { MsdfAtlas } from "./msdf-atlas.js";
import type { ShapedTextRun } from "./shaped-run.js";

/**
 * One glyph positioned in world-independent "em" space (1 unit = 1 em; a
 * renderer multiplies by the node's own `fontSize` to get world units, so
 * geometry never needs rebuilding just because `fontSize` animates).
 */
export interface PositionedGlyph {
  glyphId: number;
  /** UTF-16 index into the original source string this glyph's cluster maps back to. */
  cluster: number;
  lineIndex: number;
  /** Index of the word (a maximal run of non-whitespace clusters) this glyph belongs to within its line. */
  wordIndex: number;
  /**
   * This glyph's own pen origin (baseline position plus HarfBuzz's shaped
   * per-glyph offset), in em units - the point extruded 3D glyph geometry
   * (built directly from the font's own outline, not the MSDF atlas)
   * should be placed at, since that geometry's coordinates are already
   * relative to this same origin.
   */
  origin: { x: number; y: number };
  /** Left/right/bottom/top of this glyph's visual quad, in em units relative to the text block's own origin. */
  quad: { left: number; right: number; bottom: number; top: number };
  /** Which `MsdfAtlas.pages` entry this glyph's texture data is packed into. */
  page: number;
  /** Normalized (0-1) texture coordinates into that atlas page, raw pixel row order (row 0 = top of the PNG). */
  uv: { u0: number; v0: number; u1: number; v1: number };
}

export interface GlyphLayoutResult {
  glyphs: readonly PositionedGlyph[];
  /** Total number of lines laid out (including empty lines from consecutive newlines). */
  lineCount: number;
}

export interface GlyphLayoutOptions {
  /** The font's `unitsPerEm`, to convert HarfBuzz's font-unit advances/offsets to em units. */
  unitsPerEm: number;
  /** Em-unit line-to-line baseline spacing. Defaults to the atlas's own `metrics.lineHeight`. */
  lineHeight?: number;
}

const WHITESPACE_PATTERN = /\s/;

/**
 * Computes where every glyph of `shapedLines` (one `shapeText` result per
 * source line, already split on `\n` and shaped independently) lands, in em
 * space, plus which atlas page/UV rectangle renders it. Purely a function of
 * its inputs (glyphs missing from the atlas, e.g. a space with no visual
 * bitmap, are skipped from the output but still advance the pen via the
 * shaped run's own advance), so laying out the same shaped lines against the
 * same atlas always produces the same result.
 */
export function computeGlyphLayout(
  shapedLines: readonly (readonly ShapedTextRun[])[],
  atlas: MsdfAtlas,
  options: GlyphLayoutOptions,
): GlyphLayoutResult {
  const placementsByGlyphId = new Map(atlas.glyphs.map((placement) => [placement.glyphId, placement]));
  const pageDimensionsByIndex = atlas.pages.map((page) => ({ width: page.width, height: page.height }));
  const lineHeight = options.lineHeight ?? atlas.metrics.lineHeight;

  const glyphs: PositionedGlyph[] = [];

  shapedLines.forEach((lineRuns, lineIndex) => {
    let penX = 0;
    let penY = -lineIndex * lineHeight;
    let wordIndex = -1;
    let inWord = false;

    for (const run of lineRuns) {
      for (const glyph of run.glyphs) {
        const originX = penX + glyph.xOffset / options.unitsPerEm;
        const originY = penY + glyph.yOffset / options.unitsPerEm;

        const isWhitespaceCluster = WHITESPACE_PATTERN.test(charAtClusterStart(run, glyph.cluster));
        if (isWhitespaceCluster) {
          inWord = false;
        } else {
          if (!inWord) {
            wordIndex += 1;
          }
          inWord = true;
        }

        const placement = placementsByGlyphId.get(glyph.glyphId);
        if (placement !== undefined && placement.width > 0 && placement.height > 0) {
          const pageDimensions = pageDimensionsByIndex[placement.page] ?? { width: 1, height: 1 };
          // `placement.scale` is the MSDF atlas's own pixels-per-em factor
          // for this glyph (msdfgen-wasm's `computeGlpyhMsdfData` sets it to
          // exactly the atlas generation's `size` option), so pixel-space
          // placement converts to em units without this module needing to
          // know or re-derive what font size the atlas was generated at.
          const quadWidth = placement.width / placement.scale;
          const quadHeight = placement.height / placement.scale;
          const quadLeft = originX - placement.xTranslate;
          const quadBottom = originY - placement.yTranslate;

          glyphs.push({
            glyphId: glyph.glyphId,
            cluster: glyph.cluster,
            lineIndex,
            wordIndex: Math.max(wordIndex, 0),
            origin: { x: originX, y: originY },
            quad: {
              left: quadLeft,
              right: quadLeft + quadWidth,
              bottom: quadBottom,
              top: quadBottom + quadHeight,
            },
            page: placement.page,
            uv: {
              u0: placement.x / pageDimensions.width,
              v0: placement.y / pageDimensions.height,
              u1: (placement.x + placement.width) / pageDimensions.width,
              v1: (placement.y + placement.height) / pageDimensions.height,
            },
          });
        }

        penX += glyph.xAdvance / options.unitsPerEm;
        penY += glyph.yAdvance / options.unitsPerEm;
      }
    }
  });

  return { glyphs, lineCount: shapedLines.length };
}

/** Looks up the source character a glyph's cluster starts at, to classify whitespace for word grouping. */
function charAtClusterStart(run: ShapedTextRun, cluster: number): string {
  return run.text[cluster - run.start] ?? "";
}
