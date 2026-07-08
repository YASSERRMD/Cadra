import { describe, expect, it } from "vitest";

import { computeMotionBlurVelocityScale } from "./motion-blur.js";

describe("computeMotionBlurVelocityScale", () => {
  it("is 0 at shutter angle 0 (no blur)", () => {
    expect(computeMotionBlurVelocityScale(0)).toBe(0);
  });

  it("scales up monotonically as shutter angle increases", () => {
    const at90 = computeMotionBlurVelocityScale(90);
    const at180 = computeMotionBlurVelocityScale(180);
    const at360 = computeMotionBlurVelocityScale(360);
    expect(at90).toBeLessThan(at180);
    expect(at180).toBeLessThan(at360);
  });

  it("a 360-degree shutter scales velocity by exactly 0.5 (full NDC-to-UV conversion, no interval reduction)", () => {
    expect(computeMotionBlurVelocityScale(360)).toBe(0.5);
  });

  it("the standard 180-degree cinematic default scales velocity by 0.25", () => {
    expect(computeMotionBlurVelocityScale(180)).toBe(0.25);
  });

  it("is deterministic: repeated calls with the same angle produce the exact same scale", () => {
    expect(computeMotionBlurVelocityScale(270)).toBe(computeMotionBlurVelocityScale(270));
  });
});
