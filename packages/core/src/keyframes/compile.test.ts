import { describe, expect, it } from "vitest";

import { easeInOutCubic } from "../interpolation/easing.js";
import { interpolateVector3, lerp } from "../interpolation/lerp.js";
import type { ColorRGBA, Vector3 } from "../scene-graph/primitives.js";
import {
  compileKeyframeTrack,
  resolveColorProperty,
  resolveNumberProperty,
  resolveProperty,
  resolveVector3Property,
} from "./compile.js";
import type { KeyframeTrack, Property } from "./keyframe-track.js";

function lerpValue(a: number, b: number, t: number): number {
  return lerp(a, b, t);
}

function interpolateVector3Value(a: Vector3, b: Vector3, t: number): Vector3 {
  return interpolateVector3(t, a, b);
}

describe("compileKeyframeTrack", () => {
  const track: KeyframeTrack<number> = {
    type: "keyframeTrack",
    keyframes: [
      { frame: 0, value: 0 },
      { frame: 10, value: 100, easing: "easeInOutCubic" },
      { frame: 20, value: 0 },
    ],
  };

  it("holds at the first keyframe's value before the first frame", () => {
    const evaluate = compileKeyframeTrack(track, lerpValue);
    expect(evaluate(-5)).toBe(0);
    expect(evaluate(-1)).toBe(0);
  });

  it("returns the exact value at each keyframe's frame", () => {
    const evaluate = compileKeyframeTrack(track, lerpValue);
    expect(evaluate(0)).toBe(0);
    expect(evaluate(10)).toBe(100);
    expect(evaluate(20)).toBe(0);
  });

  it("holds at the last keyframe's value after the last frame", () => {
    const evaluate = compileKeyframeTrack(track, lerpValue);
    expect(evaluate(25)).toBe(0);
    expect(evaluate(1000)).toBe(0);
  });

  it("interpolates linearly (default easing) within a segment", () => {
    const linearTrack: KeyframeTrack<number> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: 0 },
        { frame: 10, value: 100 },
      ],
    };
    const evaluate = compileKeyframeTrack(linearTrack, lerpValue);
    expect(evaluate(5)).toBe(50);
    expect(evaluate(2.5)).toBe(25);
  });

  it("applies a named non-linear easing curve within a segment, matching the raw curve's math", () => {
    const evaluate = compileKeyframeTrack(track, lerpValue);
    // The keyframe at frame 10 sets easing: 'easeInOutCubic', which governs
    // the segment [10 -> 20] (100 -> 0). Frame 12 lands at local t = 0.2,
    // off the curve's symmetric midpoint, so the eased and plain-linear
    // results are guaranteed to differ. Compare against the curve applied
    // by hand to confirm the compiled evaluator uses the same math.
    const localT = (12 - 10) / (20 - 10);
    const expected = lerp(100, 0, easeInOutCubic(localT));
    expect(evaluate(12)).toBeCloseTo(expected, 10);
    expect(evaluate(12)).not.toBeCloseTo(lerp(100, 0, localT), 5);
  });

  it("throws for a track with zero keyframes", () => {
    const emptyTrack: KeyframeTrack<number> = { type: "keyframeTrack", keyframes: [] };
    expect(() => compileKeyframeTrack(emptyTrack, lerpValue)).toThrow();
  });

  it("behaves as a constant for a single-keyframe track", () => {
    const singleTrack: KeyframeTrack<number> = {
      type: "keyframeTrack",
      keyframes: [{ frame: 5, value: 42 }],
    };
    const evaluate = compileKeyframeTrack(singleTrack, lerpValue);
    expect(evaluate(0)).toBe(42);
    expect(evaluate(5)).toBe(42);
    expect(evaluate(100)).toBe(42);
  });

  it("works with Vector3 values via a supplied interpolateValue", () => {
    const vectorTrack: KeyframeTrack<Vector3> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: [0, 0, 0] },
        { frame: 10, value: [10, 20, 30] },
      ],
    };
    const evaluate = compileKeyframeTrack(vectorTrack, interpolateVector3Value);
    expect(evaluate(5)).toEqual([5, 10, 15]);
  });
});

describe("compileKeyframeTrack: 'hold' easing", () => {
  const holdTrack: KeyframeTrack<number> = {
    type: "keyframeTrack",
    keyframes: [
      { frame: 0, value: 10, easing: "hold" },
      { frame: 10, value: 200 },
      { frame: 20, value: 300 },
    ],
  };

  it("holds exactly at the starting keyframe's value for the entire segment", () => {
    const evaluate = compileKeyframeTrack(holdTrack, lerpValue);
    expect(evaluate(0)).toBe(10);
    expect(evaluate(1)).toBe(10);
    expect(evaluate(5)).toBe(10);
    expect(evaluate(9)).toBe(10);
    expect(evaluate(9.999)).toBe(10);
  });

  it("jumps to the next keyframe's value only once frame reaches its exact frame", () => {
    const evaluate = compileKeyframeTrack(holdTrack, lerpValue);
    expect(evaluate(10)).toBe(200);
  });

  it("does not affect a later segment that does not itself use 'hold'", () => {
    const evaluate = compileKeyframeTrack(holdTrack, lerpValue);
    // Segment [10 -> 20] has no 'hold': ordinary linear interpolation.
    expect(evaluate(15)).toBe(250);
  });
});

describe("resolveProperty: one code path for constant and keyframed properties", () => {
  it("returns a plain constant unchanged, regardless of frame", () => {
    const property: Property<number> = 7;
    expect(resolveProperty(property, 0, lerpValue)).toBe(7);
    expect(resolveProperty(property, 50, lerpValue)).toBe(7);
    expect(resolveProperty(property, -10, lerpValue)).toBe(7);
  });

  it("resolves a KeyframeTrack property through the exact same function signature", () => {
    const property: Property<number> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: 0 },
        { frame: 10, value: 100 },
      ],
    };
    expect(resolveProperty(property, 0, lerpValue)).toBe(0);
    expect(resolveProperty(property, 5, lerpValue)).toBe(50);
    expect(resolveProperty(property, 10, lerpValue)).toBe(100);
  });

  it("produces the same expected value for a constant and an equivalent single-keyframe track, both via resolveProperty", () => {
    const constantProperty: Property<number> = 42;
    const trackProperty: Property<number> = {
      type: "keyframeTrack",
      keyframes: [{ frame: 0, value: 42 }],
    };

    for (const frame of [0, 10, 100]) {
      expect(resolveProperty(constantProperty, frame, lerpValue)).toBe(
        resolveProperty(trackProperty, frame, lerpValue),
      );
    }
  });
});

describe("resolveNumberProperty", () => {
  it("resolves a constant number", () => {
    expect(resolveNumberProperty(5, 3)).toBe(5);
  });

  it("resolves a keyframed number track", () => {
    const property: Property<number> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: 0 },
        { frame: 10, value: 10 },
      ],
    };
    expect(resolveNumberProperty(property, 5)).toBe(5);
  });
});

describe("resolveVector3Property", () => {
  it("resolves a constant Vector3", () => {
    const constant: Vector3 = [1, 2, 3];
    expect(resolveVector3Property(constant, 100)).toEqual([1, 2, 3]);
  });

  it("resolves a keyframed Vector3 track", () => {
    const property: Property<Vector3> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: [0, 0, 0] },
        { frame: 10, value: [10, 20, 30] },
      ],
    };
    expect(resolveVector3Property(property, 5)).toEqual([5, 10, 15]);
  });
});

describe("resolveColorProperty", () => {
  it("resolves a constant ColorRGBA", () => {
    expect(resolveColorProperty([1, 0, 0, 1], 0)).toEqual([1, 0, 0, 1]);
  });

  it("resolves a keyframed ColorRGBA track", () => {
    const property: Property<ColorRGBA> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: [0, 0, 0, 0] },
        { frame: 10, value: [1, 1, 1, 1] },
      ],
    };
    expect(resolveColorProperty(property, 5)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});
