import { describe, expect, it } from "vitest";

import { parseFontWithFontkit, resolveFontVariationInstance } from "./font-parser-fontkit.js";
import { shapeRun } from "./harfbuzz-shaping.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";

const ROBOTO_FLEX = parseFontWithFontkit(loadFixtureFont("RobotoFlex-Variable"));
const NOTO_SANS_ARABIC = parseFontWithFontkit(loadFixtureFont("NotoSansArabic-Variable"));
const NOTO_SANS_TAMIL = parseFontWithFontkit(loadFixtureFont("NotoSansTamil-Variable"));

describe("shapeRun: Latin kerning and ligatures", () => {
  it("shapes one glyph per character for plain text, in logical cluster order", () => {
    const glyphs = shapeRun(ROBOTO_FLEX, "Vote", { script: "Latn", direction: "ltr" });

    expect(glyphs.map((g) => g.cluster)).toEqual([0, 1, 2, 3]);
    expect(glyphs).toHaveLength(4);
  });

  it("applies kerning: a kerning pair carries the unsafe-to-break glyph flag", () => {
    const glyphs = shapeRun(ROBOTO_FLEX, "To", {
      script: "Latn",
      direction: "ltr",
      features: { kern: true },
    });

    // "To" is a real kerning pair in this font (verified empirically: its
    // advance changes depending on the kern feature); HarfBuzz marks the
    // second glyph of an applied kerning adjustment UNSAFE_TO_BREAK (flag bit 1).
    expect((glyphs[1]?.flags ?? 0) & 1).toBe(1);
  });

  it("disabling kerning removes the kerning-pair flag and changes the advance", () => {
    const kerned = shapeRun(ROBOTO_FLEX, "To", {
      script: "Latn",
      direction: "ltr",
      features: { kern: true },
    });
    const unkerned = shapeRun(ROBOTO_FLEX, "To", {
      script: "Latn",
      direction: "ltr",
      features: { kern: false },
    });

    expect(unkerned[0]?.xAdvance).not.toBe(kerned[0]?.xAdvance);
  });

  it("is deterministic across repeated shape calls", () => {
    const first = shapeRun(ROBOTO_FLEX, "Vote", { script: "Latn", direction: "ltr" });
    const second = shapeRun(ROBOTO_FLEX, "Vote", { script: "Latn", direction: "ltr" });

    expect(second).toEqual(first);
  });

  it("shapes wider and heavier when a variable-font instance with wider/bolder axes is used", () => {
    const bold = resolveFontVariationInstance(ROBOTO_FLEX, { wght: 1000, wdth: 151 });
    const regular = resolveFontVariationInstance(ROBOTO_FLEX, { wght: 400, wdth: 100 });

    const boldGlyphs = shapeRun(bold, "Vote", { script: "Latn", direction: "ltr" });
    const regularGlyphs = shapeRun(regular, "Vote", { script: "Latn", direction: "ltr" });

    expect(boldGlyphs[0]?.xAdvance).toBeGreaterThan(regularGlyphs[0]?.xAdvance as number);
  });
});

describe("shapeRun: Arabic contextual joining", () => {
  // "بيت" (bayt, "house": ba-ya-ta) is spelled entirely with dual-joining
  // letters (unlike words containing alif, which is right-joining-only and
  // so can leave its neighbor in isolated form even mid-word), so every
  // letter here genuinely takes a joined (initial/medial/final) form.
  const CONNECTED_WORD = "بيت";

  it("shapes a connected word to a different glyph sequence than concatenating each letter's isolated shaping", () => {
    const joined = shapeRun(NOTO_SANS_ARABIC, CONNECTED_WORD, { script: "Arab", direction: "rtl" }).map(
      (g) => g.glyphId,
    );
    const concatenatedIsolated = Array.from(CONNECTED_WORD).flatMap((char) =>
      shapeRun(NOTO_SANS_ARABIC, char, { script: "Arab", direction: "rtl" }).map((g) => g.glyphId),
    );

    expect(joined).not.toEqual(concatenatedIsolated);
  });

  it("is deterministic across repeated shape calls", () => {
    const first = shapeRun(NOTO_SANS_ARABIC, CONNECTED_WORD, { script: "Arab", direction: "rtl" });
    const second = shapeRun(NOTO_SANS_ARABIC, CONNECTED_WORD, { script: "Arab", direction: "rtl" });

    expect(second).toEqual(first);
  });
});

describe("shapeRun: Tamil pre-base vowel reordering", () => {
  it("visually reorders a pre-base vowel sign before its base consonant", () => {
    const kaAlone = shapeRun(NOTO_SANS_TAMIL, "க", { script: "Taml", direction: "ltr" });
    const kaPlusVowelE = shapeRun(NOTO_SANS_TAMIL, "கெ", { script: "Taml", direction: "ltr" });

    expect(kaPlusVowelE).toHaveLength(2);
    // Logical order is consonant (U+0B95) then vowel sign (U+0BC6), but
    // Tamil's pre-base vowel signs render visually BEFORE their consonant:
    // the first shaped glyph is the vowel, the second is the same glyph as
    // the bare consonant shaped alone.
    expect(kaPlusVowelE[1]?.glyphId).toBe(kaAlone[0]?.glyphId);
    expect(kaPlusVowelE[0]?.glyphId).not.toBe(kaAlone[0]?.glyphId);
  });

  it("keeps the reordered vowel and consonant in the same cluster", () => {
    const glyphs = shapeRun(NOTO_SANS_TAMIL, "கெ", { script: "Taml", direction: "ltr" });
    expect(glyphs[0]?.cluster).toBe(glyphs[1]?.cluster);
  });
});
