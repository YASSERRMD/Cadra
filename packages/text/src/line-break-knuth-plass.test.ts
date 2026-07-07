import { describe, expect, it } from "vitest";

import { computeGreedyLineBreaks, type LineBreak } from "./line-break-greedy.js";
import { computeKnuthPlassLineBreaks } from "./line-break-knuth-plass.js";
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

/** Sum of squared slack across every line except the last (which typographic convention never penalizes for raggedness), the same quantity computeKnuthPlassLineBreaks minimizes. */
function totalNonLastLineBadness(w: readonly ParagraphWord[], lines: readonly LineBreak[], maxWidth: number): number {
  let total = 0;
  lines.forEach((line, index) => {
    if (index === lines.length - 1) {
      return;
    }
    const slack = maxWidth - computeLineWidth(w, line);
    total += slack * slack;
  });
  return total;
}

describe("computeKnuthPlassLineBreaks", () => {
  it("keeps every word on one line when it all fits within maxWidth", () => {
    const w = words([{ advance: 3 }, { advance: 3 }, { advance: 3, trailingWhitespace: 0 }]);
    expect(computeKnuthPlassLineBreaks(w, 100)).toEqual([{ wordStart: 0, wordEnd: 3 }]);
  });

  it("gives an over-wide single word its own line instead of failing", () => {
    const w = words([{ advance: 3 }, { advance: 50 }, { advance: 3, trailingWhitespace: 0 }]);
    const lines = computeKnuthPlassLineBreaks(w, 10);
    expect(lines.every((line) => line.wordEnd - line.wordStart >= 1)).toBe(true);
    // Every word is covered by exactly one line, in order.
    expect(lines[0]?.wordStart).toBe(0);
    expect(lines[lines.length - 1]?.wordEnd).toBe(3);
    for (let i = 1; i < lines.length; i += 1) {
      expect(lines[i]?.wordStart).toBe(lines[i - 1]?.wordEnd);
    }
  });

  it("produces one empty line for an empty word list", () => {
    expect(computeKnuthPlassLineBreaks([], 100)).toEqual([{ wordStart: 0, wordEnd: 0 }]);
  });

  it("packs every word onto one line when maxWidth is unbounded", () => {
    const w = words([{ advance: 100 }, { advance: 200 }, { advance: 300, trailingWhitespace: 0 }]);
    expect(computeKnuthPlassLineBreaks(w, Infinity)).toEqual([{ wordStart: 0, wordEnd: 3 }]);
  });

  it("achieves total non-last-line badness no worse than greedy breaking on the same words", () => {
    // Seven width-5 words (gap 1) followed by one width-20 word that can
    // never share a line with anything (it alone already exceeds
    // maxWidth): three width-5 words fit a line exactly (5*3 + 1*2 = 17),
    // so greedy's first-fit strategy always takes 3, leaving a lopsided
    // 3+3+1 split of the seven; a globally balanced 3+2+2 (or equivalent)
    // split has much lower total squared slack. This is exactly the case
    // greedy cannot recover from (it never reconsiders an earlier line)
    // and Knuth-Plass's whole-paragraph optimization is for.
    const w = words([
      { advance: 5 },
      { advance: 5 },
      { advance: 5 },
      { advance: 5 },
      { advance: 5 },
      { advance: 5 },
      { advance: 5 },
      { advance: 20, trailingWhitespace: 0 },
    ]);
    const maxWidth = 17;

    const greedyLines = computeGreedyLineBreaks(w, maxWidth);
    const knuthPlassLines = computeKnuthPlassLineBreaks(w, maxWidth);

    // Sanity: both cover the same 8 words start-to-end with no gaps.
    for (const lines of [greedyLines, knuthPlassLines]) {
      expect(lines[0]?.wordStart).toBe(0);
      expect(lines[lines.length - 1]?.wordEnd).toBe(8);
    }

    const greedyBadness = totalNonLastLineBadness(w, greedyLines, maxWidth);
    const knuthPlassBadness = totalNonLastLineBadness(w, knuthPlassLines, maxWidth);
    expect(knuthPlassBadness).toBeLessThan(greedyBadness);
  });

  it("never produces a worse total non-last-line badness than greedy across varied word widths", () => {
    // A broader spot-check across several width patterns and maxWidths:
    // Knuth-Plass is a global optimizer over the same badness greedy is a
    // local (first-fit) heuristic for, so it can never do worse.
    const scenarios: Array<{ widths: number[]; maxWidth: number }> = [
      { widths: [4, 6, 3, 8, 2, 7, 5, 9, 1, 6], maxWidth: 15 },
      { widths: [10, 2, 2, 2, 10, 2, 2, 10], maxWidth: 14 },
      { widths: [3, 3, 3, 3, 3, 3, 3, 3, 3], maxWidth: 10 },
      { widths: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], maxWidth: 5 },
    ];

    for (const scenario of scenarios) {
      const w = words(scenario.widths.map((advance, index) => ({
        advance,
        trailingWhitespace: index === scenario.widths.length - 1 ? 0 : 1,
      })));
      const greedyLines = computeGreedyLineBreaks(w, scenario.maxWidth);
      const knuthPlassLines = computeKnuthPlassLineBreaks(w, scenario.maxWidth);

      const greedyBadness = totalNonLastLineBadness(w, greedyLines, scenario.maxWidth);
      const knuthPlassBadness = totalNonLastLineBadness(w, knuthPlassLines, scenario.maxWidth);
      expect(knuthPlassBadness).toBeLessThanOrEqual(greedyBadness + 1e-9);
    }
  });
});
