import type { TextPhysicsConfig } from "@cadra/core";
import { describe, expect, it } from "vitest";

import type { PositionedGlyph } from "./glyph-layout.js";
import { resolveGlyphPhysicsStates } from "./text-physics-glyphs.js";

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
    ...overrides,
  };
}

const JITTER: TextPhysicsConfig = {
  effect: "jitter",
  grouping: "character",
  seed: 5,
  positionAmplitude: 0.3,
  periodFrames: 10,
};

describe("resolveGlyphPhysicsStates", () => {
  it("resolves every glyph to a physics state", () => {
    const glyphs = [glyph({ cluster: 0 }), glyph({ cluster: 1 })];
    const results = resolveGlyphPhysicsStates(glyphs, JITTER, 5);
    expect(results).toHaveLength(2);
    for (const { state } of results) {
      expect(state.offsetX).not.toBeUndefined();
      expect(state.offsetY).not.toBeUndefined();
    }
  });

  it("gives every glyph within the same unit the exact same resolved state object", () => {
    const glyphs = [
      glyph({ cluster: 0, glyphId: 10 }),
      glyph({ cluster: 0, glyphId: 11 }),
      glyph({ cluster: 1, glyphId: 12 }),
    ];
    const results = resolveGlyphPhysicsStates(glyphs, JITTER, 5);
    const byGlyphIndex = new Map(results.map((r) => [r.glyphIndex, r.state]));
    expect(byGlyphIndex.get(0)).toBe(byGlyphIndex.get(1));
    expect(byGlyphIndex.get(0)).not.toBe(byGlyphIndex.get(2));
  });

  it("gives different-rank units independent (uncorrelated) jitter", () => {
    const glyphs = [glyph({ cluster: 0 }), glyph({ cluster: 5 })];
    const results = resolveGlyphPhysicsStates(glyphs, JITTER, 5);
    expect(results[0]?.state.offsetX).not.toBe(results[1]?.state.offsetX);
  });

  it("passes lineTexts through to splitTextUnits for grapheme grouping", () => {
    const glyphs = [glyph({ cluster: 0, glyphId: 1 }), glyph({ cluster: 1, glyphId: 2 })];
    const grapheme: TextPhysicsConfig = { ...JITTER, grouping: "grapheme" };
    const results = resolveGlyphPhysicsStates(glyphs, grapheme, 5, ["é"]);
    const byGlyphIndex = new Map(results.map((r) => [r.glyphIndex, r.state]));
    // "é" as two combining clusters is one grapheme, so both glyphs share
    // the same rank and so the same jitter state.
    expect(byGlyphIndex.get(0)).toBe(byGlyphIndex.get(1));
  });

  it("resolves content-effect configs (scramble/countUp) to an empty state for every glyph", () => {
    const glyphs = [glyph({ cluster: 0 }), glyph({ cluster: 1 })];
    const scramble: TextPhysicsConfig = { effect: "scramble", grouping: "character" };
    const results = resolveGlyphPhysicsStates(glyphs, scramble, 5);
    for (const { state } of results) {
      expect(state).toEqual({});
    }
  });
});
