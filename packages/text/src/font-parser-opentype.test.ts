import * as opentype from "opentype.js";
import { describe, expect, it } from "vitest";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import { parseFontWithOpentype, resolveOpentypeModuleExports } from "./font-parser-opentype.js";
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

/**
 * Regression coverage for a real bug (Phase 71's golden-frame harness):
 * Vitest's own module resolution for `opentype.js` happens to expose
 * `parse` as a top-level named export directly, which is why every test
 * above passes regardless of whether `resolveOpentypeModuleExports` exists
 * at all. Plain Node's own ESM/CJS interop for the actually-installed
 * `opentype.js@2.0.0` UMD bundle does not: it exposes the real exports only
 * through a synthetic `default` property (verified directly against a real
 * `node` process; see `font-parser-opentype.ts`'s own doc). These tests
 * exercise `resolveOpentypeModuleExports` directly against both shapes
 * (rather than trying to fake how `opentype.js` itself resolves, which
 * would need module mocking this codebase otherwise avoids everywhere
 * else), so a future edit that reintroduces a bare `opentype.parse` call
 * fails here even though it would still pass every test above.
 */
describe("resolveOpentypeModuleExports", () => {
  it("returns the namespace import unchanged when it already carries a top-level parse function", () => {
    expect(resolveOpentypeModuleExports(opentype)).toBe(opentype);
  });

  it("unwraps a synthetic default when the namespace import has no top-level parse function", () => {
    const wrapped = { default: opentype } as unknown as typeof opentype;

    expect(resolveOpentypeModuleExports(wrapped)).toBe(opentype);
  });

  it("picks a module whose resolution actually has a callable parse, end to end", () => {
    const wrapped = { default: opentype } as unknown as typeof opentype;

    expect(typeof resolveOpentypeModuleExports(opentype).parse).toBe("function");
    expect(typeof resolveOpentypeModuleExports(wrapped).parse).toBe("function");
  });
});
