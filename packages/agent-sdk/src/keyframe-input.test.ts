import type { KeyframeTrack } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { toKeyframeTrack } from "./keyframe-input.js";

describe("toKeyframeTrack", () => {
  it("wraps a bare keyframe array in the keyframeTrack discriminant", () => {
    const result = toKeyframeTrack([
      { frame: 0, value: 0 },
      { frame: 10, value: 100 },
    ]);
    expect(result).toEqual({
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: 0 },
        { frame: 10, value: 100 },
      ],
    });
  });

  it("passes an already-built KeyframeTrack through unchanged", () => {
    const track: KeyframeTrack<number> = {
      type: "keyframeTrack",
      keyframes: [{ frame: 0, value: 42 }],
    };
    expect(toKeyframeTrack(track)).toBe(track);
  });

  it("preserves per-keyframe easing on the bare-array form", () => {
    const result = toKeyframeTrack([
      { frame: 0, value: true, easing: "hold" },
      { frame: 10, value: false },
    ]);
    expect(result).toEqual({
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: true, easing: "hold" },
        { frame: 10, value: false },
      ],
    });
  });

  it("copies the input array rather than aliasing it", () => {
    const input = [{ frame: 0, value: 1 }];
    const result = toKeyframeTrack(input);
    input.push({ frame: 10, value: 2 });
    expect(result.keyframes).toHaveLength(1);
  });
});
