import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseFontWithFontkit } from "@cadra/text";
import { describe, expect, it } from "vitest";

import { createLoadAdditionalAsset } from "./fallback-font-resolver.js";
import type { SatoriLayerFont } from "./render-layer-to-svg.js";

function loadFixtureFont(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`../../text/test-fixtures/fonts/${name}.ttf`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

/**
 * Both fixture fonts below are real Noto fonts, which (like most of the
 * Noto family) also carry basic Latin coverage alongside their own named
 * script - verified empirically before writing these tests, since an
 * assumption that a "Tamil font" or "Arabic font" covers only its own
 * script would have made the "no font covers this text at all" test below
 * wrong. Neither covers the other's own script, nor a private-use-area
 * code point (used as this suite's stand-in for "no font anywhere covers
 * this").
 */
const TAMIL_FONT: SatoriLayerFont = {
  family: "Noto Sans Tamil",
  font: parseFontWithFontkit(loadFixtureFont("NotoSansTamil-Variable")),
};
const ARABIC_FONT: SatoriLayerFont = {
  family: "Noto Sans Arabic",
  font: parseFontWithFontkit(loadFixtureFont("NotoSansArabic-Variable")),
};

describe("createLoadAdditionalAsset: emoji bucket", () => {
  it("resolves a real emoji grapheme to a data: URI string", async () => {
    const loadAdditionalAsset = createLoadAdditionalAsset([]);
    const result = await loadAdditionalAsset("emoji", "\u{1F600}");
    expect(typeof result).toBe("string");
    expect(result).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("resolves to an empty array, not a string, when the emoji has no asset", async () => {
    const loadAdditionalAsset = createLoadAdditionalAsset([]);
    const result = await loadAdditionalAsset("emoji", "\u{E000}");
    expect(result).toEqual([]);
  });
});

describe("createLoadAdditionalAsset: fallback font bucket", () => {
  it("returns the one fallback font that covers the missing text's own script", async () => {
    const loadAdditionalAsset = createLoadAdditionalAsset([TAMIL_FONT, ARABIC_FONT]);
    const result = await loadAdditionalAsset("ta-IN", "தமிழ்");

    expect(Array.isArray(result)).toBe(true);
    const fonts = result as Array<{ name: string }>;
    expect(fonts).toHaveLength(1);
    expect(fonts[0]?.name).toBe("Noto Sans Tamil");
  });

  it("returns every fallback font that covers at least one code point, when more than one do", async () => {
    const mixedTamilAndArabic = "தا"; // one Tamil letter, one Arabic letter
    const loadAdditionalAsset = createLoadAdditionalAsset([TAMIL_FONT, ARABIC_FONT]);
    const result = await loadAdditionalAsset("unknown", mixedTamilAndArabic);

    const fonts = result as Array<{ name: string }>;
    const names = fonts.map((font) => font.name).sort();
    expect(names).toEqual(["Noto Sans Arabic", "Noto Sans Tamil"]);
  });

  it("returns an empty array when no fallback font covers any of the missing text", async () => {
    const loadAdditionalAsset = createLoadAdditionalAsset([TAMIL_FONT, ARABIC_FONT]);
    const result = await loadAdditionalAsset("unknown", "\u{E000}");
    expect(result).toEqual([]);
  });

  it("returns an empty array when no fallback fonts were supplied at all", async () => {
    const loadAdditionalAsset = createLoadAdditionalAsset([]);
    const result = await loadAdditionalAsset("ta-IN", "தமிழ்");
    expect(result).toEqual([]);
  });

  it("subsets the returned font down to real, non-empty font bytes", async () => {
    const loadAdditionalAsset = createLoadAdditionalAsset([TAMIL_FONT]);
    const result = await loadAdditionalAsset("ta-IN", "தமிழ்");
    const fonts = result as Array<{ name: string; data: Buffer; weight: number; style: string }>;
    expect(fonts[0]?.data.length).toBeGreaterThan(0);
    expect(fonts[0]?.weight).toBe(400);
    expect(fonts[0]?.style).toBe("normal");
  });
});
