import type { ColorRGBA } from "@cadra/core";

import type { MsdfAtlas, MsdfGlyphPlacement } from "./msdf-atlas.js";
import type { ShapedGlyph, ShapedTextRun } from "./shaped-run.js";
import { isWhitespaceChar } from "./whitespace.js";

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
  /**
   * This glyph's own MSDF distance-field range, in the same em-unit space
   * as `origin`/`quad` (`MsdfGlyphPlacement.range`, scaled by this glyph's
   * own per-span `fontSizeScale` exactly like `quad`'s own dimensions
   * already are - see `placeGlyphQuad`'s own doc on `scale`). A shader
   * needs this to convert an em-unit width (an outline's own `width`, a
   * glow's own `radius`, a shadow's own offset) into the atlas-encoded
   * signed-distance-field's own normalized unit space before comparing it
   * against the field's own sampled value - see
   * `packages/renderer/src/text/msdf-material.ts`.
   */
  range: number;
  /**
   * This glyph's own inline-style-span color override (`paragraph-layout.ts`,
   * Phase 45), when it has one. `computeGlyphLayout` (Phase 44, no
   * inline-style concept) never sets this; a renderer with no per-glyph
   * styling need can ignore it and fall back to its own uniform color.
   */
  color?: ColorRGBA;
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

/** The atlas lookup structures `placeGlyphQuad` needs, precomputed once per layout call rather than per glyph. */
export interface GlyphAtlasLookup {
  placementsByGlyphId: ReadonlyMap<number, MsdfGlyphPlacement>;
  pageDimensionsByIndex: readonly { width: number; height: number }[];
}

/** Builds a `GlyphAtlasLookup` from an `MsdfAtlas`, once per layout call. */
export function buildGlyphAtlasLookup(atlas: MsdfAtlas): GlyphAtlasLookup {
  return {
    placementsByGlyphId: new Map(atlas.glyphs.map((placement) => [placement.glyphId, placement])),
    pageDimensionsByIndex: atlas.pages.map((page) => ({ width: page.width, height: page.height })),
  };
}

/** One glyph's atlas-derived placement, everything `PositionedGlyph` needs beyond what its caller already knows (glyph id, cluster, line/word index). */
export interface GlyphQuadPlacement {
  origin: { x: number; y: number };
  quad: { left: number; right: number; bottom: number; top: number };
  page: number;
  uv: { u0: number; v0: number; u1: number; v1: number };
  range: number;
}

/**
 * Places one shaped glyph's quad at pen position `(penX, penY)` (already in
 * em units), looking up its MSDF atlas placement via `lookup`. Returns
 * `undefined` for a glyph with no visual bitmap (e.g. a space): it still
 * exists in shaped output to advance the pen, but contributes no quad.
 *
 * `scale` (default `1`) multiplies the atlas-derived quad's size and its
 * offset from `(penX, penY)`, for a glyph whose *advance* was already
 * normalized to a different effective font size than the atlas it samples
 * (the paragraph layout engine's per-span `fontSizeScale`, Phase 45): the
 * atlas's own placement data has no notion of that scale (it is fixed at
 * atlas-generation time), so unlike `glyph.xOffset`/`xAdvance` it is never
 * pre-scaled before reaching here and must be scaled at this step instead.
 *
 * Shared by `computeGlyphLayout` (single explicit lines, Phase 44) and the
 * paragraph layout engine (`paragraph-layout.ts`, Phase 45), which need the
 * same atlas-to-em-space quad math but walk the pen differently (the latter
 * also applies per-line alignment offsets and per-gap justification spacing),
 * so this is the one place that math is implemented.
 */
export function placeGlyphQuad(
  glyph: Pick<ShapedGlyph, "glyphId" | "xOffset" | "yOffset">,
  penX: number,
  penY: number,
  lookup: GlyphAtlasLookup,
  unitsPerEm: number,
  scale = 1,
): GlyphQuadPlacement | undefined {
  const originX = penX + glyph.xOffset / unitsPerEm;
  const originY = penY + glyph.yOffset / unitsPerEm;

  const placement = lookup.placementsByGlyphId.get(glyph.glyphId);
  if (placement === undefined || placement.width <= 0 || placement.height <= 0) {
    return undefined;
  }

  const pageDimensions = lookup.pageDimensionsByIndex[placement.page] ?? { width: 1, height: 1 };
  // `placement.scale` is the MSDF atlas's own pixels-per-em factor for this
  // glyph (msdfgen-wasm's `computeGlpyhMsdfData` sets it to exactly the
  // atlas generation's `size` option), so pixel-space placement converts to
  // em units without this module needing to know or re-derive what font
  // size the atlas was generated at.
  const quadWidth = (placement.width / placement.scale) * scale;
  const quadHeight = (placement.height / placement.scale) * scale;
  const quadLeft = originX - placement.xTranslate * scale;
  const quadBottom = originY - placement.yTranslate * scale;

  return {
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
    range: placement.range * scale,
  };
}

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
  const lookup = buildGlyphAtlasLookup(atlas);
  const lineHeight = options.lineHeight ?? atlas.metrics.lineHeight;

  const glyphs: PositionedGlyph[] = [];

  shapedLines.forEach((lineRuns, lineIndex) => {
    let penX = 0;
    let penY = -lineIndex * lineHeight;
    let wordIndex = -1;
    let inWord = false;

    for (const run of lineRuns) {
      for (const glyph of run.glyphs) {
        const isWhitespaceCluster = isWhitespaceChar(charAtClusterStart(run, glyph.cluster));
        if (isWhitespaceCluster) {
          inWord = false;
        } else {
          if (!inWord) {
            wordIndex += 1;
          }
          inWord = true;
        }

        const placed = placeGlyphQuad(glyph, penX, penY, lookup, options.unitsPerEm);
        if (placed !== undefined) {
          glyphs.push({
            glyphId: glyph.glyphId,
            cluster: glyph.cluster,
            lineIndex,
            wordIndex: Math.max(wordIndex, 0),
            ...placed,
          });
        }

        penX += glyph.xAdvance / options.unitsPerEm;
        penY += glyph.yAdvance / options.unitsPerEm;
      }
    }
  });

  return { glyphs, lineCount: shapedLines.length };
}

/** Looks up the source character a glyph's cluster starts at, to classify whitespace for word grouping. Exported for reuse by `paragraph-words.ts`, which needs the identical rule to agree on word boundaries. */
export function charAtClusterStart(run: Pick<ShapedTextRun, "text" | "start">, cluster: number): string {
  return run.text[cluster - run.start] ?? "";
}
