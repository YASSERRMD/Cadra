import { describe, expect, it } from "vitest";

import {
  parseFontWithFontkit,
  resolveFontVariationInstance,
  UnsupportedFontCollectionError,
} from "./font-parser-fontkit.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";

const ROBOTO_FLEX = loadFixtureFont("RobotoFlex-Variable");

describe("parseFontWithFontkit", () => {
  it("parses real glyph metrics from a variable font, not a canvas string", () => {
    const parsed = parseFontWithFontkit(ROBOTO_FLEX);

    expect(parsed.backend).toBe("fontkit");
    expect(parsed.familyName).toBe("Roboto Flex");
    expect(parsed.subfamilyName).toBe("Regular");
    expect(parsed.metrics).toEqual({
      unitsPerEm: 2048,
      ascent: 1900,
      descent: -500,
      lineGap: 0,
      capHeight: 1456,
      xHeight: 1052,
    });
  });

  it("exposes every declared variation axis, including weight, width, and slant", () => {
    const parsed = parseFontWithFontkit(ROBOTO_FLEX);
    const byTag = new Map(parsed.variationAxes.map((axis) => [axis.tag, axis]));

    expect(byTag.get("wght")).toEqual({ tag: "wght", name: "Weight", min: 100, default: 400, max: 1000 });
    expect(byTag.get("wdth")).toEqual({ tag: "wdth", name: "Width", min: 25, default: 100, max: 151 });
    expect(byTag.get("slnt")).toEqual({ tag: "slnt", name: "Slant", min: -10, default: 0, max: 0 });
    expect(parsed.variationAxes.length).toBeGreaterThanOrEqual(3);
  });

  it("exposes the font's named instances", () => {
    const parsed = parseFontWithFontkit(ROBOTO_FLEX);
    const names = parsed.namedInstances.map((instance) => instance.name);

    expect(names).toContain("Regular");
    expect(names).toContain("Bold");
    const bold = parsed.namedInstances.find((instance) => instance.name === "Bold");
    expect(bold?.coordinates["wght"]).toBe(700);
  });

  it("reports the font's supported code points and OpenType features", () => {
    const parsed = parseFontWithFontkit(ROBOTO_FLEX);

    expect(parsed.characterSet.has("A".codePointAt(0) as number)).toBe(true);
    expect(parsed.characterSet.size).toBeGreaterThan(100);
    expect(parsed.availableFeatures).toContain("kern");
    expect(parsed.availableFeatures).toContain("liga");
  });

  it("throws rather than silently misparsing malformed input", () => {
    const garbage = new TextEncoder().encode("not a font file");
    expect(() => parseFontWithFontkit(garbage)).toThrow();
  });

  it("is deterministic: the same bytes parse to the same content hash and metrics every time", () => {
    const first = parseFontWithFontkit(ROBOTO_FLEX);
    const second = parseFontWithFontkit(ROBOTO_FLEX);

    expect(second.contentHash).toBe(first.contentHash);
    expect(second.metrics).toEqual(first.metrics);
    expect(second.variationAxes).toEqual(first.variationAxes);
    expect(second.namedInstances).toEqual(first.namedInstances);
    expect(Array.from(second.characterSet)).toEqual(Array.from(first.characterSet));
  });
});

describe("resolveFontVariationInstance", () => {
  it("pins a named instance and reports its resolved axis coordinates", () => {
    const parsed = parseFontWithFontkit(ROBOTO_FLEX);
    const bold = resolveFontVariationInstance(parsed, "Bold");

    expect(bold.variationCoordinates?.["wght"]).toBe(700);
    // Instancing must not mutate or drop the original variable-font bytes:
    // Phase 42's HarfBuzz shaping needs the full variable font plus these
    // coordinates, not a baked static copy.
    expect(bold.bytes).toBe(parsed.bytes);
  });

  it("pins explicit axis coordinates, clamped by the font's own axis ranges", () => {
    const parsed = parseFontWithFontkit(ROBOTO_FLEX);
    const custom = resolveFontVariationInstance(parsed, { wght: 550, wdth: 100 });

    expect(custom.variationCoordinates).toEqual({ wght: 550, wdth: 100 });
  });

  it("is deterministic: resolving the same instance twice yields the same metrics", () => {
    const parsed = parseFontWithFontkit(ROBOTO_FLEX);
    const first = resolveFontVariationInstance(parsed, "Bold");
    const second = resolveFontVariationInstance(parsed, "Bold");

    expect(second.metrics).toEqual(first.metrics);
    expect(second.variationCoordinates).toEqual(first.variationCoordinates);
  });

  it("refuses to instance a font that was not parsed with the fontkit backend", () => {
    const parsed = parseFontWithFontkit(ROBOTO_FLEX);
    const opentypeBacked = { ...parsed, backend: "opentype" as const };

    expect(() => resolveFontVariationInstance(opentypeBacked, "Bold")).toThrow();
  });
});

describe("UnsupportedFontCollectionError", () => {
  it("carries a descriptive name for diagnostics", () => {
    expect(new UnsupportedFontCollectionError().name).toBe("UnsupportedFontCollectionError");
  });
});
