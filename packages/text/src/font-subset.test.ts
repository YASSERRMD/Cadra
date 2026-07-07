import { describe, expect, it } from "vitest";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import { codePointSetKey, subsetFontToCodePoints } from "./font-subset.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";

const ROBOTO_FLEX = loadFixtureFont("RobotoFlex-Variable");
const H = "H".codePointAt(0) as number;
const I = "i".codePointAt(0) as number;

describe("subsetFontToCodePoints", () => {
  it("produces a real, much smaller font containing only the requested glyphs", async () => {
    const original = parseFontWithFontkit(ROBOTO_FLEX);
    const subsetBytes = await subsetFontToCodePoints(ROBOTO_FLEX, [H, I]);
    const subset = parseFontWithFontkit(subsetBytes);

    expect(subsetBytes.byteLength).toBeLessThan(ROBOTO_FLEX.byteLength / 10);
    expect(subset.characterSet.has(H)).toBe(true);
    expect(subset.characterSet.has(I)).toBe(true);
    expect(subset.characterSet.size).toBeLessThan(original.characterSet.size);
  });

  it("is deterministic: the same bytes and code points always produce byte-identical output", async () => {
    const first = await subsetFontToCodePoints(ROBOTO_FLEX, [H, I]);
    const second = await subsetFontToCodePoints(ROBOTO_FLEX, [H, I]);

    expect(Array.from(second)).toEqual(Array.from(first));
  });

  it("does not depend on the order code points were supplied in", async () => {
    const forward = await subsetFontToCodePoints(ROBOTO_FLEX, [H, I]);
    const reversed = await subsetFontToCodePoints(ROBOTO_FLEX, [I, H]);

    expect(Array.from(reversed)).toEqual(Array.from(forward));
  });
});

describe("codePointSetKey", () => {
  it("is independent of insertion order", () => {
    expect(codePointSetKey([H, I])).toBe(codePointSetKey([I, H]));
  });

  it("is independent of duplicate entries", () => {
    expect(codePointSetKey([H, I])).toBe(codePointSetKey([H, H, I, I]));
  });

  it("differs for different code point sets", () => {
    expect(codePointSetKey([H, I])).not.toBe(codePointSetKey([H]));
  });

  it("is deterministic across repeated calls", () => {
    expect(codePointSetKey([H, I, 0x0627])).toBe(codePointSetKey([H, I, 0x0627]));
  });
});
