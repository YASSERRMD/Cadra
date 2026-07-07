import { describe, expect, it } from "vitest";

import { clampToAxisRange, findNamedInstance, type VariationAxis } from "./variable-font.js";

const WEIGHT_AXIS: VariationAxis = { tag: "wght", name: "Weight", min: 100, default: 400, max: 1000 };

describe("clampToAxisRange", () => {
  it("passes values already within range through unchanged", () => {
    expect(clampToAxisRange(WEIGHT_AXIS, 550)).toBe(550);
  });

  it("clamps values below the minimum", () => {
    expect(clampToAxisRange(WEIGHT_AXIS, 0)).toBe(100);
  });

  it("clamps values above the maximum", () => {
    expect(clampToAxisRange(WEIGHT_AXIS, 5000)).toBe(1000);
  });
});

describe("findNamedInstance", () => {
  const instances = [
    { name: "Regular", coordinates: { wght: 400 } },
    { name: "Bold", coordinates: { wght: 700 } },
  ];

  it("finds an instance by exact name", () => {
    expect(findNamedInstance(instances, "Bold")?.coordinates["wght"]).toBe(700);
  });

  it("returns undefined for an unknown name", () => {
    expect(findNamedInstance(instances, "Ultra Black")).toBeUndefined();
  });
});
