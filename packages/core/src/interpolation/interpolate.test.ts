import { describe, expect, it } from "vitest";

import { easeInCubic } from "./easing.js";
import {
  interpolate,
  InterpolateRangeLengthMismatchError,
  NonMonotonicInputRangeError,
} from "./interpolate.js";

describe("interpolate", () => {
  it("linearly interpolates within a single segment", () => {
    expect(interpolate(5, [0, 10], [0, 100])).toBe(50);
    expect(interpolate(2.5, [0, 10], [0, 100])).toBe(25);
  });

  it("clamps below the range when extrapolateLeft is 'clamp'", () => {
    const result = interpolate(-5, [0, 10], [0, 100], { extrapolateLeft: "clamp" });
    expect(result).toBe(0);
  });

  it("clamps above the range when extrapolateRight is 'clamp'", () => {
    const result = interpolate(15, [0, 10], [0, 100], { extrapolateRight: "clamp" });
    expect(result).toBe(100);
  });

  it("clamps on both sides simultaneously with independent options", () => {
    const options = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
    expect(interpolate(-100, [0, 10], [0, 100], options)).toBe(0);
    expect(interpolate(100, [0, 10], [0, 100], options)).toBe(100);
    expect(interpolate(5, [0, 10], [0, 100], options)).toBe(50);
  });

  it("extends (linearly extrapolates) below the range by default, continuing the first segment's slope", () => {
    // Slope of the first (and only) segment is 10 output units per input unit.
    const result = interpolate(-5, [0, 10], [0, 100]);
    expect(result).toBe(-50);
  });

  it("extends above the range by default, continuing the last segment's slope", () => {
    const result = interpolate(15, [0, 10], [0, 100]);
    expect(result).toBe(150);
  });

  it("'extend' extrapolation actually continues the segment's slope, not just clamps", () => {
    // Segment from frame 10..20 maps output 5..25, slope = 2 output/input.
    // At frame 30 (10 past the segment end), extension should be 25 + 10*2 = 45,
    // which is different from both the clamped value (25) and a naive guess.
    const extended = interpolate(30, [10, 20], [5, 25]);
    expect(extended).toBe(45);

    const clamped = interpolate(30, [10, 20], [5, 25], { extrapolateRight: "clamp" });
    expect(clamped).toBe(25);
    expect(extended).not.toBe(clamped);

    // Same check on the left side: segment 10..20 -> 5..25, slope 2.
    // At frame 0 (10 before the segment start): 5 - 10*2 = -15.
    const extendedLeft = interpolate(0, [10, 20], [5, 25]);
    expect(extendedLeft).toBe(-15);
    const clampedLeft = interpolate(0, [10, 20], [5, 25], { extrapolateLeft: "clamp" });
    expect(clampedLeft).toBe(5);
    expect(extendedLeft).not.toBe(clampedLeft);
  });

  it("extends using the nearest segment's slope in a multi-segment range, not the outermost segment", () => {
    // inputRange [0, 10, 20], outputRange [0, 100, 105].
    // Left extension must use the *first* segment's slope (0..10 -> 0..100,
    // slope 10), not the last segment's slope.
    const leftExtended = interpolate(-5, [0, 10, 20], [0, 100, 105]);
    expect(leftExtended).toBe(-50);

    // Right extension must use the *last* segment's slope (10..20 -> 100..105,
    // slope 0.5), not the first segment's slope.
    const rightExtended = interpolate(25, [0, 10, 20], [0, 100, 105]);
    expect(rightExtended).toBe(107.5);
  });

  it("handles a reversed (decreasing) outputRange correctly, e.g. a fade-out", () => {
    expect(interpolate(0, [0, 10], [1, 0])).toBe(1);
    expect(interpolate(10, [0, 10], [1, 0])).toBe(0);
    expect(interpolate(5, [0, 10], [1, 0])).toBe(0.5);
    expect(interpolate(2.5, [0, 10], [1, 0])).toBe(0.75);
  });

  it("handles a non-monotonic outputRange across segments (up then down)", () => {
    const inputRange = [0, 10, 20];
    const outputRange = [0, 100, 0];
    expect(interpolate(0, inputRange, outputRange)).toBe(0);
    expect(interpolate(5, inputRange, outputRange)).toBe(50);
    expect(interpolate(10, inputRange, outputRange)).toBe(100);
    expect(interpolate(15, inputRange, outputRange)).toBe(50);
    expect(interpolate(20, inputRange, outputRange)).toBe(0);
  });

  it("picks the correct segment in a multi-segment (more than two points) inputRange", () => {
    const inputRange = [0, 10, 20, 30];
    const outputRange = [0, 1, 2, 3];

    expect(interpolate(0, inputRange, outputRange)).toBe(0);
    expect(interpolate(5, inputRange, outputRange)).toBe(0.5);
    expect(interpolate(10, inputRange, outputRange)).toBe(1);
    expect(interpolate(15, inputRange, outputRange)).toBe(1.5);
    expect(interpolate(20, inputRange, outputRange)).toBe(2);
    expect(interpolate(25, inputRange, outputRange)).toBe(2.5);
    expect(interpolate(30, inputRange, outputRange)).toBe(3);
  });

  it("picks the correct segment when segments have differing output slopes", () => {
    // 0..10 maps 0..10 (slope 1), 10..20 maps 10..110 (slope 10).
    const inputRange = [0, 10, 20];
    const outputRange = [0, 10, 110];

    expect(interpolate(5, inputRange, outputRange)).toBe(5);
    expect(interpolate(15, inputRange, outputRange)).toBe(60);
  });

  it("applies an easing curve within a segment", () => {
    // easeInCubic(0.5) = 0.125, so at the segment midpoint the output should
    // be 12.5% of the way from 0 to 100, not 50% (which plain lerp would give).
    const eased = interpolate(5, [0, 10], [0, 100], { easing: easeInCubic });
    expect(eased).toBeCloseTo(12.5, 10);
  });

  it("applies easing per-segment in a multi-segment range, re-normalizing local progress each time", () => {
    const inputRange = [0, 10, 20];
    const outputRange = [0, 100, 200];
    const eased = interpolate(15, inputRange, outputRange, { easing: easeInCubic });
    // Local progress within the second segment (10..20) at frame 15 is 0.5;
    // easeInCubic(0.5) = 0.125, so output is 100 + 0.125 * 100 = 112.5.
    expect(eased).toBeCloseTo(112.5, 10);
  });

  it("does not apply easing when extrapolating (straight linear continuation instead)", () => {
    // If easing were (incorrectly) applied outside [0, 1] domain, easeInCubic
    // would still behave monotonically here, so instead assert the extension
    // matches the *plain* linear extrapolation value exactly.
    const withEasing = interpolate(15, [0, 10], [0, 100], { easing: easeInCubic });
    const withoutEasing = interpolate(15, [0, 10], [0, 100]);
    expect(withEasing).toBe(withoutEasing);
    expect(withEasing).toBe(150);
  });

  it("throws NonMonotonicInputRangeError for a non-strictly-increasing inputRange (equal adjacent values)", () => {
    expect(() => interpolate(5, [0, 10, 10, 20], [0, 1, 2, 3])).toThrow(
      NonMonotonicInputRangeError,
    );
  });

  it("throws NonMonotonicInputRangeError for a decreasing inputRange", () => {
    expect(() => interpolate(5, [20, 10, 0], [0, 1, 2])).toThrow(NonMonotonicInputRangeError);
  });

  it("throws NonMonotonicInputRangeError for an inputRange that increases then decreases", () => {
    expect(() => interpolate(5, [0, 10, 5], [0, 1, 2])).toThrow(NonMonotonicInputRangeError);
  });

  it("throws InterpolateRangeLengthMismatchError when inputRange and outputRange lengths differ", () => {
    expect(() => interpolate(5, [0, 10, 20], [0, 100])).toThrow(
      InterpolateRangeLengthMismatchError,
    );
  });

  it("handles exact boundary frames without extrapolating", () => {
    expect(interpolate(0, [0, 10], [0, 100])).toBe(0);
    expect(interpolate(10, [0, 10], [0, 100])).toBe(100);
  });
});
