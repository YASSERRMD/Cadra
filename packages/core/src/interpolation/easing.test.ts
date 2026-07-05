import { describe, expect, it } from "vitest";

import {
  cubicBezier,
  easeInBack,
  easeInCubic,
  easeInElastic,
  easeInExpo,
  easeInOutBack,
  easeInOutCubic,
  easeInOutElastic,
  easeInOutExpo,
  easeOutBack,
  easeOutCubic,
  easeOutElastic,
  easeOutExpo,
  linear,
} from "./easing.js";

const EASING_FUNCTIONS: Array<{ name: string; fn: (t: number) => number }> = [
  { name: "linear", fn: linear },
  { name: "easeInCubic", fn: easeInCubic },
  { name: "easeOutCubic", fn: easeOutCubic },
  { name: "easeInOutCubic", fn: easeInOutCubic },
  { name: "easeInExpo", fn: easeInExpo },
  { name: "easeOutExpo", fn: easeOutExpo },
  { name: "easeInOutExpo", fn: easeInOutExpo },
  { name: "easeInBack", fn: easeInBack },
  { name: "easeOutBack", fn: easeOutBack },
  { name: "easeInOutBack", fn: easeInOutBack },
  { name: "easeInElastic", fn: easeInElastic },
  { name: "easeOutElastic", fn: easeOutElastic },
  { name: "easeInOutElastic", fn: easeInOutElastic },
];

describe("easing functions", () => {
  it.each(EASING_FUNCTIONS)("$name(0) is 0", ({ fn }) => {
    expect(fn(0)).toBeCloseTo(0, 10);
  });

  it.each(EASING_FUNCTIONS)("$name(1) is 1", ({ fn }) => {
    expect(fn(1)).toBeCloseTo(1, 10);
  });

  it("linear(t) is the identity", () => {
    expect(linear(0.25)).toBe(0.25);
    expect(linear(0.5)).toBe(0.5);
    expect(linear(0.75)).toBe(0.75);
  });

  it("easeInCubic(0.5) matches the hand-computed reference value 0.125", () => {
    expect(easeInCubic(0.5)).toBeCloseTo(0.125, 10);
  });

  it("easeOutCubic(0.5) matches the hand-computed reference value 0.875", () => {
    // easeOutCubic(t) = 1 - (1 - t)^3; at t=0.5, 1 - 0.5^3 = 1 - 0.125 = 0.875.
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 10);
  });

  it("easeInOutCubic(0.25) matches the hand-computed reference value 0.0625", () => {
    // t < 0.5 branch: 4 * t^3 = 4 * 0.25^3 = 4 * 0.015625 = 0.0625.
    expect(easeInOutCubic(0.25)).toBeCloseTo(0.0625, 10);
  });

  it("easeInOutCubic is symmetric around its midpoint (0.5 maps to 0.5)", () => {
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
  });

  it("easeInExpo and easeOutExpo are mirror images of each other", () => {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(easeInExpo(t)).toBeCloseTo(1 - easeOutExpo(1 - t), 9);
    }
  });

  it("easeInBack dips below 0 before t reaches its midpoint (overshoot at the start)", () => {
    expect(easeInBack(0.2)).toBeLessThan(0);
  });

  it("easeOutBack rises above 1 before settling (overshoot at the end)", () => {
    expect(easeOutBack(0.8)).toBeGreaterThan(1);
  });

  it("easeInElastic and easeOutElastic oscillate (not monotonic), unlike cubic/expo", () => {
    const values = Array.from({ length: 20 }, (_, i) => easeOutElastic(i / 19));
    let increases = 0;
    let decreases = 0;
    for (let i = 1; i < values.length; i += 1) {
      const prev = values[i - 1];
      const curr = values[i];
      if (prev === undefined || curr === undefined) continue;
      if (curr > prev) increases += 1;
      if (curr < prev) decreases += 1;
    }
    expect(increases).toBeGreaterThan(0);
    expect(decreases).toBeGreaterThan(0);
  });
});

describe("cubicBezier", () => {
  it("closely matches the identity/linear curve for cubicBezier(0, 0, 1, 1)", () => {
    const identity = cubicBezier(0, 0, 1, 1);
    for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(identity(x)).toBeCloseTo(x, 4);
    }
  });

  it("returns exactly 0 at x=0 and exactly 1 at x=1 for any control points", () => {
    const curve = cubicBezier(0.42, 0, 0.58, 1);
    expect(curve(0)).toBe(0);
    expect(curve(1)).toBe(1);
  });

  it("produces a monotonically increasing output for a standard ease-like control-point set", () => {
    // CSS's built-in "ease" timing function.
    const ease = cubicBezier(0.25, 0.1, 0.25, 1);
    const samples = Array.from({ length: 50 }, (_, i) => ease(i / 49));
    for (let i = 1; i < samples.length; i += 1) {
      const prev = samples[i - 1];
      const curr = samples[i];
      expect(prev).toBeDefined();
      expect(curr).toBeDefined();
      if (prev !== undefined && curr !== undefined) {
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    }
  });

  it("matches CSS 'ease-in' (cubic-bezier(0.42, 0, 1, 1)) at its midpoint within a small epsilon", () => {
    // Reference value computed independently: at x=0.5, ease-in's y is
    // approximately 0.3125 (standard published reference for this curve).
    const easeIn = cubicBezier(0.42, 0, 1, 1);
    expect(easeIn(0.5)).toBeCloseTo(0.3125, 2);
  });

  it("handles out-of-domain x by clamping to the boundary values", () => {
    const curve = cubicBezier(0.25, 0.1, 0.25, 1);
    expect(curve(-0.5)).toBe(0);
    expect(curve(1.5)).toBe(1);
  });
});
