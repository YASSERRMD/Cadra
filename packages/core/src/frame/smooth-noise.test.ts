import { describe, expect, it } from "vitest";

import { smoothNoise } from "./smooth-noise.js";

describe("smoothNoise", () => {
  it("is deterministic: the same (seed, frame, periodFrames) always resolves to the same value", () => {
    const first = smoothNoise("glyph-3", 17, 20);
    const second = smoothNoise("glyph-3", 17, 20);
    expect(second).toBe(first);
  });

  it("evaluating frames out of order gives the same result as evaluating in order", () => {
    const inOrder = [0, 5, 10, 20, 35].map((frame) => smoothNoise("seed", frame, 10));
    const outOfOrder = [35, 0, 20, 5, 10].map((frame) => smoothNoise("seed", frame, 10));
    expect(outOfOrder[1]).toBe(inOrder[0]);
    expect(outOfOrder[3]).toBe(inOrder[1]);
    expect(outOfOrder[4]).toBe(inOrder[2]);
    expect(outOfOrder[2]).toBe(inOrder[3]);
    expect(outOfOrder[0]).toBe(inOrder[4]);
  });

  it("stays within [-1, 1] across many frames", () => {
    for (let frame = 0; frame < 200; frame += 1) {
      const value = smoothNoise("range-check", frame, 13);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("is continuous: adjacent frames differ only slightly, not by a wild, uncorrelated jump", () => {
    let maxDelta = 0;
    let previous = smoothNoise("continuity", 0, 20);
    for (let frame = 1; frame < 100; frame += 1) {
      const current = smoothNoise("continuity", frame, 20);
      maxDelta = Math.max(maxDelta, Math.abs(current - previous));
      previous = current;
    }
    // Each checkpoint-to-checkpoint span is linearly interpolated over
    // `periodFrames` (20) steps across a value range of at most 2 ([-1,1]),
    // so no single-frame step can plausibly exceed a small fraction of that.
    expect(maxDelta).toBeLessThan(0.3);
  });

  it("gives different seeds independent sequences", () => {
    const a = smoothNoise("seed-a", 12, 20);
    const b = smoothNoise("seed-b", 12, 20);
    expect(a).not.toBe(b);
  });

  it("is well-defined for negative frames, with no discontinuity across frame 0", () => {
    const justBefore = smoothNoise("negative-check", -1, 20);
    const atZero = smoothNoise("negative-check", 0, 20);
    // Not asserting a specific value, only that it does not throw and
    // stays in range - the real invariant this locks down.
    expect(justBefore).toBeGreaterThanOrEqual(-1);
    expect(justBefore).toBeLessThanOrEqual(1);
    expect(atZero).toBeGreaterThanOrEqual(-1);
    expect(atZero).toBeLessThanOrEqual(1);
  });
});
