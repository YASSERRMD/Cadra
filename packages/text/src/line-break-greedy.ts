import type { ParagraphWord } from "./paragraph-words.js";

/** One line's word range: `words.slice(wordStart, wordEnd)`. */
export interface LineBreak {
  wordStart: number;
  wordEnd: number;
}

/**
 * Packs `words` onto lines greedily: keep adding words to the current line
 * while it still fits within `maxWidth` (including the single-space gap
 * before each non-first word on the line), and break before the first word
 * that would not fit. A word wider than `maxWidth` on its own still gets
 * its own line rather than looping forever, since this engine never breaks
 * inside a word (see the module doc on why: no character-level breaking).
 *
 * `words.length === 0` still produces one (empty) line, matching Phase 44's
 * precedent that a source line with no content is still a real, counted
 * line rather than disappearing.
 */
export function computeGreedyLineBreaks(words: readonly ParagraphWord[], maxWidth: number): LineBreak[] {
  if (words.length === 0) {
    return [{ wordStart: 0, wordEnd: 0 }];
  }

  const lines: LineBreak[] = [];
  let lineStart = 0;
  let lineWidth = 0;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as ParagraphWord;
    const gapBeforeThisWord = i > lineStart ? (words[i - 1] as ParagraphWord).trailingWhitespace : 0;
    const widthIfAdded = lineWidth + gapBeforeThisWord + word.advance;

    if (i > lineStart && widthIfAdded > maxWidth) {
      lines.push({ wordStart: lineStart, wordEnd: i });
      lineStart = i;
      lineWidth = word.advance;
    } else {
      lineWidth = widthIfAdded;
    }
  }
  lines.push({ wordStart: lineStart, wordEnd: words.length });

  return lines;
}
