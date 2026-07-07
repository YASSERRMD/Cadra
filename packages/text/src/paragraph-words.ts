import type { ShapedTextRun } from "./shaped-run.js";
import { isWhitespaceChar } from "./whitespace.js";

/**
 * One breakable unit for paragraph line breaking: a maximal run of
 * non-whitespace characters, plus the whitespace immediately following it
 * (the gap a line break can land in). `start`/`end` are UTF-16 indices into
 * the paragraph segment's own source text, the same cluster domain
 * `ShapedTextRun.start`/`end` and `ShapedGlyph.cluster` use, so a line's
 * chosen word range slices directly against the original shaped runs with
 * no further translation.
 */
export interface ParagraphWord {
  start: number;
  end: number;
  /** This word's own glyphs' total advance, in em units. Excludes `trailingWhitespace`. */
  advance: number;
  /** The em-unit advance of the whitespace run immediately after this word, `0` for the segment's last word (nothing trails it). */
  trailingWhitespace: number;
}

interface WhitespaceToken {
  start: number;
  end: number;
  isWhitespace: boolean;
}

/** Splits `text` into maximal alternating whitespace/non-whitespace spans, in logical order. */
function tokenizeByWhitespace(text: string): WhitespaceToken[] {
  const tokens: WhitespaceToken[] = [];
  let i = 0;
  while (i < text.length) {
    const isWs = isWhitespaceChar(text[i] ?? "");
    let j = i + 1;
    while (j < text.length && isWhitespaceChar(text[j] ?? "") === isWs) {
      j += 1;
    }
    tokens.push({ start: i, end: j, isWhitespace: isWs });
    i = j;
  }
  return tokens;
}

/**
 * Segments one mandatory-break-free paragraph segment's shaped text into
 * breakable words. `logicalRuns` must be `shapeLogicalRuns`'s output for
 * `text` (any order works, including logical order): each glyph's own
 * `xAdvance` is bucketed into whichever whitespace-delimited token its
 * `cluster` falls in by value, independent of the glyph array's own
 * traversal order (which, for a right-to-left run, walks clusters in
 * *decreasing* order - see `shaped-run.ts`'s own note on HarfBuzz's visual-
 * order glyph output), so this correctly measures word widths regardless of
 * any run's direction.
 */
export function segmentParagraphWords(
  text: string,
  logicalRuns: readonly ShapedTextRun[],
  unitsPerEm: number,
): ParagraphWord[] {
  if (text.length === 0) {
    return [];
  }
  const tokens = tokenizeByWhitespace(text);

  const tokenIndexForChar: number[] = new Array(text.length);
  tokens.forEach((token, index) => {
    for (let i = token.start; i < token.end; i += 1) {
      tokenIndexForChar[i] = index;
    }
  });

  const advanceByToken: number[] = new Array(tokens.length).fill(0);
  for (const run of logicalRuns) {
    for (const glyph of run.glyphs) {
      const tokenIndex = tokenIndexForChar[glyph.cluster];
      if (tokenIndex !== undefined) {
        advanceByToken[tokenIndex] = (advanceByToken[tokenIndex] as number) + glyph.xAdvance / unitsPerEm;
      }
    }
  }

  const words: ParagraphWord[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as WhitespaceToken;
    if (token.isWhitespace) {
      continue;
    }

    // A word's own leading whitespace only matters for this segment's very
    // first word: nothing can break a line before the first character
    // exists, so any leading whitespace is folded into the first word's own
    // start/advance instead of modeled as a breakable gap (every other
    // word's leading whitespace is already the previous word's own
    // `trailingWhitespace`).
    const isFirstWord = words.length === 0;
    const hasLeadingWhitespace = isFirstWord && i > 0;
    const start = hasLeadingWhitespace ? 0 : token.start;
    const leadingAdvance = hasLeadingWhitespace ? (advanceByToken[i - 1] as number) : 0;

    const nextToken = tokens[i + 1];
    const trailingWhitespace = nextToken?.isWhitespace === true ? (advanceByToken[i + 1] as number) : 0;

    words.push({
      start,
      end: token.end,
      advance: leadingAdvance + (advanceByToken[i] as number),
      trailingWhitespace,
    });
  }
  return words;
}

/** A contiguous word range, matching `LineBreak`'s own shape (`line-break-greedy.ts`/`line-break-knuth-plass.ts`) without importing either (both instead depend on this module). */
export interface WordRange {
  wordStart: number;
  wordEnd: number;
}

/**
 * The natural (unjustified) width of `words.slice(line.wordStart, line.wordEnd)`:
 * every word's own advance, plus the interior gaps between them, excluding
 * the trailing whitespace after the line's last word (a line never renders
 * the whitespace it broke on). Shared by both line breakers' own tests and
 * the paragraph layout engine, which needs this same width to compute
 * alignment offsets and justification spacing.
 */
export function computeLineWidth(words: readonly ParagraphWord[], line: WordRange): number {
  let width = 0;
  for (let i = line.wordStart; i < line.wordEnd; i += 1) {
    const word = words[i] as ParagraphWord;
    width += word.advance;
    if (i < line.wordEnd - 1) {
      width += word.trailingWhitespace;
    }
  }
  return width;
}
