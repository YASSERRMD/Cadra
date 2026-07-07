import type { ColorRGBA } from "@cadra/core";

import { isRtlLevel, resolveBidi, type TextDirection } from "./bidi-resolution.js";
import { charAtClusterStart } from "./glyph-layout.js";
import { shapeRun } from "./harfbuzz-shaping.js";
import { combineSpans, splitRunsByStyle } from "./inline-style-runs.js";
import type { InlineTextStyle, ParagraphSpan } from "./inline-text-style.js";
import { computeGreedyLineBreaks, type LineBreak } from "./line-break-greedy.js";
import { computeKnuthPlassLineBreaks } from "./line-break-knuth-plass.js";
import { computeLineWidth, type ParagraphWord,segmentParagraphWords } from "./paragraph-words.js";
import type { ParsedFont } from "./parsed-font.js";
import { computeItemizedRuns } from "./script-runs.js";
import { unicodeScriptToIso15924 } from "./script-tags.js";
import type { ShapedTextRun } from "./shaped-run.js";
import { reorderRunsToVisualOrder } from "./visual-run-order.js";
import { isWhitespaceChar } from "./whitespace.js";

/** A paragraph's own text alignment, direction-relative for `"start"`/`"end"` (see this module's doc). */
export type ParagraphAlign = "start" | "end" | "center" | "justify";

export interface ParagraphLayoutOptions {
  /** The paragraph's base font; a span's own `style.font` overrides it for that span only. */
  font: ParsedFont;
  /** Line-wrap width, in em units (the same units every other measurement in this module uses). */
  maxWidth: number;
  /** Defaults to `"start"`. */
  align?: ParagraphAlign;
  /** Forces the paragraph's base direction instead of auto-detecting it from the text's first strong character. */
  direction?: TextDirection;
  /** Em-unit line-to-line baseline spacing. Defaults to `(ascent - descent + lineGap) / unitsPerEm` from `font`'s own metrics. */
  lineHeight?: number;
  /** Extra em-unit gap between blank-line-separated paragraph blocks (two or more consecutive `"\n"`), on top of `lineHeight`. Defaults to `0`. */
  paragraphSpacing?: number;
  /** OpenType feature toggles applied to every span that does not specify its own. */
  features?: Readonly<Record<string, boolean>>;
  /**
   * Use Knuth-Plass (whole-paragraph-optimal) line breaking instead of
   * greedy. Defaults to `true` when `align` is `"justify"` (justification
   * looks best over a globally balanced breakdown) and `false` otherwise.
   */
  useKnuthPlass?: boolean;
}

/** One shaped, positioned, already em-normalized glyph, ready for atlas lookup: the sync half of paragraph layout's own output, before the (async) atlas step resolves it to a quad. */
export interface PrePlacedGlyph {
  glyphId: number;
  cluster: number;
  lineIndex: number;
  wordIndex: number;
  /** Accumulated pen position before this glyph's own offset, in em units (already scaled by its span's `fontSizeScale`). */
  penX: number;
  penY: number;
  /** This glyph's own shaped offset from the pen, already normalized to (scaled) em units. */
  xOffset: number;
  yOffset: number;
  /** This glyph's own final advance (already normalized, tracked, and, for a justified line, stretched), in em units: how far the pen moved after this glyph. Exposed mainly for measuring a line's own rendered width (e.g. verifying justification actually reaches `maxWidth`), since placement itself only needs `penX`/`penY`. */
  xAdvance: number;
  yAdvance: number;
  /** This glyph's span's `fontSizeScale`, needed again at atlas-quad time (the atlas's own placement data has no notion of it; see `placeGlyphQuad`'s own doc). */
  scale: number;
  /** Which font (and so which atlas) this glyph belongs to. */
  font: ParsedFont;
  color?: ColorRGBA;
}

export interface ParagraphLineMetrics {
  lineIndex: number;
  /** This line's baseline, in em units (line 0 is at `y = 0`; later lines descend, matching `computeGlyphLayout`'s own convention). */
  baselineY: number;
  /** This line's own natural (pre-alignment, pre-justification-stretch) content width, in em units. */
  naturalWidth: number;
}

export interface ParagraphLinesLayout {
  glyphs: readonly PrePlacedGlyph[];
  lineCount: number;
  lines: readonly ParagraphLineMetrics[];
}

/** One resolved style, with every field defaulted against the paragraph's own base options. */
interface ResolvedSpanStyle {
  font: ParsedFont;
  scale: number;
  color: ColorRGBA | undefined;
  tracking: number;
  features: Readonly<Record<string, boolean>> | undefined;
}

function resolveSpanStyle(
  style: InlineTextStyle | undefined,
  baseFont: ParsedFont,
  baseFeatures: Readonly<Record<string, boolean>> | undefined,
): ResolvedSpanStyle {
  return {
    font: style?.font ?? baseFont,
    scale: style?.fontSizeScale ?? 1,
    color: style?.color,
    tracking: style?.tracking ?? 0,
    features: style?.features ?? baseFeatures,
  };
}

/** One logically-shaped, already em-normalized run, carrying its own resolved style through to placement. */
interface NormalizedStyledRun extends ShapedTextRun {
  font: ParsedFont;
  scale: number;
  color: ColorRGBA | undefined;
}

/** A plain text slice plus which span produced each of its characters (a sub-range of `CombinedSpans`, sharing its indexing). */
interface TextSlice {
  text: string;
  styleIndexForChar: readonly number[];
}

/** Splits `combined` on runs of two or more consecutive `"\n"` (blank-line paragraph separators): `paragraphSpacing` applies between the resulting blocks. */
function splitIntoBlocks(combined: { text: string; styleIndexForChar: readonly number[] }): TextSlice[] {
  const { text, styleIndexForChar } = combined;
  const blocks: TextSlice[] = [];
  const separator = /\n{2,}/g;
  let cursor = 0;
  for (const match of text.matchAll(separator)) {
    blocks.push({ text: text.slice(cursor, match.index), styleIndexForChar: styleIndexForChar.slice(cursor, match.index) });
    cursor = match.index + match[0].length;
  }
  blocks.push({ text: text.slice(cursor), styleIndexForChar: styleIndexForChar.slice(cursor) });
  return blocks;
}

/** Splits one block on single `"\n"` characters: each is its own bidi paragraph and its own forced line break, matching `prepareTextRenderData`'s existing per-explicit-newline convention. */
function splitBlockIntoHardBreakLines(block: TextSlice): TextSlice[] {
  const lines: TextSlice[] = [];
  let cursor = 0;
  for (let i = 0; i <= block.text.length; i += 1) {
    if (i === block.text.length || block.text[i] === "\n") {
      lines.push({ text: block.text.slice(cursor, i), styleIndexForChar: block.styleIndexForChar.slice(cursor, i) });
      cursor = i + 1;
    }
  }
  return lines;
}

/**
 * Resolves bidi, itemizes by script and inline-style-span boundary, and
 * shapes each resulting run with its own resolved font/features - then
 * normalizes every glyph's advance/offset to (already `fontSizeScale`- and
 * `tracking`-adjusted) em units, so every later step in this module can
 * treat every run uniformly regardless of how many distinct fonts or sizes
 * its spans used.
 */
function shapeHardBreakLine(
  lineText: string,
  styleIndexForChar: readonly number[],
  spans: readonly ParagraphSpan[],
  baseFont: ParsedFont,
  baseFeatures: Readonly<Record<string, boolean>> | undefined,
  forcedDirection: TextDirection | undefined,
): { logicalRuns: NormalizedStyledRun[]; paragraphLevel: number } {
  const bidiResolution = resolveBidi(lineText, forcedDirection);
  const itemizedRuns = computeItemizedRuns(lineText, bidiResolution.levels);
  const styledRuns = splitRunsByStyle(itemizedRuns, styleIndexForChar);

  const logicalRuns = styledRuns.map((run): NormalizedStyledRun => {
    const span = spans[run.styleIndex];
    const style = resolveSpanStyle(span?.style, baseFont, baseFeatures);
    const runText = lineText.slice(run.start, run.end);
    const unitsPerEm = style.font.metrics.unitsPerEm;

    const glyphs = shapeRun(style.font, runText, {
      script: unicodeScriptToIso15924(run.script),
      direction: run.direction,
      features: style.features,
    }).map((glyph) => ({
      glyphId: glyph.glyphId,
      cluster: glyph.cluster + run.start,
      xAdvance: (glyph.xAdvance / unitsPerEm) * style.scale + style.tracking,
      yAdvance: (glyph.yAdvance / unitsPerEm) * style.scale,
      xOffset: (glyph.xOffset / unitsPerEm) * style.scale,
      yOffset: (glyph.yOffset / unitsPerEm) * style.scale,
      flags: glyph.flags,
    }));

    return {
      start: run.start,
      end: run.end,
      text: runText,
      script: run.script,
      direction: run.direction,
      level: run.level,
      glyphs,
      font: style.font,
      scale: style.scale,
      color: style.color,
    };
  });

  const paragraphLevel = bidiResolution.paragraphs[0]?.level ?? 0;
  return { logicalRuns, paragraphLevel };
}

/** Intersects `runs` (logical order) against `[rangeStart, rangeEnd)`, filtering each run's own glyphs by cluster value (correct regardless of a right-to-left run's own visual-order glyph array; see `paragraph-words.ts`'s own note). Runs with no glyphs left in range are dropped. */
function sliceRunsToRange(
  runs: readonly NormalizedStyledRun[],
  rangeStart: number,
  rangeEnd: number,
  fullText: string,
): NormalizedStyledRun[] {
  const result: NormalizedStyledRun[] = [];
  for (const run of runs) {
    if (run.end <= rangeStart || run.start >= rangeEnd) {
      continue;
    }
    const glyphs = run.glyphs.filter((glyph) => glyph.cluster >= rangeStart && glyph.cluster < rangeEnd);
    if (glyphs.length === 0) {
      continue;
    }
    const newStart = Math.max(run.start, rangeStart);
    const newEnd = Math.min(run.end, rangeEnd);
    result.push({ ...run, start: newStart, end: newEnd, text: fullText.slice(newStart, newEnd), glyphs });
  }
  return result;
}

/**
 * The pen-start offset for one line, direction-relative for `"start"`/
 * `"end"`: a right-to-left paragraph's `"start"` is its right edge (this
 * line's content flush against `maxWidth`), matching how `"start"`/`"end"`
 * mean physically opposite edges depending on writing direction in real
 * typography (as opposed to `"center"`, direction-independent, or
 * `"justify"`, handled by its own caller since a justified line's offset is
 * always `0` - both edges touch once its interior gaps are stretched to
 * fill `maxWidth` exactly).
 */
function computeAlignmentOffset(
  align: "start" | "end" | "center",
  naturalWidth: number,
  maxWidth: number,
  isRtlBase: boolean,
): number {
  const remaining = maxWidth - naturalWidth;
  switch (align) {
    case "start":
      return isRtlBase ? remaining : 0;
    case "end":
      return isRtlBase ? 0 : remaining;
    case "center":
      return remaining / 2;
  }
}

/** Extra em-unit advance to inject at each interior word gap's own whitespace cluster, distributing `maxWidth - naturalWidth` evenly, so the line's total width becomes exactly `maxWidth`. Empty when there is nothing to stretch (a single-word line) or nothing to add (the line already meets or exceeds `maxWidth`, never shrunk). */
function computeJustificationExtraPerCluster(
  words: readonly ParagraphWord[],
  line: LineBreak,
  maxWidth: number,
): ReadonlyMap<number, number> {
  const gapCount = line.wordEnd - line.wordStart - 1;
  const map = new Map<number, number>();
  if (gapCount <= 0) {
    return map;
  }
  const extraTotal = maxWidth - computeLineWidth(words, line);
  if (extraTotal <= 0) {
    return map;
  }
  const perGap = extraTotal / gapCount;
  for (let i = line.wordStart; i < line.wordEnd - 1; i += 1) {
    const word = words[i] as ParagraphWord;
    map.set(word.end, perGap);
  }
  return map;
}

function computeDefaultLineHeight(font: ParsedFont): number {
  const metrics = font.metrics;
  return (metrics.ascent - metrics.descent + metrics.lineGap) / metrics.unitsPerEm;
}

/**
 * Lays out a paragraph's inline-styled spans into positioned, em-space,
 * atlas-independent glyphs: bidi resolution, script and style itemization,
 * shaping, word segmentation, line breaking (greedy or Knuth-Plass),
 * direction-aware alignment and justification, all the way to a per-glyph
 * pen position - everything except the final MSDF atlas lookup, which
 * `prepareParagraphRenderData` (this module's async counterpart, since
 * atlas generation is async) resolves separately. Kept synchronous and
 * atlas-free on purpose: line breaking, justification spacing, and
 * direction handling are all pure functions of shaped glyph advances, so
 * they are directly and cheaply testable without ever touching the (slow,
 * wasm-backed) atlas pipeline.
 *
 * Mirrors `prepareTextRenderData`'s existing convention that every `"\n"`
 * forces a line break and starts its own bidi paragraph, adding: soft
 * wrapping within each such forced line (`maxWidth`), and blank-line
 * (two-or-more-consecutive-`"\n"`) paragraph blocks getting `paragraphSpacing`
 * on top of the normal `lineHeight` between their own last and next first line.
 */
export function layoutParagraphLines(
  spans: readonly ParagraphSpan[],
  options: ParagraphLayoutOptions,
): ParagraphLinesLayout {
  const align = options.align ?? "start";
  const useKnuthPlass = options.useKnuthPlass ?? align === "justify";
  const lineHeight = options.lineHeight ?? computeDefaultLineHeight(options.font);
  const paragraphSpacing = options.paragraphSpacing ?? 0;
  const maxWidth = options.maxWidth;

  const blocks = splitIntoBlocks(combineSpans(spans));

  const glyphs: PrePlacedGlyph[] = [];
  const lines: ParagraphLineMetrics[] = [];
  let globalLineIndex = 0;
  let baselineY = 0;

  blocks.forEach((block, blockIndex) => {
    if (blockIndex > 0) {
      baselineY -= paragraphSpacing;
    }

    for (const hardBreakLine of splitBlockIntoHardBreakLines(block)) {
      const { logicalRuns, paragraphLevel } = shapeHardBreakLine(
        hardBreakLine.text,
        hardBreakLine.styleIndexForChar,
        spans,
        options.font,
        options.features,
        options.direction,
      );
      const isRtlBase = isRtlLevel(paragraphLevel);
      const words = segmentParagraphWords(hardBreakLine.text, logicalRuns, 1);
      const wrappedLines = useKnuthPlass
        ? computeKnuthPlassLineBreaks(words, maxWidth)
        : computeGreedyLineBreaks(words, maxWidth);

      wrappedLines.forEach((line, indexWithinHardBreakLine) => {
        const isLastOfHardBreakLine = indexWithinHardBreakLine === wrappedLines.length - 1;
        const naturalWidth = computeLineWidth(words, line);
        const hasWords = line.wordStart < line.wordEnd;
        const rangeStart = hasWords ? (words[line.wordStart] as ParagraphWord).start : 0;
        const rangeEnd = hasWords ? (words[line.wordEnd - 1] as ParagraphWord).end : 0;

        const canJustify = align === "justify" && !isLastOfHardBreakLine && line.wordEnd - line.wordStart > 1;
        const penXStart = canJustify
          ? 0
          : computeAlignmentOffset(align === "justify" ? "start" : align, naturalWidth, maxWidth, isRtlBase);
        const justificationExtraPerCluster = canJustify
          ? computeJustificationExtraPerCluster(words, line, maxWidth)
          : new Map<number, number>();

        const visualRuns = reorderRunsToVisualOrder(sliceRunsToRange(logicalRuns, rangeStart, rangeEnd, hardBreakLine.text));

        let penX = penXStart;
        // Mutable, matching computeGlyphLayout's own convention: a shaped
        // glyph can carry a nonzero yAdvance even in horizontal text (rare,
        // but some scripts/fonts do), so subsequent glyphs on the same line
        // still need to track it rather than assuming the whole line stays
        // pinned to one fixed baseline Y.
        let penY = baselineY;
        let wordIndex = -1;
        let inWord = false;

        for (const run of visualRuns) {
          for (const glyph of run.glyphs) {
            const isWs = isWhitespaceChar(charAtClusterStart(run, glyph.cluster));
            if (isWs) {
              inWord = false;
            } else {
              if (!inWord) {
                wordIndex += 1;
              }
              inWord = true;
            }

            const extra = justificationExtraPerCluster.get(glyph.cluster) ?? 0;
            const finalXAdvance = glyph.xAdvance + extra;

            glyphs.push({
              glyphId: glyph.glyphId,
              cluster: glyph.cluster,
              lineIndex: globalLineIndex,
              wordIndex: Math.max(wordIndex, 0),
              penX,
              penY,
              xOffset: glyph.xOffset,
              yOffset: glyph.yOffset,
              xAdvance: finalXAdvance,
              yAdvance: glyph.yAdvance,
              scale: run.scale,
              font: run.font,
              color: run.color,
            });

            penX += finalXAdvance;
            penY += glyph.yAdvance;
          }
        }

        lines.push({ lineIndex: globalLineIndex, baselineY, naturalWidth });
        globalLineIndex += 1;
        baselineY -= lineHeight;
      });
    }
  });

  return { glyphs, lineCount: globalLineIndex, lines };
}
