import { describe, expect, it } from "vitest";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import { parseFontWithOpentype } from "./font-parser-opentype.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";

const ROBOTO_FLEX = loadFixtureFont("RobotoFlex-Variable");

describe("parseFontWithOpentype", () => {
  it("parses real glyph metrics, resolving the platform-nested name table correctly", () => {
    const parsed = parseFontWithOpentype(ROBOTO_FLEX);

    expect(parsed.backend).toBe("opentype");
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

  it("agrees with the fontkit backend on unambiguous, backend-independent facts", () => {
    const viaFontkit = parseFontWithFontkit(ROBOTO_FLEX);
    const viaOpentype = parseFontWithOpentype(ROBOTO_FLEX);

    expect(viaOpentype.metrics.unitsPerEm).toBe(viaFontkit.metrics.unitsPerEm);
    expect(viaOpentype.familyName).toBe(viaFontkit.familyName);
    expect(viaOpentype.characterSet.has("A".codePointAt(0) as number)).toBe(true);
  });

  it("does not populate variable-font introspection (that is fontkit's job)", () => {
    const parsed = parseFontWithOpentype(ROBOTO_FLEX);

    expect(parsed.variationAxes).toEqual([]);
    expect(parsed.namedInstances).toEqual([]);
  });

  it("reports supported code points and GSUB/GPOS feature tags", () => {
    const parsed = parseFontWithOpentype(ROBOTO_FLEX);

    expect(parsed.characterSet.size).toBeGreaterThan(100);
    expect(parsed.availableFeatures).toContain("kern");
    expect(parsed.availableFeatures).toContain("liga");
  });

  it("is deterministic across repeated parses", () => {
    const first = parseFontWithOpentype(ROBOTO_FLEX);
    const second = parseFontWithOpentype(ROBOTO_FLEX);

    expect(second.contentHash).toBe(first.contentHash);
    expect(second.metrics).toEqual(first.metrics);
    expect(second.availableFeatures.slice().sort()).toEqual(first.availableFeatures.slice().sort());
  });
});
