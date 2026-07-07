import { describe, expect, it } from "vitest";

import type { PositionedGlyph } from "./glyph-layout.js";
import { splitTextUnits } from "./text-units.js";

const QUAD = { left: 0, right: 1, bottom: 0, top: 1 };
const UV = { u0: 0, v0: 0, u1: 1, v1: 1 };

function glyph(overrides: Partial<PositionedGlyph> & { cluster: number }): PositionedGlyph {
  return {
    glyphId: overrides.cluster,
    lineIndex: 0,
    wordIndex: 0,
    origin: { x: 0, y: 0 },
    quad: QUAD,
    page: 0,
    uv: UV,
    range: 0.1,
    ...overrides,
  };
}

describe("splitTextUnits: character", () => {
  it("gives each cluster its own unit, in ascending cluster order", () => {
    const glyphs = [glyph({ cluster: 0 }), glyph({ cluster: 1 }), glyph({ cluster: 2 })];
    const units = splitTextUnits(glyphs, "character");
    expect(units).toHaveLength(3);
    expect(units.map((u) => u.glyphIndices)).toEqual([[0], [1], [2]]);
  });

  it("keeps multiple glyphs sharing one cluster (e.g. a mark-attached base+combining-mark pair) as a single unit", () => {
    const glyphs = [glyph({ cluster: 0, glyphId: 10 }), glyph({ cluster: 0, glyphId: 11 }), glyph({ cluster: 1 })];
    const units = splitTextUnits(glyphs, "character");
    expect(units).toHaveLength(2);
    expect(units[0]?.glyphIndices).toEqual([0, 1]);
    expect(units[1]?.glyphIndices).toEqual([2]);
  });

  it("orders units by cluster value, not by array position (right-to-left glyph arrays are cluster-decreasing)", () => {
    // Simulates an RTL run's own glyph array order: HarfBuzz emits glyphs in
    // visual (decreasing-cluster) order for RTL text.
    const glyphs = [glyph({ cluster: 2 }), glyph({ cluster: 1 }), glyph({ cluster: 0 })];
    const units = splitTextUnits(glyphs, "character");
    expect(units.map((u) => u.glyphIndices)).toEqual([[2], [1], [0]]);
  });

  it("keys character units by (lineIndex, cluster), so two lines each starting at cluster 0 do not collide", () => {
    const glyphs = [glyph({ cluster: 0, lineIndex: 0 }), glyph({ cluster: 0, lineIndex: 1 })];
    const units = splitTextUnits(glyphs, "character");
    expect(units).toHaveLength(2);
  });
});

describe("splitTextUnits: word", () => {
  it("groups by (lineIndex, wordIndex), ordered by each word's own minimum cluster", () => {
    const glyphs = [
      glyph({ cluster: 0, wordIndex: 0 }),
      glyph({ cluster: 1, wordIndex: 0 }),
      glyph({ cluster: 3, wordIndex: 1 }),
      glyph({ cluster: 4, wordIndex: 1 }),
    ];
    const units = splitTextUnits(glyphs, "word");
    expect(units).toHaveLength(2);
    expect(units[0]?.glyphIndices).toEqual([0, 1]);
    expect(units[1]?.glyphIndices).toEqual([2, 3]);
  });

  it("orders right-to-left words in reading order (highest cluster first, i.e. the visually rightmost word), not array order", () => {
    // A 2-word RTL line whose glyph array is in visual (decreasing-cluster)
    // order: array position 0 is the visually-leftmost, LAST-read word.
    const glyphs = [
      glyph({ cluster: 5, wordIndex: 0 }), // visually leftmost: second word read
      glyph({ cluster: 4, wordIndex: 0 }),
      glyph({ cluster: 1, wordIndex: 1 }), // visually rightmost: first word read
      glyph({ cluster: 0, wordIndex: 1 }),
    ];
    const units = splitTextUnits(glyphs, "word");
    expect(units).toHaveLength(2);
    // Reading-order unit 0 must be the second word's glyphs (lowest cluster).
    expect(units[0]?.glyphIndices).toEqual([2, 3]);
    expect(units[1]?.glyphIndices).toEqual([0, 1]);
  });
});

describe("splitTextUnits: line", () => {
  it("groups by lineIndex, ordered top to bottom", () => {
    const glyphs = [glyph({ cluster: 0, lineIndex: 1 }), glyph({ cluster: 0, lineIndex: 0 })];
    const units = splitTextUnits(glyphs, "line");
    expect(units).toHaveLength(2);
    expect(units[0]?.glyphIndices).toEqual([1]);
    expect(units[1]?.glyphIndices).toEqual([0]);
  });

  it("produces dense, gap-free indices even when an intermediate line has no glyphs at all", () => {
    // lineIndex 1 (a blank or whitespace-only line) contributes no glyphs.
    const glyphs = [glyph({ cluster: 0, lineIndex: 0 }), glyph({ cluster: 0, lineIndex: 2 })];
    const units = splitTextUnits(glyphs, "line");
    expect(units.map((u) => u.index)).toEqual([0, 1]);
  });
});

describe("splitTextUnits: grapheme", () => {
  it("requires lineTexts and throws a clear error without it", () => {
    expect(() => splitTextUnits([glyph({ cluster: 0 })], "grapheme")).toThrow(/lineTexts/);
  });

  it("merges multiple clusters that HarfBuzz shaped separately but Unicode considers one grapheme", () => {
    // "e" + COMBINING ACUTE ACCENT (U+0301): one Unicode grapheme, simulated
    // here as two separate HarfBuzz clusters (cluster 0 and cluster 1) - the
    // scenario a font with no precomposed glyph and no GPOS mark-attachment
    // rule would produce.
    const lineText = "éx";
    const glyphs = [
      glyph({ cluster: 0, glyphId: 1 }), // "e"
      glyph({ cluster: 1, glyphId: 2 }), // combining accent
      glyph({ cluster: 2, glyphId: 3 }), // "x"
    ];
    const units = splitTextUnits(glyphs, "grapheme", [lineText]);
    expect(units).toHaveLength(2);
    expect(units[0]?.glyphIndices).toEqual([0, 1]);
    expect(units[1]?.glyphIndices).toEqual([2]);
  });

  it("gives an already-one-cluster ligature its own single grapheme unit (never finer than character)", () => {
    // "ffi" ligature: one cluster (cluster 0) spanning 3 source characters,
    // one glyph - grapheme grouping must not attempt to split it further.
    const lineText = "ffi";
    const glyphs = [glyph({ cluster: 0, glyphId: 99 })];
    const units = splitTextUnits(glyphs, "grapheme", [lineText]);
    expect(units).toHaveLength(1);
    expect(units[0]?.glyphIndices).toEqual([0]);
  });

  it("looks up each glyph's own line's text independently across multiple lines", () => {
    const glyphs = [
      glyph({ cluster: 0, lineIndex: 0, glyphId: 1 }),
      glyph({ cluster: 1, lineIndex: 0, glyphId: 2 }),
      glyph({ cluster: 0, lineIndex: 1, glyphId: 3 }),
    ];
    const units = splitTextUnits(glyphs, "grapheme", ["é", "x"]);
    expect(units).toHaveLength(2);
    expect(units[0]?.glyphIndices).toEqual([0, 1]);
    expect(units[1]?.glyphIndices).toEqual([2]);
  });
});
