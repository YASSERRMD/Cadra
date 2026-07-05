import { describe, expect, it } from "vitest";

import { frameToTime } from "../frame/frame-time.js";
import { videoSampleTimestamp } from "./video-sample-timestamp.js";

describe("videoSampleTimestamp", () => {
  it("is identical to frameToTime for every input, since it is that same math named for its call site", () => {
    const cases: Array<[number, number]> = [
      [0, 30],
      [1, 30],
      [15, 30],
      [30, 30],
      [48, 23.976],
      [90, 24],
    ];

    for (const [frame, fps] of cases) {
      expect(videoSampleTimestamp(frame, fps)).toBe(frameToTime(frame, fps));
    }
  });

  it("is deterministic: the same frame and fps always produce the same timestamp", () => {
    expect(videoSampleTimestamp(42, 30)).toBe(videoSampleTimestamp(42, 30));
  });
});
