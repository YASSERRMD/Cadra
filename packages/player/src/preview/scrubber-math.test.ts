import { describe, expect, it } from "vitest";

import { pointerPositionToFrame } from "./scrubber-math.js";

const TRACK_LEFT = 100;
const TRACK_WIDTH = 200;
const DURATION_IN_FRAMES = 90; // last frame index 89

describe("pointerPositionToFrame", () => {
  it("maps the track's exact left edge to frame 0", () => {
    const frame = pointerPositionToFrame(
      { trackLeft: TRACK_LEFT, trackWidth: TRACK_WIDTH, pointerX: TRACK_LEFT },
      DURATION_IN_FRAMES,
    );
    expect(frame).toBe(0);
  });

  it("maps the track's exact right edge to the last frame", () => {
    const frame = pointerPositionToFrame(
      {
        trackLeft: TRACK_LEFT,
        trackWidth: TRACK_WIDTH,
        pointerX: TRACK_LEFT + TRACK_WIDTH,
      },
      DURATION_IN_FRAMES,
    );
    expect(frame).toBe(DURATION_IN_FRAMES - 1);
  });

  it("maps the track's exact midpoint to the midpoint frame, rounded", () => {
    const frame = pointerPositionToFrame(
      {
        trackLeft: TRACK_LEFT,
        trackWidth: TRACK_WIDTH,
        pointerX: TRACK_LEFT + TRACK_WIDTH / 2,
      },
      DURATION_IN_FRAMES,
    );
    // (durationInFrames - 1) / 2 = 44.5, rounds to 45 (round-half-up).
    expect(frame).toBe(45);
  });

  it("rounds to the nearest frame for a fractional position, not just floors", () => {
    // 40% of the way across a 90-frame (0..89) track: 0.4 * 89 = 35.6 -> 36.
    const frame = pointerPositionToFrame(
      {
        trackLeft: TRACK_LEFT,
        trackWidth: TRACK_WIDTH,
        pointerX: TRACK_LEFT + TRACK_WIDTH * 0.4,
      },
      DURATION_IN_FRAMES,
    );
    expect(frame).toBe(36);
  });

  it("clamps to frame 0 for a pointer position left of the track", () => {
    const frame = pointerPositionToFrame(
      {
        trackLeft: TRACK_LEFT,
        trackWidth: TRACK_WIDTH,
        pointerX: TRACK_LEFT - 50,
      },
      DURATION_IN_FRAMES,
    );
    expect(frame).toBe(0);
  });

  it("clamps to the last frame for a pointer position right of the track", () => {
    const frame = pointerPositionToFrame(
      {
        trackLeft: TRACK_LEFT,
        trackWidth: TRACK_WIDTH,
        pointerX: TRACK_LEFT + TRACK_WIDTH + 50,
      },
      DURATION_IN_FRAMES,
    );
    expect(frame).toBe(DURATION_IN_FRAMES - 1);
  });

  it("clamps a position only slightly outside the track's left bound", () => {
    const frame = pointerPositionToFrame(
      {
        trackLeft: TRACK_LEFT,
        trackWidth: TRACK_WIDTH,
        pointerX: TRACK_LEFT - 1,
      },
      DURATION_IN_FRAMES,
    );
    expect(frame).toBe(0);
  });

  it("clamps a position only slightly outside the track's right bound", () => {
    const frame = pointerPositionToFrame(
      {
        trackLeft: TRACK_LEFT,
        trackWidth: TRACK_WIDTH,
        pointerX: TRACK_LEFT + TRACK_WIDTH + 1,
      },
      DURATION_IN_FRAMES,
    );
    expect(frame).toBe(DURATION_IN_FRAMES - 1);
  });

  it("returns 0 for a durationInFrames of 1 (a single-frame composition)", () => {
    const frame = pointerPositionToFrame(
      {
        trackLeft: TRACK_LEFT,
        trackWidth: TRACK_WIDTH,
        pointerX: TRACK_LEFT + TRACK_WIDTH,
      },
      1,
    );
    expect(frame).toBe(0);
  });

  it("returns 0 for a degenerate zero-width track rather than dividing by zero", () => {
    const frame = pointerPositionToFrame(
      { trackLeft: TRACK_LEFT, trackWidth: 0, pointerX: TRACK_LEFT },
      DURATION_IN_FRAMES,
    );
    expect(frame).toBe(0);
  });
});
