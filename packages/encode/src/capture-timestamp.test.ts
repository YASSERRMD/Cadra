import { describe, expect, it } from "vitest";

import {
  frameToMicrosecondTimestamp,
  MICROSECONDS_PER_SECOND,
  secondsToMicrosecondTimestamp,
} from "./capture-timestamp.js";

describe("frameToMicrosecondTimestamp", () => {
  it("is 0 at frame 0, regardless of fps", () => {
    expect(frameToMicrosecondTimestamp(0, 24)).toBe(0);
    expect(frameToMicrosecondTimestamp(0, 30)).toBe(0);
    expect(frameToMicrosecondTimestamp(0, 60)).toBe(0);
  });

  it("computes exact whole-microsecond values at 24fps", () => {
    // 1 frame at 24fps = 1/24s = 41666.666...us, rounds to 41667.
    expect(frameToMicrosecondTimestamp(1, 24)).toBe(41_667);
    // 12 frames at 24fps = 0.5s = 500_000us exactly.
    expect(frameToMicrosecondTimestamp(12, 24)).toBe(500_000);
    // 24 frames at 24fps = 1s = 1_000_000us exactly.
    expect(frameToMicrosecondTimestamp(24, 24)).toBe(1_000_000);
    // 23 frames (last frame of a 1s/24fps composition, durationInFrames 24).
    expect(frameToMicrosecondTimestamp(23, 24)).toBe(958_333);
  });

  it("computes exact whole-microsecond values at 30fps", () => {
    // 1 frame at 30fps = 1/30s = 33333.333...us, rounds to 33333.
    expect(frameToMicrosecondTimestamp(1, 30)).toBe(33_333);
    // 15 frames at 30fps = 0.5s = 500_000us exactly.
    expect(frameToMicrosecondTimestamp(15, 30)).toBe(500_000);
    // 30 frames at 30fps = 1s = 1_000_000us exactly.
    expect(frameToMicrosecondTimestamp(30, 30)).toBe(1_000_000);
    // 89 frames (last frame of a 90-frame, 3s/30fps composition).
    expect(frameToMicrosecondTimestamp(89, 30)).toBe(2_966_667);
  });

  it("computes exact whole-microsecond values at 60fps", () => {
    // 1 frame at 60fps = 1/60s = 16666.666...us, rounds to 16667.
    expect(frameToMicrosecondTimestamp(1, 60)).toBe(16_667);
    // 30 frames at 60fps = 0.5s = 500_000us exactly.
    expect(frameToMicrosecondTimestamp(30, 60)).toBe(500_000);
    // 60 frames at 60fps = 1s = 1_000_000us exactly.
    expect(frameToMicrosecondTimestamp(60, 60)).toBe(1_000_000);
    // 179 frames (last frame of a 180-frame, 3s/60fps composition).
    expect(frameToMicrosecondTimestamp(179, 60)).toBe(2_983_333);
  });

  it("is strictly monotonically increasing across consecutive frames at 24fps", () => {
    let previous = -1;
    for (let frame = 0; frame < 48; frame += 1) {
      const timestamp = frameToMicrosecondTimestamp(frame, 24);
      expect(timestamp).toBeGreaterThan(previous);
      previous = timestamp;
    }
  });

  it("is strictly monotonically increasing across consecutive frames at 30fps", () => {
    let previous = -1;
    for (let frame = 0; frame < 90; frame += 1) {
      const timestamp = frameToMicrosecondTimestamp(frame, 30);
      expect(timestamp).toBeGreaterThan(previous);
      previous = timestamp;
    }
  });

  it("is strictly monotonically increasing across consecutive frames at 60fps", () => {
    let previous = -1;
    for (let frame = 0; frame < 180; frame += 1) {
      const timestamp = frameToMicrosecondTimestamp(frame, 60);
      expect(timestamp).toBeGreaterThan(previous);
      previous = timestamp;
    }
  });

  it("always returns an integer (whole microseconds, never fractional)", () => {
    for (const fps of [24, 30, 60, 23.976]) {
      for (let frame = 0; frame < 10; frame += 1) {
        const timestamp = frameToMicrosecondTimestamp(frame, fps);
        expect(Number.isInteger(timestamp)).toBe(true);
      }
    }
  });

  it("is built from secondsToMicrosecondTimestamp applied to frame/fps seconds, the same shared conversion encode-audio.ts's sample-offset timestamps use", () => {
    for (const [frame, fps] of [
      [0, 30],
      [1, 24],
      [89, 30],
      [179, 60],
    ] as const) {
      expect(frameToMicrosecondTimestamp(frame, fps)).toBe(
        secondsToMicrosecondTimestamp(frame / fps),
      );
    }
  });
});

describe("secondsToMicrosecondTimestamp", () => {
  it("is 0 at 0 seconds", () => {
    expect(secondsToMicrosecondTimestamp(0)).toBe(0);
  });

  it("scales exactly by MICROSECONDS_PER_SECOND for whole-second inputs", () => {
    expect(MICROSECONDS_PER_SECOND).toBe(1_000_000);
    expect(secondsToMicrosecondTimestamp(1)).toBe(1_000_000);
    expect(secondsToMicrosecondTimestamp(2.5)).toBe(2_500_000);
    expect(secondsToMicrosecondTimestamp(3)).toBe(3_000_000);
  });

  it("rounds a non-exact real-valued seconds offset to the nearest whole microsecond", () => {
    // 100 sample-frames at 48,000 Hz = 100/48000 s = 2083.3333...us.
    expect(secondsToMicrosecondTimestamp(100 / 48_000)).toBe(2083);
    // 1024 sample-frames at 48,000 Hz = 21333.3333...us.
    expect(secondsToMicrosecondTimestamp(1024 / 48_000)).toBe(21_333);
  });

  it("always returns an integer (whole microseconds, never fractional)", () => {
    for (const seconds of [0, 1 / 3, 0.1, 2.9999, 100 / 48_000]) {
      expect(Number.isInteger(secondsToMicrosecondTimestamp(seconds))).toBe(true);
    }
  });
});
