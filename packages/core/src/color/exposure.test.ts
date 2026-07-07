import { describe, expect, it } from "vitest";

import { resolveExposureMultiplier } from "./exposure.js";

describe("resolveExposureMultiplier", () => {
  it("gives an identity multiplier of 1 at 0 stops", () => {
    expect(resolveExposureMultiplier(0)).toBe(1);
  });

  it("doubles per +1 stop", () => {
    expect(resolveExposureMultiplier(1)).toBeCloseTo(2, 10);
    expect(resolveExposureMultiplier(2)).toBeCloseTo(4, 10);
    expect(resolveExposureMultiplier(3)).toBeCloseTo(8, 10);
  });

  it("halves per -1 stop", () => {
    expect(resolveExposureMultiplier(-1)).toBeCloseTo(0.5, 10);
    expect(resolveExposureMultiplier(-2)).toBeCloseTo(0.25, 10);
  });

  it("supports fractional stops", () => {
    expect(resolveExposureMultiplier(0.5)).toBeCloseTo(Math.SQRT2, 10);
  });
});
