import type { PositionedGlyph } from "./glyph-layout.js";

/**
 * The four granularities text can be split into for kinetic-typography
 * staggering: `"grapheme"` (one user-perceived character, e.g. a base
 * letter plus its combining marks, or a ZWJ emoji sequence, kept together
 * even when HarfBuzz shapes it as more than one cluster), `"character"`
 * (one HarfBuzz shaping cluster - coarser than a raw code point whenever
 * shaping fuses several into one, e.g. a ligature, but never coarser than
 * a `"grapheme"` unit needs), `"word"` (a maximal run of non-whitespace
 * clusters, the same boundary `PositionedGlyph.wordIndex` already uses),
 * and `"line"` (one rendered line, the same boundary `PositionedGlyph.lineIndex`
 * already uses).
 */
export type TextUnitGranularity = "grapheme" | "character" | "word" | "line";

/**
 * One splittable unit: which `glyphs` array indices (the same array passed
 * to `splitTextUnits`) belong to it, and this unit's own `index` - a
 * dense, zero-based rank in *reading order* (never raw visual/array
 * order: for a right-to-left line, the first-read unit is the visually
 * rightmost one, matching how a native reader - and so a typewriter-style
 * reveal - actually encounters the text), contiguous across the whole
 * `glyphs` array regardless of how many lines it spans (`"line"` units are
 * the one exception, whose own `index` is simply their line's rank among
 * lines that have any glyphs at all, top to bottom - reading order needs
 * no extra care there, since line order is already vertical and
 * unaffected by a line's own horizontal script direction).
 */
export interface TextUnit {
  index: number;
  glyphIndices: readonly number[];
}

/** Every code point `text` is made of, by code point (not UTF-16 code unit - `Array.from` iterates a string by code point), each tagged with its own UTF-16 start offset. */
function graphemeSegmentStarts(text: string): number[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(text), (segment) => segment.index);
}

/** The largest `starts` entry that is `<= offset` (`starts` must be sorted ascending and cover every possible `offset` from `0`, which `graphemeSegmentStarts` always does since Unicode segmentation partitions the whole string). */
function segmentStartAtOrBefore(starts: readonly number[], offset: number): number {
  let result = starts[0] ?? 0;
  for (const start of starts) {
    if (start > offset) {
      break;
    }
    result = start;
  }
  return result;
}

/** Groups `glyphIndices` (indices into `glyphs`) by `keyOf`, then returns one `TextUnit` per distinct key, ordered by each group's own minimum `glyphs[i].cluster` ascending - reading order, correct regardless of script direction (see this module's own doc on `cluster`). */
function groupByReadingOrder(
  glyphs: readonly PositionedGlyph[],
  glyphIndices: readonly number[],
  keyOf: (glyphIndex: number) => string,
): TextUnit[] {
  const byKey = new Map<string, number[]>();
  for (const glyphIndex of glyphIndices) {
    const key = keyOf(glyphIndex);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, [glyphIndex]);
    } else {
      existing.push(glyphIndex);
    }
  }

  const groups = Array.from(byKey.values());
  groups.sort((a, b) => {
    const clusterA = Math.min(...a.map((i) => (glyphs[i] as PositionedGlyph).cluster));
    const clusterB = Math.min(...b.map((i) => (glyphs[i] as PositionedGlyph).cluster));
    return clusterA - clusterB;
  });

  return groups.map((group, index) => ({ index, glyphIndices: group }));
}

function splitByLine(glyphs: readonly PositionedGlyph[]): TextUnit[] {
  const byLine = new Map<number, number[]>();
  glyphs.forEach((glyph, i) => {
    const existing = byLine.get(glyph.lineIndex);
    if (existing === undefined) {
      byLine.set(glyph.lineIndex, [i]);
    } else {
      existing.push(i);
    }
  });

  const lineIndices = Array.from(byLine.keys()).sort((a, b) => a - b);
  return lineIndices.map((lineIndex, index) => ({
    index,
    glyphIndices: byLine.get(lineIndex) as number[],
  }));
}

function splitByWord(glyphs: readonly PositionedGlyph[]): TextUnit[] {
  const allIndices = glyphs.map((_glyph, i) => i);
  return groupByReadingOrder(glyphs, allIndices, (i) => {
    const glyph = glyphs[i] as PositionedGlyph;
    return `${glyph.lineIndex}:${glyph.wordIndex}`;
  });
}

function splitByCharacter(glyphs: readonly PositionedGlyph[]): TextUnit[] {
  const allIndices = glyphs.map((_glyph, i) => i);
  return groupByReadingOrder(glyphs, allIndices, (i) => {
    const glyph = glyphs[i] as PositionedGlyph;
    return `${glyph.lineIndex}:${glyph.cluster}`;
  });
}

/**
 * Grapheme grouping needs each glyph's own line's source text, to run
 * Unicode grapheme segmentation (`Intl.Segmenter`) over it: `lineTexts[i]`
 * must be the exact string `PositionedGlyph.cluster` for a glyph with
 * `lineIndex === i` is itself relative to. For `prepareTextRenderData`'s
 * own pipeline (the only one currently wired to `TextNode` rendering),
 * that is `content.split("\n")[i]` (`computeGlyphLayout` shapes each such
 * line independently, so `cluster` resets per line - see `shapeText`'s own
 * doc on cluster rebasing). A future caller driven by the word-wrapped
 * paragraph engine instead would need to pass each *rendered* line's own
 * substring; this function does not care which pipeline produced it, only
 * that the contract holds.
 */
function splitByGrapheme(glyphs: readonly PositionedGlyph[], lineTexts: readonly string[]): TextUnit[] {
  const segmentStartsByLine = new Map<number, number[]>();
  const allIndices = glyphs.map((_glyph, i) => i);

  return groupByReadingOrder(glyphs, allIndices, (i) => {
    const glyph = glyphs[i] as PositionedGlyph;
    let starts = segmentStartsByLine.get(glyph.lineIndex);
    if (starts === undefined) {
      const lineText = lineTexts[glyph.lineIndex] ?? "";
      starts = graphemeSegmentStarts(lineText);
      segmentStartsByLine.set(glyph.lineIndex, starts);
    }
    const graphemeStart = segmentStartAtOrBefore(starts, glyph.cluster);
    return `${glyph.lineIndex}:${graphemeStart}`;
  });
}

/**
 * Splits `glyphs` (a `TextRenderData`/`ParagraphRenderData`'s own glyph
 * array) into units at `granularity`, respecting shaping clusters
 * throughout: `"character"` never separates a multi-glyph cluster (e.g. a
 * base letter and its combining mark, attached via GPOS, or a ligature's
 * source characters), and `"grapheme"` additionally never separates
 * multiple clusters that together form one Unicode grapheme (e.g. a ZWJ
 * emoji sequence HarfBuzz happened to shape as more than one cluster).
 * `"word"`/`"line"` reuse the same boundaries `build-text-group.ts`'s own
 * rendering hierarchy already groups by.
 *
 * `lineTexts` is required for `"grapheme"` (see `splitByGrapheme`'s own
 * doc for the exact contract) and ignored otherwise.
 *
 * Deterministic and side-effect-free: the same `glyphs` (plus `lineTexts`,
 * when relevant) always splits into the same units, since it is a pure
 * function of already-shaped, already-laid-out data.
 */
export function splitTextUnits(
  glyphs: readonly PositionedGlyph[],
  granularity: TextUnitGranularity,
  lineTexts?: readonly string[],
): TextUnit[] {
  switch (granularity) {
    case "line":
      return splitByLine(glyphs);
    case "word":
      return splitByWord(glyphs);
    case "character":
      return splitByCharacter(glyphs);
    case "grapheme":
      if (lineTexts === undefined) {
        throw new Error("splitTextUnits: lineTexts is required for granularity \"grapheme\".");
      }
      return splitByGrapheme(glyphs, lineTexts);
  }
}
