import { describe, expect, it } from "vitest";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";
import { bakeVariationInstance, resolveFullVariationPin } from "./variation-instance.js";

const ROBOTO_FLEX_BYTES = loadFixtureFont("RobotoFlex-Variable");
const ROBOTO_FLEX = parseFontWithFontkit(ROBOTO_FLEX_BYTES);
const CODE_POINTS = Array.from("Vote", (char) => char.codePointAt(0) as number);

describe("resolveFullVariationPin", () => {
  it("pins a requested axis and defaults every other axis to its own font-declared value", () => {
    const pin = resolveFullVariationPin(ROBOTO_FLEX, { wght: 700 });
    expect(pin["wght"]).toBe(700);
    expect(pin["wdth"]).toBe(100);
    expect(pin["slnt"]).toBe(0);
  });

  it("pins every axis to its own default when nothing is requested", () => {
    const pin = resolveFullVariationPin(ROBOTO_FLEX, undefined);
    expect(pin["wght"]).toBe(400);
    expect(pin["wdth"]).toBe(100);
    expect(pin["slnt"]).toBe(0);
  });
});

describe("bakeVariationInstance", () => {
  it("produces real, non-empty static font bytes", async () => {
    const baked = await bakeVariationInstance(ROBOTO_FLEX, CODE_POINTS, { wght: 700 });
    expect(baked.length).toBeGreaterThan(0);
  });

  it("removes every variation axis from the baked instance (genuinely static, not just re-labeled)", async () => {
    const baked = await bakeVariationInstance(ROBOTO_FLEX, CODE_POINTS, { wght: 700 });
    const reparsed = parseFontWithFontkit(baked);
    expect(reparsed.variationAxes).toEqual([]);
  });

  it("produces different glyph outline bytes for a meaningfully different weight", async () => {
    const light = await bakeVariationInstance(ROBOTO_FLEX, CODE_POINTS, { wght: 100 });
    const bold = await bakeVariationInstance(ROBOTO_FLEX, CODE_POINTS, { wght: 900 });
    expect(Buffer.from(light).equals(Buffer.from(bold))).toBe(false);
  });

  it("is deterministic: the same font, code points, and coordinates always bake to the same bytes", async () => {
    const first = await bakeVariationInstance(ROBOTO_FLEX, CODE_POINTS, { wght: 700 });
    const second = await bakeVariationInstance(ROBOTO_FLEX, CODE_POINTS, { wght: 700 });
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });
});
