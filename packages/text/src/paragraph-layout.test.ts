import type { ColorRGBA } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import { layoutParagraphLines } from "./paragraph-layout.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";
import { measureUnwrappedWidth } from "./test-support/measure-unwrapped-width.js";

const ROBOTO_FLEX = parseFontWithFontkit(loadFixtureFont("RobotoFlex-Variable"));
const NOTO_SANS_ARABIC = parseFontWithFontkit(loadFixtureFont("NotoSansArabic-Variable"));

function rightEdge(glyphs: ReadonlyArray<{ penX: number; xAdvance: number }>): number {
  return Math.max(...glyphs.map((g) => g.penX + g.xAdvance));
}

function leftEdge(glyphs: ReadonlyArray<{ penX: number }>): number {
  return Math.min(...glyphs.map((g) => g.penX));
}

function defaultLineHeight(font: typeof ROBOTO_FLEX): number {
  const m = font.metrics;
  return (m.ascent - m.descent + m.lineGap) / m.unitsPerEm;
}

describe("layoutParagraphLines: line breaking", () => {
  it("keeps a short paragraph on one line when it fits within maxWidth", () => {
    const text = "one two three";
    const maxWidth = measureUnwrappedWidth(ROBOTO_FLEX, text) + 1;
    const result = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth });
    expect(result.lineCount).toBe(1);
  });

  it("wraps a long paragraph into multiple lines, each within maxWidth", () => {
    const text = "one two three four five six seven eight nine ten";
    const maxWidth = measureUnwrappedWidth(ROBOTO_FLEX, text) / 3;
    const result = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth });

    expect(result.lineCount).toBeGreaterThan(1);
    for (let lineIndex = 0; lineIndex < result.lineCount; lineIndex += 1) {
      const lineGlyphs = result.glyphs.filter((g) => g.lineIndex === lineIndex);
      if (lineGlyphs.length === 0) {
        continue;
      }
      // A tiny tolerance for floating point accumulation, not for genuine overflow.
      expect(rightEdge(lineGlyphs)).toBeLessThanOrEqual(maxWidth + 1e-6);
    }
  });

  it("covers every word exactly once across all wrapped lines, in order", () => {
    const text = "alpha beta gamma delta epsilon zeta";
    const maxWidth = measureUnwrappedWidth(ROBOTO_FLEX, text) / 3;
    const result = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth });

    const clustersInOrder = result.glyphs
      .slice()
      .sort((a, b) => a.lineIndex - b.lineIndex || a.penX - b.penX)
      .map((g) => g.cluster);
    // Not vacuous: this pure-Latin, no-ligature phrase should shape to
    // exactly one glyph per character, minus the one whitespace character
    // "dropped" at each of the (lineCount - 1) wrap points (a line never
    // renders the trailing space it broke on; verified empirically here -
    // asserting the naive text.length first caught this).
    expect(result.lineCount).toBeGreaterThan(1);
    expect(clustersInOrder).toHaveLength(text.length - (result.lineCount - 1));
    // Every cluster from the source text with a real glyph should appear;
    // clusters strictly increase within reconstructed reading order for
    // this pure-Latin, single-direction paragraph.
    for (let i = 1; i < clustersInOrder.length; i += 1) {
      expect(clustersInOrder[i]).toBeGreaterThanOrEqual(clustersInOrder[i - 1] as number);
    }
  });
});

describe("layoutParagraphLines: justification", () => {
  it("stretches every non-last line to fill maxWidth exactly, but leaves the paragraph's last line unstretched", () => {
    const text = "one two three four five six seven eight nine ten";
    const maxWidth = measureUnwrappedWidth(ROBOTO_FLEX, text) / 3;
    const result = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth, align: "justify" });

    expect(result.lineCount).toBeGreaterThan(1);
    for (let lineIndex = 0; lineIndex < result.lineCount - 1; lineIndex += 1) {
      const lineGlyphs = result.glyphs.filter((g) => g.lineIndex === lineIndex);
      expect(rightEdge(lineGlyphs)).toBeCloseTo(maxWidth, 5);
    }

    const lastLineGlyphs = result.glyphs.filter((g) => g.lineIndex === result.lineCount - 1);
    expect(rightEdge(lastLineGlyphs)).toBeLessThan(maxWidth);
  });

  it("does not stretch a single-word line (nothing to distribute extra space across)", () => {
    const text = "supercalifragilisticexpialidocious two";
    const maxWidth = measureUnwrappedWidth(ROBOTO_FLEX, "supercalifragilisticexpialidocious") + 0.5;
    const result = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth, align: "justify" });

    expect(result.lineCount).toBe(2);
    const firstLineGlyphs = result.glyphs.filter((g) => g.lineIndex === 0);
    // Single word alone on its line: nothing to justify, so its own natural
    // width, not stretched out to maxWidth.
    expect(rightEdge(firstLineGlyphs)).toBeLessThan(maxWidth);
  });

  it("defaults to Knuth-Plass line breaking when align is justify, matching the explicit option", () => {
    const text = "one two three four five six seven eight nine ten eleven twelve";
    const maxWidth = measureUnwrappedWidth(ROBOTO_FLEX, text) / 4;

    const implicit = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth, align: "justify" });
    const explicitKnuthPlass = layoutParagraphLines([{ text }], {
      font: ROBOTO_FLEX,
      maxWidth,
      align: "justify",
      useKnuthPlass: true,
    });
    const explicitGreedy = layoutParagraphLines([{ text }], {
      font: ROBOTO_FLEX,
      maxWidth,
      align: "justify",
      useKnuthPlass: false,
    });

    expect(implicit.lineCount).toBe(explicitKnuthPlass.lineCount);
    expect(implicit.lines).toEqual(explicitKnuthPlass.lines);
    expect(explicitGreedy.lineCount).toBeGreaterThan(0);
  });
});

describe("layoutParagraphLines: alignment", () => {
  it("aligns start to the left edge for a left-to-right paragraph", () => {
    const text = "hi";
    const maxWidth = 20;
    const result = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth, align: "start" });
    expect(leftEdge(result.glyphs)).toBeCloseTo(0, 5);
  });

  it("aligns end to the right edge for a left-to-right paragraph", () => {
    const text = "hi";
    const maxWidth = 20;
    const result = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth, align: "end" });
    expect(rightEdge(result.glyphs)).toBeCloseTo(maxWidth, 5);
  });

  it("centers a line within maxWidth", () => {
    const text = "hi";
    const maxWidth = 20;
    const result = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth, align: "center" });
    const width = rightEdge(result.glyphs) - leftEdge(result.glyphs);
    expect(leftEdge(result.glyphs)).toBeCloseTo((maxWidth - width) / 2, 5);
  });
});

describe("layoutParagraphLines: right-to-left and mixed-direction paragraphs", () => {
  it("aligns a right-to-left paragraph's start to the right edge, not the left", () => {
    const text = "مرحبا بك";
    const maxWidth = 20;
    const result = layoutParagraphLines([{ text }], {
      font: NOTO_SANS_ARABIC,
      maxWidth,
      direction: "rtl",
      align: "start",
    });

    expect(result.lineCount).toBe(1);
    expect(rightEdge(result.glyphs)).toBeCloseTo(maxWidth, 5);
    expect(leftEdge(result.glyphs)).toBeGreaterThan(0);
  });

  it("aligns a right-to-left paragraph's end to the left edge, not the right", () => {
    const text = "مرحبا بك";
    const maxWidth = 20;
    const result = layoutParagraphLines([{ text }], {
      font: NOTO_SANS_ARABIC,
      maxWidth,
      direction: "rtl",
      align: "end",
    });

    expect(leftEdge(result.glyphs)).toBeCloseTo(0, 5);
  });

  it("lays out a mixed left-to-right paragraph with an embedded right-to-left phrase without crashing or losing glyphs", () => {
    const text = "AB مرحبا CD";
    const maxWidth = measureUnwrappedWidth(ROBOTO_FLEX, text) + 1;
    const result = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth });

    expect(result.lineCount).toBe(1);
    // Every non-whitespace cluster from the source text should have
    // produced at least one glyph (nothing silently dropped by slicing).
    const coveredClusters = new Set(result.glyphs.map((g) => g.cluster));
    expect(coveredClusters.has(0)).toBe(true); // "A"
    expect(coveredClusters.has(9)).toBe(true); // "C" in " CD"
  });
});

describe("layoutParagraphLines: inline style spans", () => {
  it("attributes each glyph's resolved color to its own span", () => {
    const red: ColorRGBA = [1, 0, 0, 1];
    const blue: ColorRGBA = [0, 0, 1, 1];
    const result = layoutParagraphLines(
      [
        { text: "red ", style: { color: red } },
        { text: "blue", style: { color: blue } },
      ],
      { font: ROBOTO_FLEX, maxWidth: 1000 },
    );

    const redGlyphs = result.glyphs.filter((g) => g.cluster < 4);
    const blueGlyphs = result.glyphs.filter((g) => g.cluster >= 4);
    expect(redGlyphs.length).toBeGreaterThan(0);
    expect(blueGlyphs.length).toBeGreaterThan(0);
    for (const glyph of redGlyphs) {
      expect(glyph.color).toEqual(red);
    }
    for (const glyph of blueGlyphs) {
      expect(glyph.color).toEqual(blue);
    }
  });

  it("scales a span's own glyph advances by its fontSizeScale", () => {
    const base = layoutParagraphLines([{ text: "AAAA" }], { font: ROBOTO_FLEX, maxWidth: 1000 });
    const scaled = layoutParagraphLines([{ text: "AAAA", style: { fontSizeScale: 2 } }], {
      font: ROBOTO_FLEX,
      maxWidth: 1000,
    });

    expect(rightEdge(scaled.glyphs)).toBeCloseTo(rightEdge(base.glyphs) * 2, 5);
  });

  it("adds a span's own tracking to every one of its glyphs' advances", () => {
    const base = layoutParagraphLines([{ text: "AAAA" }], { font: ROBOTO_FLEX, maxWidth: 1000 });
    const tracked = layoutParagraphLines([{ text: "AAAA", style: { tracking: 0.1 } }], {
      font: ROBOTO_FLEX,
      maxWidth: 1000,
    });

    // 4 glyphs, each advance now includes +0.1 em of tracking.
    expect(rightEdge(tracked.glyphs)).toBeCloseTo(rightEdge(base.glyphs) + 0.1 * 4, 5);
  });

  it("shapes a differently-styled span with its own distinct font", () => {
    const result = layoutParagraphLines(
      [{ text: "مرحبا", style: { font: NOTO_SANS_ARABIC } }],
      { font: ROBOTO_FLEX, maxWidth: 1000 },
    );
    expect(result.glyphs.length).toBeGreaterThan(0);
    expect(result.glyphs.every((g) => g.font === NOTO_SANS_ARABIC)).toBe(true);
  });
});

describe("layoutParagraphLines: baseline grid and paragraph spacing", () => {
  it("spaces consecutive lines by the font's own metrics-derived line height by default", () => {
    const text = "one two three four five six seven eight nine ten";
    const maxWidth = measureUnwrappedWidth(ROBOTO_FLEX, text) / 3;
    const result = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth });

    expect(result.lineCount).toBeGreaterThan(1);
    expect(result.lines[0]?.baselineY).toBe(0);
    expect(result.lines[1]?.baselineY).toBeCloseTo(-defaultLineHeight(ROBOTO_FLEX), 5);
  });

  it("honors an explicit lineHeight override instead of the font-metrics default", () => {
    const text = "one two three four five six seven eight nine ten";
    const maxWidth = measureUnwrappedWidth(ROBOTO_FLEX, text) / 3;
    const result = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth, lineHeight: 3 });

    expect(result.lines[1]?.baselineY).toBeCloseTo(-3, 5);
  });

  it("adds paragraphSpacing on top of lineHeight between blank-line-separated blocks", () => {
    const text = "AAA\n\nBBB";
    const lineHeight = defaultLineHeight(ROBOTO_FLEX);

    const withoutSpacing = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth: 1000 });
    const withSpacing = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth: 1000, paragraphSpacing: 5 });

    expect(withoutSpacing.lineCount).toBe(2);
    expect(withSpacing.lineCount).toBe(2);
    expect(withoutSpacing.lines[1]?.baselineY).toBeCloseTo(-lineHeight, 5);
    expect(withSpacing.lines[1]?.baselineY).toBeCloseTo(-lineHeight - 5, 5);
  });

  it("treats a single newline as a hard line break within one block, with no paragraphSpacing added", () => {
    const text = "AAA\nBBB";
    const lineHeight = defaultLineHeight(ROBOTO_FLEX);
    const result = layoutParagraphLines([{ text }], { font: ROBOTO_FLEX, maxWidth: 1000, paragraphSpacing: 5 });

    expect(result.lineCount).toBe(2);
    expect(result.lines[1]?.baselineY).toBeCloseTo(-lineHeight, 5);
  });
});
