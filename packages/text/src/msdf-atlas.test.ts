import { describe, expect, it } from "vitest";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import { generateMsdfAtlas } from "./msdf-atlas.js";
import { shapeText } from "./shape-text.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";

const ROBOTO_FLEX = parseFontWithFontkit(loadFixtureFont("RobotoFlex-Variable"));
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function shapedGlyphIds(text: string): Set<number> {
  const glyphIds = new Set<number>();
  for (const run of shapeText(ROBOTO_FLEX, text)) {
    for (const glyph of run.glyphs) {
      glyphIds.add(glyph.glyphId);
    }
  }
  return glyphIds;
}

describe("generateMsdfAtlas", () => {
  it("generates a real PNG atlas containing exactly the glyphs a shaped string uses", async () => {
    const glyphIds = shapedGlyphIds("Vote");
    const atlas = await generateMsdfAtlas(ROBOTO_FLEX, glyphIds);

    expect(atlas.missingGlyphIds).toEqual([]);
    expect(atlas.pages).toHaveLength(1);
    expect(Array.from(atlas.pages[0]?.png.slice(0, 8) ?? [])).toEqual(PNG_SIGNATURE);

    const placedGlyphIds = atlas.glyphs.map((g) => g.glyphId).sort((a, b) => a - b);
    expect(placedGlyphIds).toEqual(Array.from(glyphIds).sort((a, b) => a - b));
  });

  it("only generates the glyphs actually requested, not the whole font", async () => {
    const smallAtlas = await generateMsdfAtlas(ROBOTO_FLEX, shapedGlyphIds("Vo"));
    const largerAtlas = await generateMsdfAtlas(ROBOTO_FLEX, shapedGlyphIds("Vote"));

    expect(smallAtlas.glyphs.length).toBeLessThan(largerAtlas.glyphs.length);
  });

  it("gives every placed glyph real, usable MSDF sampling parameters", async () => {
    const atlas = await generateMsdfAtlas(ROBOTO_FLEX, shapedGlyphIds("V"));
    const placement = atlas.glyphs[0];

    expect(placement?.width).toBeGreaterThan(0);
    expect(placement?.height).toBeGreaterThan(0);
    expect(placement?.range).toBeGreaterThan(0);
    expect(placement?.scale).toBeGreaterThan(0);
  });

  it("reports requested glyph ids that are not reachable via the font's own character set", async () => {
    const atlas = await generateMsdfAtlas(ROBOTO_FLEX, new Set([999_999]));

    expect(atlas.missingGlyphIds).toEqual([999_999]);
    expect(atlas.glyphs).toEqual([]);
  });

  it("is deterministic: the same font and glyph set produce byte-identical atlas pages", async () => {
    const glyphIds = shapedGlyphIds("Vote");
    const first = await generateMsdfAtlas(ROBOTO_FLEX, glyphIds);
    const second = await generateMsdfAtlas(ROBOTO_FLEX, glyphIds);

    expect(Array.from(second.pages[0]?.png ?? [])).toEqual(Array.from(first.pages[0]?.png ?? []));
    expect(second.glyphs).toEqual(first.glyphs);
  });

  it("exposes font metrics in the same normalized em-unit space as glyph placements", async () => {
    const atlas = await generateMsdfAtlas(ROBOTO_FLEX, shapedGlyphIds("V"));

    expect(atlas.metrics.emSize).toBe(1);
    expect(atlas.metrics.ascenderY).toBeGreaterThan(0);
  });
});
