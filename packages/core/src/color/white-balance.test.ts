import { describe, expect, it } from "vitest";

import { computeWhiteBalanceGain } from "./white-balance.js";

describe("computeWhiteBalanceGain: reference daylight (6500K, no tint)", () => {
  it("gives an approximately neutral (1, 1, 1) gain, within about 2%", () => {
    const [r, g, b] = computeWhiteBalanceGain(6500, 0);
    expect(r).toBeCloseTo(1, 1);
    expect(g).toBeCloseTo(1, 1);
    expect(b).toBeCloseTo(1, 1);
  });
});

describe("computeWhiteBalanceGain: temperature", () => {
  it("boosts blue and reduces red to correct for a warm (low Kelvin) illuminant", () => {
    const [r, g, b] = computeWhiteBalanceGain(3000, 0);
    expect(r).toBeLessThan(1);
    expect(b).toBeGreaterThan(1);
    expect(g).toBeGreaterThan(0);
  });

  it("boosts red and reduces blue to correct for a cool (high Kelvin) illuminant", () => {
    const [r, , b] = computeWhiteBalanceGain(9000, 0);
    expect(r).toBeGreaterThan(1);
    expect(b).toBeLessThan(1);
  });

  it("clamps out-of-range temperatures rather than producing nonsensical gains", () => {
    const veryLow = computeWhiteBalanceGain(100, 0);
    const atFloor = computeWhiteBalanceGain(1000, 0);
    expect(veryLow).toEqual(atFloor);

    const veryHigh = computeWhiteBalanceGain(100_000, 0);
    const atCeiling = computeWhiteBalanceGain(40_000, 0);
    expect(veryHigh).toEqual(atCeiling);
  });
});

describe("computeWhiteBalanceGain: tint", () => {
  it("positive tint reduces the green gain (shifts the corrected output toward magenta)", () => {
    const [, neutralG] = computeWhiteBalanceGain(6500, 0);
    const [, tintedG] = computeWhiteBalanceGain(6500, 0.5);
    expect(tintedG).toBeLessThan(neutralG);
  });

  it("negative tint increases the green gain (shifts toward green)", () => {
    const [, neutralG] = computeWhiteBalanceGain(6500, 0);
    const [, tintedG] = computeWhiteBalanceGain(6500, -0.5);
    expect(tintedG).toBeGreaterThan(neutralG);
  });

  it("leaves red and blue gain unaffected by tint", () => {
    const [neutralR, , neutralB] = computeWhiteBalanceGain(6500, 0);
    const [tintedR, , tintedB] = computeWhiteBalanceGain(6500, 0.7);
    expect(tintedR).toBeCloseTo(neutralR, 10);
    expect(tintedB).toBeCloseTo(neutralB, 10);
  });
});

describe("computeWhiteBalanceGain: determinism", () => {
  it("is a pure function of its own inputs", () => {
    const first = computeWhiteBalanceGain(4500, 0.2);
    const second = computeWhiteBalanceGain(4500, 0.2);
    expect(second).toEqual(first);
  });
});
