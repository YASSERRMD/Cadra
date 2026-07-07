import { describe, expect, it } from "vitest";

import { computeGreedyLineBreaks } from "./line-break-greedy.js";
import { computeLineWidth, type ParagraphWord } from "./paragraph-words.js";

/** Builds a synthetic word list from plain widths, for testing the breaking algorithm in isolation from real shaping. */
function words(specs: ReadonlyArray<{ advance: number; trailingWhitespace?: number }>): ParagraphWord[] {
  let cursor = 0;
  return specs.map((spec) => {
    const start = cursor;
    cursor += 1;
    const end = cursor;
    cursor += 1;
    return { start, end, advance: spec.advance, trailingWhitespace: spec.trailingWhitespace ?? 1 };
  });
}

describe("computeGreedyLineBreaks", () => {
  it("keeps every word on one line when it all fits within maxWidth", () => {
    const w = words([{ advance: 3 }, { advance: 3 }, { advance: 3, trailingWhitespace: 0 }]);
    const lines = computeGreedyLineBreaks(w, 100);
    expect(lines).toEqual([{ wordStart: 0, wordEnd: 3 }]);
  });

  it("breaks before the first word that would overflow maxWidth", () => {
    // Three words of width 4 each with a 1-unit gap: "4 4 4" needs width
    // 4+1+4+1+4 = 14 to fit on one line. With maxWidth 10, only the first
    // two (4+1+4=9) fit; the third starts a new line.
    const w = words([{ advance: 4 }, { advance: 4 }, { advance: 4, trailingWhitespace: 0 }]);
    const lines = computeGreedyLineBreaks(w, 10);
    expect(lines).toEqual([
      { wordStart: 0, wordEnd: 2 },
      { wordStart: 2, wordEnd: 3 },
    ]);
  });

  it("wraps one word per line when every word barely exceeds half of maxWidth", () => {
    const w = words([{ advance: 6 }, { advance: 6 }, { advance: 6, trailingWhitespace: 0 }]);
    const lines = computeGreedyLineBreaks(w, 10);
    expect(lines).toEqual([
      { wordStart: 0, wordEnd: 1 },
      { wordStart: 1, wordEnd: 2 },
      { wordStart: 2, wordEnd: 3 },
    ]);
  });

  it("gives an over-wide single word its own line instead of looping forever", () => {
    const w = words([{ advance: 3 }, { advance: 50 }, { advance: 3, trailingWhitespace: 0 }]);
    const lines = computeGreedyLineBreaks(w, 10);
    expect(lines).toEqual([
      { wordStart: 0, wordEnd: 1 },
      { wordStart: 1, wordEnd: 2 },
      { wordStart: 2, wordEnd: 3 },
    ]);
  });

  it("produces one empty line for an empty word list", () => {
    expect(computeGreedyLineBreaks([], 100)).toEqual([{ wordStart: 0, wordEnd: 0 }]);
  });

  it("never produces a line whose natural width exceeds maxWidth, except a single over-wide word", () => {
    const w = words([
      { advance: 5 },
      { advance: 2 },
      { advance: 7 },
      { advance: 1 },
      { advance: 9, trailingWhitespace: 0 },
    ]);
    const maxWidth = 12;
    const lines = computeGreedyLineBreaks(w, maxWidth);
    for (const line of lines) {
      const isSingleWord = line.wordEnd - line.wordStart === 1;
      const width = computeLineWidth(w, line);
      if (!isSingleWord) {
        expect(width).toBeLessThanOrEqual(maxWidth);
      }
    }
  });

  it("packs every word onto one line when maxWidth is unbounded", () => {
    const w = words([{ advance: 100 }, { advance: 200 }, { advance: 300, trailingWhitespace: 0 }]);
    expect(computeGreedyLineBreaks(w, Infinity)).toEqual([{ wordStart: 0, wordEnd: 3 }]);
  });
});
