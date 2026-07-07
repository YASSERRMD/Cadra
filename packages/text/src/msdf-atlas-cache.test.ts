import { describe, expect, it } from "vitest";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import { computeMsdfAtlasCacheKey, createMsdfAtlasCache } from "./msdf-atlas-cache.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";

const ROBOTO_FLEX = parseFontWithFontkit(loadFixtureFont("RobotoFlex-Variable"));
const GLYPH_IDS = new Set([57, 82, 87, 72]);

describe("computeMsdfAtlasCacheKey", () => {
  it("is independent of glyph id insertion order", () => {
    const forward = computeMsdfAtlasCacheKey(ROBOTO_FLEX, [57, 82, 87, 72]);
    const reversed = computeMsdfAtlasCacheKey(ROBOTO_FLEX, [72, 87, 82, 57]);
    expect(reversed).toBe(forward);
  });

  it("treats omitted options and explicitly-default options identically", () => {
    const omitted = computeMsdfAtlasCacheKey(ROBOTO_FLEX, GLYPH_IDS);
    const explicit = computeMsdfAtlasCacheKey(ROBOTO_FLEX, GLYPH_IDS, {
      fontSize: 42,
      range: 4,
      maxWidth: 2048,
      maxHeight: 2048,
      padding: 2,
    });
    expect(explicit).toBe(omitted);
  });

  it("differs when the glyph set differs", () => {
    const a = computeMsdfAtlasCacheKey(ROBOTO_FLEX, [57]);
    const b = computeMsdfAtlasCacheKey(ROBOTO_FLEX, [57, 82]);
    expect(a).not.toBe(b);
  });

  it("differs when options differ", () => {
    const a = computeMsdfAtlasCacheKey(ROBOTO_FLEX, GLYPH_IDS, { fontSize: 42 });
    const b = computeMsdfAtlasCacheKey(ROBOTO_FLEX, GLYPH_IDS, { fontSize: 64 });
    expect(a).not.toBe(b);
  });
});

describe("createMsdfAtlasCache", () => {
  it("generates an atlas once and resolves the same request to the same cached result", async () => {
    const cache = createMsdfAtlasCache();
    const first = await cache.getOrGenerate(ROBOTO_FLEX, GLYPH_IDS);
    const second = await cache.getOrGenerate(ROBOTO_FLEX, GLYPH_IDS);

    expect(second).toBe(first);
  });

  it("reports has() correctly once a request has been made", async () => {
    const cache = createMsdfAtlasCache();
    const key = computeMsdfAtlasCacheKey(ROBOTO_FLEX, GLYPH_IDS);
    expect(cache.has(key)).toBe(false);

    await cache.getOrGenerate(ROBOTO_FLEX, GLYPH_IDS);
    expect(cache.has(key)).toBe(true);
  });

  it("dedupes concurrent requests for the same key to a single generation", async () => {
    const cache = createMsdfAtlasCache();
    const [first, second] = await Promise.all([
      cache.getOrGenerate(ROBOTO_FLEX, GLYPH_IDS),
      cache.getOrGenerate(ROBOTO_FLEX, GLYPH_IDS),
    ]);

    expect(second).toBe(first);
  });
});
