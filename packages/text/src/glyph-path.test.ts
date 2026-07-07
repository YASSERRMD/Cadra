import { describe, expect, it } from "vitest";

import { getGlyphPathCommands } from "./glyph-path.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";

const ROBOTO_FLEX = loadFixtureFont("RobotoFlex-Variable");
const CONTENT_HASH = "test-roboto-flex";
const V_GLYPH_ID = 57;

describe("getGlyphPathCommands", () => {
  it("extracts a real, non-empty outline for a glyph id, in Y-up em space", () => {
    const commands = getGlyphPathCommands(ROBOTO_FLEX, CONTENT_HASH, V_GLYPH_ID);

    expect(commands.length).toBeGreaterThan(0);
    expect(commands[0]?.type).toBe("move");
    // TrueType glyf contours are implicitly closed; opentype.js does not
    // emit an explicit "close" command for them (verified empirically), so
    // a consumer must close back to each contour's own "move" itself.
    expect(commands.some((c) => c.type === "close")).toBe(false);

    const ys = commands.flatMap((c) => ("y" in c ? [c.y] : []));
    // A capital letter's outline sits mostly at or above the baseline (y >= 0)
    // in Y-up space; opentype.js's own raw output is Y-down (mostly negative).
    expect(Math.max(...ys)).toBeGreaterThan(0);
    expect(ys.filter((y) => y < 0).length).toBeLessThan(ys.length / 2);
  });

  it("is deterministic across repeated calls", () => {
    const first = getGlyphPathCommands(ROBOTO_FLEX, CONTENT_HASH, V_GLYPH_ID);
    const second = getGlyphPathCommands(ROBOTO_FLEX, CONTENT_HASH, V_GLYPH_ID);

    expect(second).toEqual(first);
  });
});
