import { describe, expect, it } from "vitest";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import { createMsdfAtlasCache } from "./msdf-atlas-cache.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";
import { computeTextRenderCacheKey, prepareTextRenderData } from "./text-render-data.js";

const ROBOTO_FLEX = parseFontWithFontkit(loadFixtureFont("RobotoFlex-Variable"));
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("prepareTextRenderData", () => {
  it("shapes, generates an atlas for, and lays out a single line of text", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "Vote", {}, createMsdfAtlasCache());

    expect(data.lineCount).toBe(1);
    expect(data.glyphs).toHaveLength(4);
    expect(data.atlasPages).toHaveLength(1);
    expect(Array.from(data.atlasPages[0]?.png.slice(0, 8) ?? [])).toEqual(PNG_SIGNATURE);
  });

  it("splits content on explicit newlines into independently laid-out lines", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "Vo\nte", {}, createMsdfAtlasCache());

    expect(data.lineCount).toBe(2);
    expect(new Set(data.glyphs.map((g) => g.lineIndex))).toEqual(new Set([0, 1]));
  });

  it("is deterministic across repeated calls", async () => {
    const cache = createMsdfAtlasCache();
    const first = await prepareTextRenderData(ROBOTO_FLEX, "Vote", {}, cache);
    const second = await prepareTextRenderData(ROBOTO_FLEX, "Vote", {}, cache);

    expect(second).toEqual(first);
  });
});

describe("computeTextRenderCacheKey", () => {
  it("differs when content differs", () => {
    const a = computeTextRenderCacheKey(ROBOTO_FLEX, "Vote");
    const b = computeTextRenderCacheKey(ROBOTO_FLEX, "Note");
    expect(a).not.toBe(b);
  });

  it("is stable for the same font and content", () => {
    const a = computeTextRenderCacheKey(ROBOTO_FLEX, "Vote");
    const b = computeTextRenderCacheKey(ROBOTO_FLEX, "Vote");
    expect(a).toBe(b);
  });

  it("differs when shaping-relevant options differ", () => {
    const a = computeTextRenderCacheKey(ROBOTO_FLEX, "Vote", { features: { kern: true } });
    const b = computeTextRenderCacheKey(ROBOTO_FLEX, "Vote", { features: { kern: false } });
    expect(a).not.toBe(b);
  });
});
