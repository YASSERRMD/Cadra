import { describe, expect, it } from "vitest";

import {
  clampScrollOffset,
  clampZoom,
  computeClipMove,
  computeTrimLeft,
  computeTrimRight,
  frameToPixel,
  pixelDeltaToFrameDelta,
  pixelToFrame,
  snapFrameToTargets,
} from "./timeline-math.js";

describe("frameToPixel / pixelToFrame", () => {
  it("frameToPixel maps frame 0 with no scroll offset to pixel 0", () => {
    expect(frameToPixel(0, 10, 0)).toBe(0);
  });

  it("frameToPixel scales by pixelsPerFrame", () => {
    expect(frameToPixel(5, 10, 0)).toBe(50);
  });

  it("frameToPixel subtracts the scroll offset before scaling", () => {
    // frame 20, scrolled so frame 10 is at the left edge: (20 - 10) * 10 = 100.
    expect(frameToPixel(20, 10, 10)).toBe(100);
  });

  it("frameToPixel and pixelToFrame are inverses at whole-frame pixel positions", () => {
    const pixelsPerFrame = 8;
    const scrollOffsetFrames = 3;
    for (const frame of [0, 1, 7, 42, 100]) {
      const pixel = frameToPixel(frame, pixelsPerFrame, scrollOffsetFrames);
      expect(pixelToFrame(pixel, pixelsPerFrame, scrollOffsetFrames)).toBe(frame);
    }
  });

  it("pixelToFrame rounds a fractional pixel position to the nearest frame", () => {
    // pixelsPerFrame 10: pixel 24 -> 2.4 frames -> rounds to 2.
    expect(pixelToFrame(24, 10, 0)).toBe(2);
    // pixel 26 -> 2.6 frames -> rounds to 3.
    expect(pixelToFrame(26, 10, 0)).toBe(3);
  });

  it("pixelToFrame applies the scroll offset", () => {
    expect(pixelToFrame(100, 10, 10)).toBe(20);
  });

  it("pixelToFrame returns 0 for a non-positive pixelsPerFrame", () => {
    expect(pixelToFrame(100, 0, 0)).toBe(0);
    expect(pixelToFrame(100, -5, 0)).toBe(0);
  });
});

describe("pixelDeltaToFrameDelta", () => {
  it("converts a positive pixel delta to a positive frame delta", () => {
    expect(pixelDeltaToFrameDelta(50, 10)).toBe(5);
  });

  it("converts a negative pixel delta to a negative frame delta", () => {
    expect(pixelDeltaToFrameDelta(-50, 10)).toBe(-5);
  });

  it("rounds a fractional frame delta to the nearest whole frame", () => {
    expect(pixelDeltaToFrameDelta(24, 10)).toBe(2);
    expect(pixelDeltaToFrameDelta(26, 10)).toBe(3);
  });

  it("returns 0 for a zero pixel delta", () => {
    expect(pixelDeltaToFrameDelta(0, 10)).toBe(0);
  });

  it("returns 0 for a non-positive pixelsPerFrame", () => {
    expect(pixelDeltaToFrameDelta(100, 0)).toBe(0);
    expect(pixelDeltaToFrameDelta(100, -1)).toBe(0);
  });

  it("a higher zoom level (more pixels per frame) yields a smaller frame delta for the same pixel delta", () => {
    const lowZoom = pixelDeltaToFrameDelta(100, 5);
    const highZoom = pixelDeltaToFrameDelta(100, 20);
    expect(highZoom).toBeLessThan(lowZoom);
  });
});

describe("snapFrameToTargets", () => {
  it("returns the frame unchanged when no target is within the threshold", () => {
    expect(snapFrameToTargets(50, [{ frame: 100 }], 5)).toBe(50);
  });

  it("snaps to a target within the threshold", () => {
    expect(snapFrameToTargets(50, [{ frame: 52 }], 5)).toBe(52);
  });

  it("snaps to a target exactly at the threshold distance (inclusive)", () => {
    expect(snapFrameToTargets(50, [{ frame: 55 }], 5)).toBe(55);
  });

  it("does not snap to a target one frame past the threshold", () => {
    expect(snapFrameToTargets(50, [{ frame: 56 }], 5)).toBe(50);
  });

  it("snaps to the closest of several targets within range", () => {
    expect(snapFrameToTargets(50, [{ frame: 46 }, { frame: 53 }], 5)).toBe(53);
  });

  it("breaks a tie between two equidistant targets by picking the first in the list", () => {
    expect(snapFrameToTargets(50, [{ frame: 47 }, { frame: 53 }], 5)).toBe(47);
  });

  it("snaps to the frame itself when a target exactly matches (distance 0)", () => {
    expect(snapFrameToTargets(50, [{ frame: 50 }], 5)).toBe(50);
  });

  it("returns the frame unchanged for an empty target list", () => {
    expect(snapFrameToTargets(50, [], 5)).toBe(50);
  });

  it("a threshold of 0 only snaps to an exact match", () => {
    expect(snapFrameToTargets(50, [{ frame: 51 }], 0)).toBe(50);
    expect(snapFrameToTargets(50, [{ frame: 50 }], 0)).toBe(50);
  });
});

describe("computeClipMove", () => {
  it("moves the clip forward by the pixel-delta-derived frame delta", () => {
    const result = computeClipMove(10, 50, 10, [], 0);
    expect(result.startFrame).toBe(15);
  });

  it("moves the clip backward for a negative pixel delta", () => {
    const result = computeClipMove(10, -30, 10, [], 0);
    expect(result.startFrame).toBe(7);
  });

  it("clamps startFrame to 0, never negative", () => {
    const result = computeClipMove(2, -100, 10, [], 0);
    expect(result.startFrame).toBe(0);
  });

  it("snaps the resulting startFrame to a nearby target", () => {
    // originalStartFrame 10, delta +4 frames -> raw 14; a target at 15 is
    // within the threshold of 2.
    const result = computeClipMove(10, 40, 10, [{ frame: 15 }], 2);
    expect(result.startFrame).toBe(15);
  });

  it("does not snap when no target is within the threshold", () => {
    const result = computeClipMove(10, 40, 10, [{ frame: 100 }], 2);
    expect(result.startFrame).toBe(14);
  });

  it("a zero pixel delta leaves startFrame unchanged", () => {
    const result = computeClipMove(25, 0, 10, [], 0);
    expect(result.startFrame).toBe(25);
  });

  it("clamping to 0 still allows snapping to a target at exactly 0", () => {
    const result = computeClipMove(2, -100, 10, [{ frame: 0 }], 3);
    expect(result.startFrame).toBe(0);
  });
});

describe("computeTrimLeft", () => {
  it("moves the start frame later and shrinks the duration, keeping the end frame fixed", () => {
    // clip spans [10, 40) (startFrame 10, duration 30, end 40).
    const result = computeTrimLeft(10, 30, 50, 10, [], 0); // +5 frames
    expect(result.startFrame).toBe(15);
    expect(result.durationInFrames).toBe(25);
    expect(result.startFrame + result.durationInFrames).toBe(40);
  });

  it("moves the start frame earlier and grows the duration for a negative delta", () => {
    const result = computeTrimLeft(10, 30, -50, 10, [], 0); // -5 frames
    expect(result.startFrame).toBe(5);
    expect(result.durationInFrames).toBe(35);
    expect(result.startFrame + result.durationInFrames).toBe(40);
  });

  it("clamps startFrame to 0, never negative", () => {
    const result = computeTrimLeft(2, 30, -1000, 10, [], 0);
    expect(result.startFrame).toBe(0);
    expect(result.durationInFrames).toBe(32);
  });

  it("clamps so durationInFrames never drops below 1 (cannot trim past the right edge)", () => {
    // clip spans [10, 15); dragging the left edge far to the right.
    const result = computeTrimLeft(10, 5, 1000, 10, [], 0);
    expect(result.durationInFrames).toBeGreaterThanOrEqual(1);
    expect(result.startFrame).toBe(14); // endFrame(15) - 1
  });

  it("snaps the trimmed startFrame to a nearby target, recomputing duration to match", () => {
    // clip spans [10, 40). +4 frames -> raw startFrame 14; snap target at 15.
    const result = computeTrimLeft(10, 30, 40, 10, [{ frame: 15 }], 2);
    expect(result.startFrame).toBe(15);
    expect(result.durationInFrames).toBe(25);
  });

  it("a zero pixel delta leaves both fields unchanged", () => {
    const result = computeTrimLeft(10, 30, 0, 10, [], 0);
    expect(result.startFrame).toBe(10);
    expect(result.durationInFrames).toBe(30);
  });
});

describe("computeTrimRight", () => {
  it("grows the duration for a positive delta, startFrame unchanged", () => {
    // clip spans [10, 40).
    const result = computeTrimRight(10, 30, 50, 10, [], 0); // +5 frames
    expect(result.durationInFrames).toBe(35);
  });

  it("shrinks the duration for a negative delta", () => {
    const result = computeTrimRight(10, 30, -50, 10, [], 0); // -5 frames
    expect(result.durationInFrames).toBe(25);
  });

  it("clamps durationInFrames to never drop below 1", () => {
    const result = computeTrimRight(10, 30, -1000, 10, [], 0);
    expect(result.durationInFrames).toBe(1);
  });

  it("snaps the resulting end frame to a nearby target", () => {
    // clip spans [10, 40); +4 frames -> raw end frame 44; target at 45.
    const result = computeTrimRight(10, 30, 40, 10, [{ frame: 45 }], 2);
    expect(result.durationInFrames).toBe(35); // 45 - 10
  });

  it("does not snap when no target is within the threshold", () => {
    const result = computeTrimRight(10, 30, 40, 10, [{ frame: 1000 }], 2);
    expect(result.durationInFrames).toBe(34);
  });

  it("a zero pixel delta leaves durationInFrames unchanged", () => {
    const result = computeTrimRight(10, 30, 0, 10, [], 0);
    expect(result.durationInFrames).toBe(30);
  });
});

describe("clampZoom", () => {
  it("returns the value unchanged when within bounds", () => {
    expect(clampZoom(10, 1, 100)).toBe(10);
  });

  it("clamps to the minimum", () => {
    expect(clampZoom(0.1, 1, 100)).toBe(1);
  });

  it("clamps to the maximum", () => {
    expect(clampZoom(500, 1, 100)).toBe(100);
  });
});

describe("clampScrollOffset", () => {
  it("clamps a negative offset to 0", () => {
    expect(clampScrollOffset(-10, 1000, 10, 500)).toBe(0);
  });

  it("leaves an in-range offset unchanged", () => {
    // 1000 frames total, 10px/frame -> 10000px total content, 500px visible
    // -> 50 visible frames -> max scroll offset is 950.
    expect(clampScrollOffset(500, 1000, 10, 500)).toBe(500);
  });

  it("clamps an offset past the end so the last frame does not scroll past the visible area", () => {
    expect(clampScrollOffset(2000, 1000, 10, 500)).toBe(950);
  });

  it("clamps to exactly 0 when the whole composition already fits in the visible width", () => {
    // 50 frames at 5px/frame = 250px content, in a 500px visible area.
    expect(clampScrollOffset(30, 50, 5, 500)).toBe(0);
  });

  it("returns 0 for a non-positive pixelsPerFrame", () => {
    expect(clampScrollOffset(10, 1000, 0, 500)).toBe(0);
  });
});
