import type { TextStaggerConfig } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import type { PositionedGlyph } from "./glyph-layout.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";
import { prepareTextRenderData } from "./text-render-data.js";
import { resolveGlyphStaggerStates } from "./text-stagger-glyphs.js";

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

// rank N's own reveal window is [N * delayFrames, N * delayFrames + durationFrames].
const TYPEWRITER: TextStaggerConfig = {
  preset: "typewriter",
  grouping: "character",
  startFrame: 0,
  delayFrames: 2,
  durationFrames: 1,
};

describe("resolveGlyphStaggerStates", () => {
  it("resolves every glyph, in ascending cluster order, to its own reveal state at frame", () => {
    const glyphs = [glyph({ cluster: 0 }), glyph({ cluster: 1 }), glyph({ cluster: 2 })];
    // frame 1: rank 0 (cluster 0, window [0,1]) just finished revealing;
    // rank 1 (cluster 1, window [2,3]) and rank 2 (cluster 2, window [4,5])
    // have not started yet.
    const results = resolveGlyphStaggerStates(glyphs, TYPEWRITER, 1);
    const byGlyphIndex = new Map(results.map((r) => [r.glyphIndex, r.state]));
    expect(byGlyphIndex.get(0)?.opacity).toBe(1);
    expect(byGlyphIndex.get(1)?.opacity).toBe(0);
    expect(byGlyphIndex.get(2)?.opacity).toBe(0);
  });

  it("reveals progressively later units as frame advances, per delayFrames", () => {
    const glyphs = [glyph({ cluster: 0 }), glyph({ cluster: 1 }), glyph({ cluster: 2 })];
    // frame 5: rank 2's own window [4,5] has also just finished.
    const results = resolveGlyphStaggerStates(glyphs, TYPEWRITER, 5);
    const byGlyphIndex = new Map(results.map((r) => [r.glyphIndex, r.state]));
    expect(byGlyphIndex.get(0)?.opacity).toBe(1);
    expect(byGlyphIndex.get(1)?.opacity).toBe(1);
    expect(byGlyphIndex.get(2)?.opacity).toBe(1);
  });

  it("gives every glyph within the same unit the exact same resolved state object (not independently recomputed)", () => {
    const glyphs = [
      glyph({ cluster: 0, glyphId: 10 }),
      glyph({ cluster: 0, glyphId: 11 }),
      glyph({ cluster: 1, glyphId: 12 }),
    ];
    const results = resolveGlyphStaggerStates(glyphs, TYPEWRITER, 1);
    const byGlyphIndex = new Map(results.map((r) => [r.glyphIndex, r.state]));
    expect(byGlyphIndex.get(0)).toBe(byGlyphIndex.get(1));
    expect(byGlyphIndex.get(0)).not.toBe(byGlyphIndex.get(2));
  });

  it("respects direction: backward reveals the last unit first", () => {
    const glyphs = [glyph({ cluster: 0 }), glyph({ cluster: 1 }), glyph({ cluster: 2 })];
    const backward: TextStaggerConfig = { ...TYPEWRITER, direction: "backward" };
    // Backward: cluster 2 (last-read) gets rank 0 (window [0,1]), cluster 0
    // (first-read) gets rank 2 (window [4,5]).
    const results = resolveGlyphStaggerStates(glyphs, backward, 1);
    const byGlyphIndex = new Map(results.map((r) => [r.glyphIndex, r.state]));
    expect(byGlyphIndex.get(2)?.opacity).toBe(1); // rank 0, revealed first
    expect(byGlyphIndex.get(0)?.opacity).toBe(0); // rank 2, revealed last
  });

  it("orders word-grouped RTL glyphs by reading order, not array position, when resolving stagger rank", () => {
    // Two RTL words, glyph array in visual (decreasing-cluster) order:
    // array index 0 is the visually-leftmost, second-read word.
    const glyphs = [
      glyph({ cluster: 5, wordIndex: 0, glyphId: 100 }),
      glyph({ cluster: 1, wordIndex: 1, glyphId: 101 }),
    ];
    const wordTypewriter: TextStaggerConfig = { ...TYPEWRITER, grouping: "word" };
    const results = resolveGlyphStaggerStates(glyphs, wordTypewriter, 1);
    const byGlyphIndex = new Map(results.map((r) => [r.glyphIndex, r.state]));
    // The rightmost (first-read) word, glyph index 1 (cluster 1), must be
    // rank 0 (window [0,1]) and so fully revealed by frame 1; the leftmost
    // (last-read) word, glyph index 0 (cluster 5), is rank 1 (window
    // [2,3]) and must not have started yet.
    expect(byGlyphIndex.get(1)?.opacity).toBe(1);
    expect(byGlyphIndex.get(0)?.opacity).toBe(0);
  });

  it("passes lineTexts through to splitTextUnits for grapheme grouping", () => {
    const glyphs = [glyph({ cluster: 0, glyphId: 1 }), glyph({ cluster: 1, glyphId: 2 })];
    const grapheme: TextStaggerConfig = { ...TYPEWRITER, grouping: "grapheme" };
    // "é" as two combining clusters: one grapheme, so both glyphs must
    // share the same (rank 0, window [0,1]) state.
    const results = resolveGlyphStaggerStates(glyphs, grapheme, 1, ["é"]);
    const byGlyphIndex = new Map(results.map((r) => [r.glyphIndex, r.state]));
    expect(byGlyphIndex.get(0)?.opacity).toBe(1);
    expect(byGlyphIndex.get(1)?.opacity).toBe(1);
  });
});

/**
 * Phase 50 task 6's own acceptance test: real shaped text (not hand-built
 * glyph fixtures), verifying a per-word stagger reveals words in reading
 * order for both a left-to-right script (Latin) and a right-to-left one
 * (Arabic) - i.e. that `resolveGlyphStaggerStates`'s reliance on
 * `PositionedGlyph.cluster` (see `text-units.ts`'s own doc) actually holds
 * up against HarfHuzz's real output, not just the hand-constructed
 * decreasing-cluster fixtures used above.
 */
describe("resolveGlyphStaggerStates: real end-to-end word-reveal order (Phase 50 task 6)", () => {
  const WORD_TYPEWRITER: TextStaggerConfig = {
    preset: "typewriter",
    grouping: "word",
    startFrame: 0,
    delayFrames: 100,
    durationFrames: 1,
  };

  /** Every glyph's own on-screen horizontal center, from its `quad`. */
  function centerX(g: PositionedGlyph): number {
    return (g.quad.left + g.quad.right) / 2;
  }

  it("reveals the leftmost word first for real shaped Latin (left-to-right) text", async () => {
    const font = parseFontWithFontkit(loadFixtureFont("Inter-Variable"));
    const renderData = await prepareTextRenderData(font, "Hello world", {});

    // Frame 1: only the first-read word (rank 0) has finished its own
    // [0, 1] reveal window; the second word's window ([100, 101]) has not
    // started.
    const states = resolveGlyphStaggerStates(renderData.glyphs, WORD_TYPEWRITER, 1);
    const revealedXs = states
      .filter((r) => r.state.opacity === 1)
      .map((r) => centerX(renderData.glyphs[r.glyphIndex] as PositionedGlyph));
    const hiddenXs = states
      .filter((r) => r.state.opacity === 0)
      .map((r) => centerX(renderData.glyphs[r.glyphIndex] as PositionedGlyph));

    expect(revealedXs.length).toBeGreaterThan(0);
    expect(hiddenXs.length).toBeGreaterThan(0);
    // Latin reads left to right, so the first-read (revealed) word must sit
    // entirely to the left of the still-hidden second word.
    expect(Math.max(...revealedXs)).toBeLessThan(Math.min(...hiddenXs));
  });

  it("reveals the rightmost word first for real shaped Arabic (right-to-left) text", async () => {
    const font = parseFontWithFontkit(loadFixtureFont("NotoSansArabic-Variable"));
    // "hello world" in Arabic (two words).
    const renderData = await prepareTextRenderData(font, "مرحبا بالعالم", {});

    const states = resolveGlyphStaggerStates(renderData.glyphs, WORD_TYPEWRITER, 1);
    const revealedXs = states
      .filter((r) => r.state.opacity === 1)
      .map((r) => centerX(renderData.glyphs[r.glyphIndex] as PositionedGlyph));
    const hiddenXs = states
      .filter((r) => r.state.opacity === 0)
      .map((r) => centerX(renderData.glyphs[r.glyphIndex] as PositionedGlyph));

    expect(revealedXs.length).toBeGreaterThan(0);
    expect(hiddenXs.length).toBeGreaterThan(0);
    // Arabic reads right to left, so the first-read (revealed) word must
    // sit entirely to the right of the still-hidden second word - the
    // opposite side from the Latin case above, proving stagger order
    // follows reading order rather than a fixed screen-space direction.
    expect(Math.min(...revealedXs)).toBeGreaterThan(Math.max(...hiddenXs));
  });
});
