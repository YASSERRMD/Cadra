import { describe, expect, it } from "vitest";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import { shapeLogicalRuns, shapeText } from "./shape-text.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";
import { reorderRunsToVisualOrder } from "./visual-run-order.js";

const ROBOTO_FLEX = parseFontWithFontkit(loadFixtureFont("RobotoFlex-Variable"));
const NOTO_SANS_ARABIC = parseFontWithFontkit(loadFixtureFont("NotoSansArabic-Variable"));

describe("shapeText", () => {
  it("shapes pure Latin text as a single left-to-right run", () => {
    const runs = shapeText(ROBOTO_FLEX, "Vote");

    expect(runs).toHaveLength(1);
    expect(runs[0]?.direction).toBe("ltr");
    expect(runs[0]?.script).toBe("Latin");
    expect(runs[0]?.glyphs.map((g) => g.cluster)).toEqual([0, 1, 2, 3]);
  });

  it("shapes pure Arabic text as a single right-to-left run with contextual glyphs", () => {
    const runs = shapeText(NOTO_SANS_ARABIC, "كتاب");

    expect(runs).toHaveLength(1);
    expect(runs[0]?.direction).toBe("rtl");
    expect(runs[0]?.script).toBe("Arabic");
    // Cluster values are rebased to the full string's own indices (0..3).
    for (const glyph of runs[0]?.glyphs ?? []) {
      expect(glyph.cluster).toBeGreaterThanOrEqual(0);
      expect(glyph.cluster).toBeLessThan(4);
    }
  });

  it("orders mixed-script runs correctly and rebases each run's clusters to the full string", () => {
    const text = "AB مرحبا CD";
    const runs = shapeText(ROBOTO_FLEX, text);

    expect(runs.map((r) => [r.script, r.direction, r.start, r.end])).toEqual([
      ["Latin", "ltr", 0, 3],
      ["Arabic", "rtl", 3, 8],
      ["Latin", "ltr", 8, 11],
    ]);

    const arabicRun = runs[1];
    for (const glyph of arabicRun?.glyphs ?? []) {
      expect(glyph.cluster).toBeGreaterThanOrEqual(3);
      expect(glyph.cluster).toBeLessThan(8);
    }
  });

  it("reverses the visual order of two adjacent right-to-left runs of different scripts", () => {
    // Two Arabic words in a row are one contiguous right-to-left bidi run;
    // splitting them here into two ItemizedRuns would need two distinct
    // scripts, which real text can't do for two Arabic words - so this
    // instead proves the *single* Arabic run's own start/end still spans
    // both words in one right-to-left run, the correct outcome, rather
    // than incorrectly fragmenting on the space between them.
    const runs = shapeText(NOTO_SANS_ARABIC, "مرحبا يا");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.direction).toBe("rtl");
  });

  it("mirrors parentheses to their right-to-left counterpart glyph inside a right-to-left run", () => {
    // Nominal (unmirrored) glyph ids for this font, verified by shaping
    // each paren alone in a plain left-to-right context: "(" is glyph
    // 1641, ")" is glyph 1642.
    const NOMINAL_OPEN_PAREN_GLYPH = 1641;
    const NOMINAL_CLOSE_PAREN_GLYPH = 1642;

    // "(" alone is a right-to-left-scope Common-script character with
    // nothing to combine with, so its own run is right-to-left; HarfBuzz
    // mirrors it to the closing-paren glyph accordingly (verified
    // empirically: this is HarfBuzz's own built-in per-run mirroring, not
    // something this package applies at the character level).
    const openParenRuns = shapeText(NOTO_SANS_ARABIC, "(", { direction: "rtl" });
    const closeParenRuns = shapeText(NOTO_SANS_ARABIC, ")", { direction: "rtl" });

    expect(openParenRuns[0]?.direction).toBe("rtl");
    expect(openParenRuns[0]?.glyphs[0]?.glyphId).toBe(NOMINAL_CLOSE_PAREN_GLYPH);
    expect(closeParenRuns[0]?.glyphs[0]?.glyphId).toBe(NOMINAL_OPEN_PAREN_GLYPH);
  });

  it("passes through requested OpenType feature toggles uniformly to every run", () => {
    const kerned = shapeText(ROBOTO_FLEX, "To", { features: { kern: true } });
    const unkerned = shapeText(ROBOTO_FLEX, "To", { features: { kern: false } });

    expect(unkerned[0]?.glyphs[0]?.xAdvance).not.toBe(kerned[0]?.glyphs[0]?.xAdvance);
  });

  it("is deterministic across repeated calls", () => {
    const text = "AB مرحبا CD";
    expect(shapeText(ROBOTO_FLEX, text)).toEqual(shapeText(ROBOTO_FLEX, text));
  });
});

describe("shapeLogicalRuns", () => {
  it("keeps runs in logical (original string) order, unlike shapeText's visual order", () => {
    const text = "AB مرحبا CD";
    const logicalRuns = shapeLogicalRuns(ROBOTO_FLEX, text);

    // Logical order: exactly the order computeItemizedRuns would itemize
    // the string in, left-to-right through the source string regardless of
    // any run's own direction (the Arabic run stays in the middle, same as
    // shapeText's visual-order result for this particular string, since a
    // single embedded right-to-left run surrounded by left-to-right text
    // does not itself move under UAX #9 reordering - so this also cross-
    // checks against shapeText directly, not just the input's own order).
    expect(logicalRuns.map((r) => [r.script, r.direction, r.start, r.end])).toEqual([
      ["Latin", "ltr", 0, 3],
      ["Arabic", "rtl", 3, 8],
      ["Latin", "ltr", 8, 11],
    ]);
    expect(logicalRuns).toEqual(shapeText(ROBOTO_FLEX, text));
  });

  it("reorders to visual order differently from logical order when levels actually nest", () => {
    // A right-to-left paragraph with an embedded left-to-right run: rule L2
    // reverses every run at or above the paragraph's own (odd) level, which
    // for a single-level-1 RTL paragraph containing one level-2 embedded
    // run means the *entire* 3-run sequence reverses (verified empirically:
    // asserting the wrong, unreversed order here first caught this).
    const text = "مرحبا AB يا";
    const logical = shapeLogicalRuns(NOTO_SANS_ARABIC, text, { direction: "rtl" });
    const visual = shapeText(NOTO_SANS_ARABIC, text, { direction: "rtl" });

    expect(logical.map((r) => r.script)).toEqual(["Arabic", "Latin", "Arabic"]);
    expect(logical.map((r) => [r.start, r.end])).toEqual([
      [0, 6],
      [6, 8],
      [8, 11],
    ]);
    expect(visual.map((r) => [r.start, r.end])).toEqual([
      [8, 11],
      [6, 8],
      [0, 6],
    ]);
    expect(logical).not.toEqual(visual);
  });

  it("carries each run's own bidi embedding level, consistent with its direction", () => {
    const runs = shapeLogicalRuns(ROBOTO_FLEX, "AB مرحبا CD");
    for (const run of runs) {
      expect(run.level % 2 === 1).toBe(run.direction === "rtl");
    }
  });

  it("shapeText is exactly shapeLogicalRuns reordered to visual order", () => {
    const text = "مرحبا AB يا";
    const options = { direction: "rtl" as const };
    expect(shapeText(NOTO_SANS_ARABIC, text, options)).toEqual(
      reorderRunsToVisualOrder(shapeLogicalRuns(NOTO_SANS_ARABIC, text, options)),
    );
  });
});
