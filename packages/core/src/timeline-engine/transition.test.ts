import { describe, expect, it } from "vitest";

import type { Transition } from "../scene-graph/timeline.js";
import { resolveTransitionBlend } from "./transition.js";

describe("resolveTransitionBlend", () => {
  const fade: Transition = { type: "fade", durationInFrames: 10 };

  it("is exactly 0 at the transition's first frame", () => {
    expect(resolveTransitionBlend(fade, 0)).toBe(0);
  });

  it("is exactly 1 at the transition's last frame boundary (framesIntoTransition === durationInFrames)", () => {
    expect(resolveTransitionBlend(fade, 10)).toBe(1);
  });

  it("is exactly 0.5 at the midpoint", () => {
    expect(resolveTransitionBlend(fade, 5)).toBe(0.5);
  });

  it("is a linear ramp at other in-between frames", () => {
    expect(resolveTransitionBlend(fade, 1)).toBeCloseTo(0.1);
    expect(resolveTransitionBlend(fade, 9)).toBeCloseTo(0.9);
  });

  it("clamps to 0 before the transition starts (negative framesIntoTransition)", () => {
    expect(resolveTransitionBlend(fade, -1)).toBe(0);
    expect(resolveTransitionBlend(fade, -100)).toBe(0);
  });

  it("clamps to 1 after the transition ends", () => {
    expect(resolveTransitionBlend(fade, 11)).toBe(1);
    expect(resolveTransitionBlend(fade, 1000)).toBe(1);
  });

  it("scales correctly for a different durationInFrames", () => {
    const longFade: Transition = { type: "crossDissolve", durationInFrames: 100 };
    expect(resolveTransitionBlend(longFade, 0)).toBe(0);
    expect(resolveTransitionBlend(longFade, 25)).toBeCloseTo(0.25);
    expect(resolveTransitionBlend(longFade, 50)).toBe(0.5);
    expect(resolveTransitionBlend(longFade, 100)).toBe(1);
  });

  it("behaves the same regardless of transition type (blend math is type-agnostic)", () => {
    const wipe: Transition = { type: "wipe", durationInFrames: 10, direction: "left" };
    expect(resolveTransitionBlend(wipe, 5)).toBe(resolveTransitionBlend(fade, 5));
  });
});
