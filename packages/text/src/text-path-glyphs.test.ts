import type { TextPathConfig } from "@cadra/core";
import { describe, expect, it } from "vitest";

import type { PositionedGlyph } from "./glyph-layout.js";
import { resolveGlyphPathStates } from "./text-path-glyphs.js";

const QUAD = { left: 0, right: 1, bottom: 0, top: 1 };
const UV = { u0: 0, v0: 0, u1: 1, v1: 1 };

function glyph(overrides: Partial<PositionedGlyph> & { cluster: number; origin: { x: number; y: number } }): PositionedGlyph {
  return {
    glyphId: overrides.cluster,
    lineIndex: 0,
    wordIndex: 0,
    quad: QUAD,
    page: 0,
    uv: UV,
    range: 0.1,
    ...overrides,
  };
}

// A straight line along +x. Deliberately a different length (20) than the
// test glyphs' own natural extent (10) in several tests below, to prove the
// text is rescaled to fit whatever span it maps onto rather than kept at
// its own natural size (see resolveGlyphPathStates's own doc).
const LINE_20: TextPathConfig = {
  start: [0, 0, 0],
  segments: [{ type: "line", to: [20, 0, 0] }],
};

describe("resolveGlyphPathStates: defaults (spacing advance, alignment start, startOffset 0, progress 1)", () => {
  it("rescales the text's own natural span to fill the entire curve", () => {
    // Natural x positions 0, 5, 10 (textLength = 10) on a 20-unit line:
    // fractions 0, 0.5, 1 map directly to u 0, 0.5, 1 -> absolute x 0, 10, 20.
    const glyphs = [
      glyph({ cluster: 0, origin: { x: 0, y: 0 } }),
      glyph({ cluster: 1, origin: { x: 5, y: 0 } }),
      glyph({ cluster: 2, origin: { x: 10, y: 0 } }),
    ];
    const states = resolveGlyphPathStates(glyphs, LINE_20, 0);
    expect(states[0]?.x).toBeCloseTo(0, 10);
    expect(states[1]?.x).toBeCloseTo(10, 10);
    expect(states[2]?.x).toBeCloseTo(20, 10);
  });

  it("preserves each glyph's own natural advance-width proportions while rescaling", () => {
    // Natural x 0, 2, 10 (uneven advances, textLength=10): fractions 0, 0.2, 1.
    const glyphs = [
      glyph({ cluster: 0, origin: { x: 0, y: 0 } }),
      glyph({ cluster: 1, origin: { x: 2, y: 0 } }),
      glyph({ cluster: 2, origin: { x: 10, y: 0 } }),
    ];
    const states = resolveGlyphPathStates(glyphs, LINE_20, 0);
    // glyph 1: u=0.2 -> absolute x 4.
    expect(states[1]?.x).toBeCloseTo(4, 10);
  });
});

describe("resolveGlyphPathStates: spacing even", () => {
  it("spreads glyphs at equal fractions of the span regardless of their own natural advance widths", () => {
    const glyphs = [
      glyph({ cluster: 0, origin: { x: 0, y: 0 } }),
      glyph({ cluster: 1, origin: { x: 1, y: 0 } }),
      glyph({ cluster: 2, origin: { x: 10, y: 0 } }),
    ];
    const path: TextPathConfig = { ...LINE_20, spacing: "even" };
    const states = resolveGlyphPathStates(glyphs, path, 0);
    // ranks 0, 1, 2 of 3 -> fractions 0, 0.5, 1 -> absolute x 0, 10, 20.
    expect(states[0]?.x).toBeCloseTo(0, 10);
    expect(states[1]?.x).toBeCloseTo(10, 10);
    expect(states[2]?.x).toBeCloseTo(20, 10);
  });
});

describe("resolveGlyphPathStates: alignment", () => {
  const glyphs = [glyph({ cluster: 0, origin: { x: 0, y: 0 } }), glyph({ cluster: 1, origin: { x: 10, y: 0 } })];

  it("start alignment anchors the text's own first unit at startOffset, extending across the remaining curve", () => {
    const path: TextPathConfig = { ...LINE_20, alignment: "start", startOffset: 0.25 };
    const states = resolveGlyphPathStates(glyphs, path, 0);
    // glyph 0 (fraction 0, the anchor): u = 0.25 -> absolute x 5.
    expect(states[0]?.x).toBeCloseTo(5, 10);
    // glyph 1 (fraction 1): u = 0.25 + 1*(1-0.25) = 1 -> absolute x 20.
    expect(states[1]?.x).toBeCloseTo(20, 10);
  });

  it("end alignment anchors the text's own last unit at startOffset", () => {
    const path: TextPathConfig = { ...LINE_20, alignment: "end", startOffset: 0.5 };
    const states = resolveGlyphPathStates(glyphs, path, 0);
    // glyph 1 (fraction 1, the anchor): u = 0.5 -> absolute x 10.
    expect(states[1]?.x).toBeCloseTo(10, 10);
  });

  it("center alignment anchors the text's own midpoint at startOffset", () => {
    const path: TextPathConfig = { ...LINE_20, alignment: "center", startOffset: 0.5 };
    // Neither glyph in `glyphs` sits exactly at fraction 0.5, so check the
    // true midpoint directly: a third glyph placed at the text's own
    // natural midpoint (still x=0 to x=10, textLength=10, midpoint x=5).
    const withMidpoint = [...glyphs, glyph({ cluster: 2, origin: { x: 5, y: 0 } })];
    const states = resolveGlyphPathStates(withMidpoint, path, 0);
    // midpoint glyph (fraction 0.5, the anchor): u = 0.5 -> absolute x 10.
    expect(states[2]?.x).toBeCloseTo(10, 10);
  });
});

describe("resolveGlyphPathStates: progress", () => {
  const glyphs = [glyph({ cluster: 0, origin: { x: 0, y: 0 } }), glyph({ cluster: 1, origin: { x: 10, y: 0 } })];

  it("collapses every glyph to the exact same point at progress 0", () => {
    const path: TextPathConfig = { ...LINE_20, startOffset: 0.3, progress: 0 };
    const states = resolveGlyphPathStates(glyphs, path, 0);
    // u = startOffset = 0.3 for both -> absolute x 6.
    expect(states[0]?.x).toBeCloseTo(6, 10);
    expect(states[1]?.x).toBeCloseTo(6, 10);
  });

  it("compresses the text into a shorter leading portion below 1", () => {
    const path: TextPathConfig = { ...LINE_20, startOffset: 0, progress: 0.5 };
    const states = resolveGlyphPathStates(glyphs, path, 0);
    // glyph 1 (fraction 1): u = 0 + 1*(1-0)*0.5 = 0.5 -> absolute x 10.
    expect(states[1]?.x).toBeCloseTo(10, 10);
  });
});

describe("resolveGlyphPathStates: orientation", () => {
  const ARCH: TextPathConfig = {
    start: [0, 0, 0],
    segments: [{ type: "quadratic", control: [5, 10, 0], to: [10, 0, 0] }],
  };

  it("upright orientation always keeps rotationZ at 0", () => {
    const glyphs = [glyph({ cluster: 0, origin: { x: 5, y: 0 } })];
    const path: TextPathConfig = { ...ARCH, orientation: "upright" };
    const states = resolveGlyphPathStates(glyphs, path, 0);
    expect(states[0]?.rotationZ).toBe(0);
  });

  it("tangent orientation (the default) gives a nonzero rotation partway along a curved segment", () => {
    const glyphs = [
      glyph({ cluster: 0, origin: { x: 0, y: 0 } }),
      glyph({ cluster: 1, origin: { x: 2, y: 0 } }),
    ];
    const states = resolveGlyphPathStates(glyphs, ARCH, 0);
    expect(states[1]?.rotationZ).not.toBe(0);
  });

  it("tangent orientation gives zero rotation along a perfectly straight, horizontal line", () => {
    const glyphs = [
      glyph({ cluster: 0, origin: { x: 0, y: 0 } }),
      glyph({ cluster: 1, origin: { x: 10, y: 0 } }),
    ];
    const states = resolveGlyphPathStates(glyphs, LINE_20, 0);
    expect(states[1]?.rotationZ).toBeCloseTo(0, 10);
  });
});

describe("resolveGlyphPathStates: offsetZ", () => {
  it("carries the path's own z position through as an additive offset", () => {
    const path: TextPathConfig = {
      start: [0, 0, 0],
      segments: [{ type: "line", to: [10, 0, 5] }],
    };
    const glyphs = [
      glyph({ cluster: 0, origin: { x: 0, y: 0 } }),
      glyph({ cluster: 1, origin: { x: 10, y: 0 } }),
    ];
    const states = resolveGlyphPathStates(glyphs, path, 0);
    // glyph 1 (fraction 1, default alignment start/progress 1): u=1 -> z=5.
    expect(states[1]?.offsetZ).toBeCloseTo(5, 10);
  });
});

describe("resolveGlyphPathStates: degenerate input", () => {
  it("returns an empty array for no glyphs", () => {
    expect(resolveGlyphPathStates([], LINE_20, 0)).toEqual([]);
  });

  it("handles a single glyph without dividing by zero", () => {
    const glyphs = [glyph({ cluster: 0, origin: { x: 5, y: 0 } })];
    expect(() => resolveGlyphPathStates(glyphs, LINE_20, 0)).not.toThrow();
  });
});

describe("resolveGlyphPathStates: determinism", () => {
  it("resolving the same inputs repeatedly gives the same result", () => {
    const glyphs = [
      glyph({ cluster: 0, origin: { x: 0, y: 0 } }),
      glyph({ cluster: 1, origin: { x: 7, y: 0 } }),
    ];
    const first = resolveGlyphPathStates(glyphs, LINE_20, 3);
    const second = resolveGlyphPathStates(glyphs, LINE_20, 3);
    expect(second).toEqual(first);
  });

  it("is deterministic and order-independent across frames, for a keyframe-deforming path", () => {
    const glyphs = [
      glyph({ cluster: 0, origin: { x: 0, y: 0 } }),
      glyph({ cluster: 1, origin: { x: 7, y: 0 } }),
    ];
    const deforming: TextPathConfig = {
      start: [0, 0, 0],
      segments: [
        {
          type: "line",
          to: {
            type: "keyframeTrack",
            keyframes: [
              { frame: 0, value: [20, 0, 0] },
              { frame: 10, value: [20, 12, 0] },
            ],
          },
        },
      ],
    };
    const resolveAtFrame = (frame: number) => resolveGlyphPathStates(glyphs, deforming, frame);

    const first = resolveAtFrame(6);
    const second = resolveAtFrame(6);
    expect(second).toEqual(first);

    const inOrder = [0, 5, 10].map(resolveAtFrame);
    const outOfOrder = [10, 0, 5].map(resolveAtFrame);
    expect(outOfOrder[1]).toEqual(inOrder[0]);
    expect(outOfOrder[2]).toEqual(inOrder[1]);
    expect(outOfOrder[0]).toEqual(inOrder[2]);
  });
});
