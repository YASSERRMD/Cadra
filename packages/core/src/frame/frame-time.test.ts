import { describe, expect, it } from "vitest";

import { frameToTime, timeToFrame } from "./frame-time.js";

describe("frameToTime", () => {
  it("is exact: frame / fps", () => {
    expect(frameToTime(0, 30)).toBe(0);
    expect(frameToTime(30, 30)).toBe(1);
    expect(frameToTime(15, 30)).toBe(0.5);
    expect(frameToTime(1, 3)).toBeCloseTo(1 / 3, 15);
  });

  it("supports non-integer-looking fps values (e.g. NTSC-style rates)", () => {
    expect(frameToTime(24, 23.976)).toBeCloseTo(24 / 23.976, 10);
  });
});

describe("timeToFrame", () => {
  it("round-trips with frameToTime for times that land exactly on a frame boundary", () => {
    const fps = 30;
    for (let frame = 0; frame < 120; frame += 1) {
      const time = frameToTime(frame, fps);
      expect(timeToFrame(time, fps)).toBe(frame);
    }
  });

  it("rounds to the nearest frame for times that do not land exactly on a boundary", () => {
    const fps = 30;
    // Frame 10 covers [10/30, 11/30). A time close to the start rounds down,
    // a time close to the end rounds up to the next frame.
    expect(timeToFrame(10 / 30 + 0.001, fps)).toBe(10);
    expect(timeToFrame(11 / 30 - 0.001, fps)).toBe(11);
  });

  it("resolves an exact halfway point by rounding up, per the documented convention", () => {
    const fps = 30;
    const halfway = (10 / 30 + 11 / 30) / 2;
    expect(timeToFrame(halfway, fps)).toBe(11);
  });

  it("rounds a time of exactly zero to frame zero", () => {
    expect(timeToFrame(0, 30)).toBe(0);
  });

  it("is consistent for a non-integer fps", () => {
    const fps = 23.976;
    const time = frameToTime(48, fps);
    expect(timeToFrame(time, fps)).toBe(48);
  });
});
