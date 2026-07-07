import type { ColorRGBA } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import { createMsdfAtlasCache } from "./msdf-atlas-cache.js";
import { prepareParagraphRenderData } from "./paragraph-render-data.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";
import { measureUnwrappedWidth } from "./test-support/measure-unwrapped-width.js";

const ROBOTO_FLEX = parseFontWithFontkit(loadFixtureFont("RobotoFlex-Variable"));
const NOTO_SANS_ARABIC = parseFontWithFontkit(loadFixtureFont("NotoSansArabic-Variable"));

describe("prepareParagraphRenderData", () => {
  it("shapes, atlases, and lays out a single-line paragraph", async () => {
    const data = await prepareParagraphRenderData(
      [{ text: "Vote" }],
      { font: ROBOTO_FLEX, maxWidth: 1000 },
      createMsdfAtlasCache(),
    );

    expect(data.lineCount).toBe(1);
    expect(data.glyphs).toHaveLength(4);
    expect(data.atlasPages).toHaveLength(1);
    expect(data.lines).toHaveLength(1);
    expect(data.lines[0]?.baselineY).toBe(0);
  });

  it("produces glyphs across every wrapped line's own lineIndex", async () => {
    const text = "one two three four five six seven eight nine ten";
    const maxWidth = measureUnwrappedWidth(ROBOTO_FLEX, text) / 3;
    const data = await prepareParagraphRenderData(
      [{ text }],
      { font: ROBOTO_FLEX, maxWidth },
      createMsdfAtlasCache(),
    );

    expect(data.lineCount).toBeGreaterThan(1);
    const lineIndices = new Set(data.glyphs.map((g) => g.lineIndex));
    expect(lineIndices.size).toBe(data.lineCount);
  });

  it("is deterministic across repeated calls", async () => {
    const cache = createMsdfAtlasCache();
    const options = { font: ROBOTO_FLEX, maxWidth: 1000 };
    const first = await prepareParagraphRenderData([{ text: "Vote" }], options, cache);
    const second = await prepareParagraphRenderData([{ text: "Vote" }], options, cache);
    expect(second).toEqual(first);
  });

  it("merges two distinct fonts' atlases into one flat page list with correctly offset page indices", async () => {
    const data = await prepareParagraphRenderData(
      [{ text: "AB " }, { text: "مرحبا", style: { font: NOTO_SANS_ARABIC } }],
      { font: ROBOTO_FLEX, maxWidth: 1000 },
      createMsdfAtlasCache(),
    );

    // Two distinct fonts, each atlased alone, would each produce their own
    // page(s) starting at index 0 - merged, only the first font's pages
    // keep index 0; the second font's pages must be offset past them.
    const latinGlyphs = data.glyphs.filter((g) => g.cluster < 3);
    const arabicGlyphs = data.glyphs.filter((g) => g.cluster >= 3);
    expect(latinGlyphs.length).toBeGreaterThan(0);
    expect(arabicGlyphs.length).toBeGreaterThan(0);

    const maxPageIndex = Math.max(...data.glyphs.map((g) => g.page));
    expect(maxPageIndex).toBeLessThan(data.atlasPages.length);
    // The two fonts' glyphs must land on genuinely different pages (each
    // font's own atlas is generated independently, so even a single page
    // each cannot be the *same* merged index).
    const latinPages = new Set(latinGlyphs.map((g) => g.page));
    const arabicPages = new Set(arabicGlyphs.map((g) => g.page));
    for (const page of latinPages) {
      expect(arabicPages.has(page)).toBe(false);
    }
  });

  it("carries each glyph's resolved inline-style color through to the final render data", async () => {
    const gold: ColorRGBA = [1, 0.8, 0, 1];
    const data = await prepareParagraphRenderData(
      [{ text: "plain " }, { text: "gold", style: { color: gold } }],
      { font: ROBOTO_FLEX, maxWidth: 1000 },
      createMsdfAtlasCache(),
    );

    const plainGlyphs = data.glyphs.filter((g) => g.cluster < 6);
    const goldGlyphs = data.glyphs.filter((g) => g.cluster >= 6);
    expect(plainGlyphs.length).toBeGreaterThan(0);
    expect(goldGlyphs.length).toBeGreaterThan(0);
    for (const glyph of plainGlyphs) {
      expect(glyph.color).toBeUndefined();
    }
    for (const glyph of goldGlyphs) {
      expect(glyph.color).toEqual(gold);
    }
  });
});
