import { describe, expect, it } from "vitest";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import { segmentParagraphWords } from "./paragraph-words.js";
import { shapeLogicalRuns } from "./shape-text.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";

const ROBOTO_FLEX = parseFontWithFontkit(loadFixtureFont("RobotoFlex-Variable"));
const NOTO_SANS_ARABIC = parseFontWithFontkit(loadFixtureFont("NotoSansArabic-Variable"));

/** Sums every glyph's own advance across every run, in em units: a ground-truth total width independent of word segmentation. */
function totalAdvance(runs: ReturnType<typeof shapeLogicalRuns>, unitsPerEm: number): number {
  let total = 0;
  for (const run of runs) {
    for (const glyph of run.glyphs) {
      total += glyph.xAdvance / unitsPerEm;
    }
  }
  return total;
}

describe("segmentParagraphWords", () => {
  it("segments a simple sentence into words with trailing whitespace, and the last word has none", () => {
    const text = "hello world";
    const runs = shapeLogicalRuns(ROBOTO_FLEX, text);
    const words = segmentParagraphWords(text, runs, ROBOTO_FLEX.metrics.unitsPerEm);

    expect(words).toHaveLength(2);
    expect(words.map((w) => [w.start, w.end])).toEqual([
      [0, 5],
      [6, 11],
    ]);
    expect(words[0]?.trailingWhitespace).toBeGreaterThan(0);
    expect(words[1]?.trailingWhitespace).toBe(0);
  });

  it("every word's own advance plus its trailing whitespace sums to the segment's total advance", () => {
    const text = "hello world again";
    const runs = shapeLogicalRuns(ROBOTO_FLEX, text);
    const words = segmentParagraphWords(text, runs, ROBOTO_FLEX.metrics.unitsPerEm);

    const summed = words.reduce((sum, word) => sum + word.advance + word.trailingWhitespace, 0);
    expect(summed).toBeCloseTo(totalAdvance(runs, ROBOTO_FLEX.metrics.unitsPerEm), 5);
  });

  it("folds leading whitespace into the first word's start and advance rather than losing it", () => {
    const text = "  hello world";
    const runs = shapeLogicalRuns(ROBOTO_FLEX, text);
    const words = segmentParagraphWords(text, runs, ROBOTO_FLEX.metrics.unitsPerEm);

    expect(words[0]?.start).toBe(0);
    expect(words[0]?.end).toBe(7);
    // The first word's advance includes the two leading spaces' own
    // advance, so nothing is silently dropped from the measured total.
    const summed = words.reduce((sum, word) => sum + word.advance + word.trailingWhitespace, 0);
    expect(summed).toBeCloseTo(totalAdvance(runs, ROBOTO_FLEX.metrics.unitsPerEm), 5);
  });

  it("returns no words for a whitespace-only segment", () => {
    const text = "   ";
    const runs = shapeLogicalRuns(ROBOTO_FLEX, text);
    expect(segmentParagraphWords(text, runs, ROBOTO_FLEX.metrics.unitsPerEm)).toEqual([]);
  });

  it("returns no words for an empty segment", () => {
    expect(segmentParagraphWords("", [], ROBOTO_FLEX.metrics.unitsPerEm)).toEqual([]);
  });

  it("measures right-to-left word advances correctly despite HarfBuzz's visual-order glyph array", () => {
    // "مرحبا بك": two Arabic words separated by one space, one single
    // right-to-left ItemizedRun (see shape-text.test.ts's own note that two
    // adjacent right-to-left words never split into separate runs), whose
    // glyph array is in *visual* order (decreasing cluster values) - this
    // proves word measurement sums correctly despite that, since it buckets
    // by cluster value rather than by array traversal order.
    const text = "مرحبا بك";
    const runs = shapeLogicalRuns(NOTO_SANS_ARABIC, text, { direction: "rtl" });
    expect(runs).toHaveLength(1);

    const words = segmentParagraphWords(text, runs, NOTO_SANS_ARABIC.metrics.unitsPerEm);
    expect(words).toHaveLength(2);
    expect(words.map((w) => [w.start, w.end])).toEqual([
      [0, 5],
      [6, 8],
    ]);
    for (const word of words) {
      expect(word.advance).toBeGreaterThan(0);
    }
    const summed = words.reduce((sum, word) => sum + word.advance + word.trailingWhitespace, 0);
    expect(summed).toBeCloseTo(totalAdvance(runs, NOTO_SANS_ARABIC.metrics.unitsPerEm), 5);
  });

  it("treats consecutive interior whitespace as one breakable gap", () => {
    const text = "a    b";
    const runs = shapeLogicalRuns(ROBOTO_FLEX, text);
    const words = segmentParagraphWords(text, runs, ROBOTO_FLEX.metrics.unitsPerEm);

    expect(words.map((w) => [w.start, w.end])).toEqual([
      [0, 1],
      [5, 6],
    ]);
    expect(words[0]?.trailingWhitespace).toBeGreaterThan(0);
  });
});
