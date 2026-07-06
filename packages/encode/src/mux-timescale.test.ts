import { describe, expect, it } from "vitest";

import {
  expectedDurationSeconds,
  expectedMp4DurationTicks,
  expectedWebmDurationTicks,
  WEBM_TIMESTAMP_SCALE_NANOSECONDS,
} from "./mux-timescale.js";

describe("expectedDurationSeconds", () => {
  it("is durationInFrames / fps, matching frameToTime's convention", () => {
    expect(expectedDurationSeconds(30, 30)).toBe(1);
    expect(expectedDurationSeconds(90, 30)).toBe(3);
    expect(expectedDurationSeconds(24, 24)).toBe(1);
    expect(expectedDurationSeconds(0, 30)).toBe(0);
  });

  it("is not necessarily a whole number (e.g. 1 frame at 30fps)", () => {
    expect(expectedDurationSeconds(1, 30)).toBeCloseTo(1 / 30, 10);
  });
});

describe("expectedMp4DurationTicks", () => {
  it("computes an exact integer tick count when durationInFrames/fps*timescale is already whole", () => {
    // A 90-frame, 30fps composition (3s) at a 1000-tick (millisecond) timescale.
    expect(expectedMp4DurationTicks(90, 30, 1000)).toBe(3000);
  });

  it("rounds to the nearest integer tick when the exact value is fractional", () => {
    // 1 frame at 30fps = 1/30s; at a 1000-tick timescale that is
    // 33.333...ticks, which must round to 33, not truncate to 33 by luck or
    // ceiling to 34.
    expect(expectedMp4DurationTicks(1, 30, 1000)).toBe(33);
  });

  it("scales linearly with timescale", () => {
    expect(expectedMp4DurationTicks(30, 30, 1000)).toBe(1000);
    expect(expectedMp4DurationTicks(30, 30, 90000)).toBe(90000);
  });

  it("is 0 for a 0-frame duration regardless of fps/timescale", () => {
    expect(expectedMp4DurationTicks(0, 30, 1000)).toBe(0);
    expect(expectedMp4DurationTicks(0, 24, 90000)).toBe(0);
  });
});

describe("expectedWebmDurationTicks", () => {
  it("defaults to WEBM_TIMESTAMP_SCALE_NANOSECONDS (1,000,000ns, i.e. millisecond ticks)", () => {
    expect(WEBM_TIMESTAMP_SCALE_NANOSECONDS).toBe(1_000_000);
    // A 90-frame, 30fps composition (3s) at 1ms/tick is 3000 ticks, same
    // numeric result as expectedMp4DurationTicks(90, 30, 1000) since a
    // millisecond timescale is the same tick granularity either way.
    expect(expectedWebmDurationTicks(90, 30)).toBe(3000);
  });

  it("rounds to the nearest integer tick when the exact value is fractional", () => {
    expect(expectedWebmDurationTicks(1, 30)).toBe(33);
  });

  it("scales inversely with timestampScaleNanoseconds (coarser scale means fewer ticks)", () => {
    // 1 second at 1,000,000ns/tick (1ms/tick) is 1000 ticks.
    expect(expectedWebmDurationTicks(30, 30, 1_000_000)).toBe(1000);
    // 1 second at 1,000,000,000ns/tick (1s/tick) is 1 tick.
    expect(expectedWebmDurationTicks(30, 30, 1_000_000_000)).toBe(1);
  });

  it("is 0 for a 0-frame duration regardless of fps/timestampScaleNanoseconds", () => {
    expect(expectedWebmDurationTicks(0, 30)).toBe(0);
  });
});
