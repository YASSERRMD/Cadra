import { describe, expect, it } from "vitest";

import type { PositionedGlyph } from "./glyph-layout.js";
import { resolveGlyphMorphStates } from "./text-morph-glyphs.js";

const UV = { u0: 0, v0: 0, u1: 1, v1: 1 };

function glyph(overrides: Partial<PositionedGlyph> & { cluster: number }): PositionedGlyph {
  return {
    glyphId: overrides.cluster,
    lineIndex: 0,
    wordIndex: 0,
    origin: { x: 0, y: 0 },
    quad: { left: 0, right: 1, bottom: 0, top: 1 },
    page: 0,
    uv: UV,
    ...overrides,
  };
}

function quadAt(centerX: number): PositionedGlyph["quad"] {
  return { left: centerX - 0.5, right: centerX + 0.5, bottom: 0, top: 1 };
}

describe("resolveGlyphMorphStates: matched units (present in both from and to)", () => {
  const fromGlyphs = [glyph({ cluster: 0, quad: quadAt(0) })];
  const toGlyphs = [glyph({ cluster: 0, quad: quadAt(10) })];

  it("at progress 0, the from glyph sits at its own natural position, fully opaque", () => {
    const states = resolveGlyphMorphStates(fromGlyphs, toGlyphs, "character", 0);
    const fromState = states.find((s) => s.source === "from");
    expect(fromState?.opacity).toBe(1);
    expect(fromState?.offsetX).toBe(0);
  });

  it("at progress 0, the to glyph sits at the from glyph's position, fully transparent", () => {
    const states = resolveGlyphMorphStates(fromGlyphs, toGlyphs, "character", 0);
    const toState = states.find((s) => s.source === "to");
    expect(toState?.opacity).toBe(0);
    // to's own natural center is x=10, from's is x=0: to must offset by -10 to sit at from's position.
    expect(toState?.offsetX).toBe(-10);
  });

  it("at progress 1, the to glyph sits at its own natural position, fully opaque", () => {
    const states = resolveGlyphMorphStates(fromGlyphs, toGlyphs, "character", 1);
    const toState = states.find((s) => s.source === "to");
    expect(toState?.opacity).toBe(1);
    expect(toState?.offsetX).toBe(0);
  });

  it("at progress 1, the from glyph sits at the to glyph's position, fully transparent", () => {
    const states = resolveGlyphMorphStates(fromGlyphs, toGlyphs, "character", 1);
    const fromState = states.find((s) => s.source === "from");
    expect(fromState?.opacity).toBe(0);
    expect(fromState?.offsetX).toBe(10);
  });

  it("at any progress, both glyphs converge to the exact same absolute position", () => {
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const states = resolveGlyphMorphStates(fromGlyphs, toGlyphs, "character", progress);
      const fromState = states.find((s) => s.source === "from");
      const toState = states.find((s) => s.source === "to");
      const fromAbsoluteX = 0 + (fromState?.offsetX ?? 0);
      const toAbsoluteX = 10 + (toState?.offsetX ?? 0);
      expect(fromAbsoluteX).toBeCloseTo(toAbsoluteX, 10);
    }
  });

  it("crossfades opacity linearly with progress", () => {
    const states = resolveGlyphMorphStates(fromGlyphs, toGlyphs, "character", 0.3);
    const fromState = states.find((s) => s.source === "from");
    const toState = states.find((s) => s.source === "to");
    expect(fromState?.opacity).toBeCloseTo(0.7, 10);
    expect(toState?.opacity).toBeCloseTo(0.3, 10);
  });
});

describe("resolveGlyphMorphStates: unmatched units (from longer than to)", () => {
  const fromGlyphs = [glyph({ cluster: 0, quad: quadAt(0) }), glyph({ cluster: 1, quad: quadAt(10) })];
  const toGlyphs = [glyph({ cluster: 0, quad: quadAt(0) })];

  it("fades the extra from-only unit out in place, with no offset", () => {
    const states = resolveGlyphMorphStates(fromGlyphs, toGlyphs, "character", 0.4);
    const extra = states.find((s) => s.source === "from" && s.glyphIndex === 1);
    expect(extra?.opacity).toBeCloseTo(0.6, 10);
    expect(extra?.offsetX).toBe(0);
    expect(extra?.offsetY).toBe(0);
  });
});

describe("resolveGlyphMorphStates: unmatched units (to longer than from)", () => {
  const fromGlyphs = [glyph({ cluster: 0, quad: quadAt(0) })];
  const toGlyphs = [glyph({ cluster: 0, quad: quadAt(0) }), glyph({ cluster: 1, quad: quadAt(10) })];

  it("fades the extra to-only unit in in place, with no offset", () => {
    const states = resolveGlyphMorphStates(fromGlyphs, toGlyphs, "character", 0.4);
    const extra = states.find((s) => s.source === "to" && s.glyphIndex === 1);
    expect(extra?.opacity).toBeCloseTo(0.4, 10);
    expect(extra?.offsetX).toBe(0);
    expect(extra?.offsetY).toBe(0);
  });
});

describe("resolveGlyphMorphStates: multi-glyph units", () => {
  it("uses the average quad center of every glyph in a unit as its own natural position", () => {
    // A single "word" unit made of two glyphs, centered at x=0 and x=2: average center x=1.
    const fromGlyphs = [
      glyph({ cluster: 0, wordIndex: 0, quad: quadAt(0) }),
      glyph({ cluster: 1, wordIndex: 0, quad: quadAt(2) }),
    ];
    const toGlyphs = [glyph({ cluster: 0, wordIndex: 0, quad: quadAt(11) })];
    const states = resolveGlyphMorphStates(fromGlyphs, toGlyphs, "word", 0);
    const toState = states.find((s) => s.source === "to");
    // to's own center (11) must offset to sit at from's average center (1): delta -10.
    expect(toState?.offsetX).toBe(-10);
  });
});

describe("resolveGlyphMorphStates: determinism", () => {
  it("resolving the same inputs repeatedly gives the same result", () => {
    const fromGlyphs = [glyph({ cluster: 0, quad: quadAt(0) })];
    const toGlyphs = [glyph({ cluster: 0, quad: quadAt(10) })];
    const first = resolveGlyphMorphStates(fromGlyphs, toGlyphs, "character", 0.5);
    const second = resolveGlyphMorphStates(fromGlyphs, toGlyphs, "character", 0.5);
    expect(second).toEqual(first);
  });

  it("is order-independent across different progress values (no hidden accumulating state)", () => {
    const fromGlyphs = [glyph({ cluster: 0, quad: quadAt(0) })];
    const toGlyphs = [glyph({ cluster: 0, quad: quadAt(10) })];
    const resolveAtProgress = (progress: number) =>
      resolveGlyphMorphStates(fromGlyphs, toGlyphs, "character", progress);

    const inOrder = [0, 0.5, 1].map(resolveAtProgress);
    const outOfOrder = [1, 0, 0.5].map(resolveAtProgress);
    expect(outOfOrder[1]).toEqual(inOrder[0]);
    expect(outOfOrder[2]).toEqual(inOrder[1]);
    expect(outOfOrder[0]).toEqual(inOrder[2]);
  });
});
