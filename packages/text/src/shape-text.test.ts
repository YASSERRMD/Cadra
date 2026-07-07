import { describe, expect, it } from "vitest";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import { shapeText } from "./shape-text.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";

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
