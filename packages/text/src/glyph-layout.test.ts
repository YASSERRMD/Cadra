import { describe, expect, it } from "vitest";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import { computeGlyphLayout } from "./glyph-layout.js";
import { generateMsdfAtlas } from "./msdf-atlas.js";
import { shapeText } from "./shape-text.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";

const ROBOTO_FLEX = parseFontWithFontkit(loadFixtureFont("RobotoFlex-Variable"));

async function layoutFor(lines: readonly string[]) {
  const shapedLines = lines.map((line) => shapeText(ROBOTO_FLEX, line));
  const usedGlyphIds = new Set<number>();
  for (const line of shapedLines) {
    for (const run of line) {
      for (const glyph of run.glyphs) {
        usedGlyphIds.add(glyph.glyphId);
      }
    }
  }
  const atlas = await generateMsdfAtlas(ROBOTO_FLEX, usedGlyphIds);
  return computeGlyphLayout(shapedLines, atlas, { unitsPerEm: ROBOTO_FLEX.metrics.unitsPerEm });
}

describe("computeGlyphLayout", () => {
  it("places glyphs left to right along one line, advancing the pen between them", async () => {
    const layout = await layoutFor(["Vo"]);

    expect(layout.glyphs).toHaveLength(2);
    const [v, o] = layout.glyphs;
    expect(v?.cluster).toBe(0);
    expect(o?.cluster).toBe(1);
    // "o" starts to the right of where "V" starts (kerning can still tuck
    // it partway under "V"'s overhang, so their quads may legitimately
    // overlap; only the left edges are guaranteed to advance).
    expect(o?.quad.left).toBeGreaterThan(v?.quad.left as number);
  });

  it("gives every glyph a positive, sensible quad size in em units", async () => {
    const layout = await layoutFor(["V"]);
    const glyph = layout.glyphs[0];

    expect(glyph?.quad.right).toBeGreaterThan(glyph?.quad.left as number);
    expect(glyph?.quad.top).toBeGreaterThan(glyph?.quad.bottom as number);
    // A capital letter in a normal font is well under 2 em wide/tall.
    expect((glyph?.quad.right as number) - (glyph?.quad.left as number)).toBeLessThan(2);
  });

  it("produces normalized (0-1) UV rectangles into the atlas page", async () => {
    const layout = await layoutFor(["Vote"]);

    for (const glyph of layout.glyphs) {
      expect(glyph.uv.u0).toBeGreaterThanOrEqual(0);
      expect(glyph.uv.u1).toBeLessThanOrEqual(1);
      expect(glyph.uv.v0).toBeGreaterThanOrEqual(0);
      expect(glyph.uv.v1).toBeLessThanOrEqual(1);
      expect(glyph.uv.u1).toBeGreaterThan(glyph.uv.u0);
      expect(glyph.uv.v1).toBeGreaterThan(glyph.uv.v0);
    }
  });

  it("groups glyphs into words, split on whitespace, starting from word index 0", async () => {
    const layout = await layoutFor(["Vo te"]);
    const wordIndices = layout.glyphs.map((g) => g.wordIndex);

    expect(Math.min(...wordIndices)).toBe(0);
    // "Vo" (word 0) and "te" (word 1): exactly two distinct word indices.
    expect(new Set(wordIndices).size).toBe(2);
  });

  it("stacks multiple lines downward (decreasing Y) by the atlas line height", async () => {
    const layout = await layoutFor(["V", "V"]);
    const firstLineGlyph = layout.glyphs.find((g) => g.lineIndex === 0);
    const secondLineGlyph = layout.glyphs.find((g) => g.lineIndex === 1);

    expect(layout.lineCount).toBe(2);
    expect(secondLineGlyph?.quad.top).toBeLessThan(firstLineGlyph?.quad.top as number);
  });

  it("is deterministic across repeated calls", async () => {
    const first = await layoutFor(["Vote"]);
    const second = await layoutFor(["Vote"]);

    expect(second).toEqual(first);
  });
});
