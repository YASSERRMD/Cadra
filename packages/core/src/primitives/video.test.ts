import { describe, expect, it } from "vitest";

import { createIdentityTransform } from "../scene-graph/primitives.js";
import { resolveVideoSourceFrame, Video } from "./video.js";

describe("Video", () => {
  it("applies every default when only id is given", () => {
    const node = Video({ id: "video-1" });

    expect(node).toEqual({
      id: "video-1",
      kind: "video",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      assetRef: "default",
      opacity: 1,
    });
  });

  it("omits inFrame, outFrame, playbackRate, fitMode, and outOfRangeBehavior when not given", () => {
    const node = Video({ id: "video-1" });

    expect(node).not.toHaveProperty("inFrame");
    expect(node).not.toHaveProperty("outFrame");
    expect(node).not.toHaveProperty("playbackRate");
    expect(node).not.toHaveProperty("fitMode");
    expect(node).not.toHaveProperty("outOfRangeBehavior");
  });

  it("overrides every default when props are given", () => {
    const node = Video({
      id: "video-1",
      name: "Intro Clip",
      visible: false,
      assetRef: "intro.mp4",
      inFrame: 10,
      outFrame: 100,
      playbackRate: 2,
      fitMode: "contain",
      outOfRangeBehavior: "loop",
      opacity: 0.5,
    });

    expect(node).toEqual({
      id: "video-1",
      kind: "video",
      name: "Intro Clip",
      transform: createIdentityTransform(),
      visible: false,
      children: [],
      assetRef: "intro.mp4",
      inFrame: 10,
      outFrame: 100,
      playbackRate: 2,
      fitMode: "contain",
      outOfRangeBehavior: "loop",
      opacity: 0.5,
    });
  });

  it("accepts a keyframe track for opacity", () => {
    const node = Video({
      id: "video-1",
      opacity: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: 30, value: 1 },
        ],
      },
    });

    expect(node.opacity).toEqual({
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: 0 },
        { frame: 30, value: 1 },
      ],
    });
  });
});

describe("resolveVideoSourceFrame", () => {
  describe("no trim, no rate change (identity mapping)", () => {
    it("maps localFrame directly to sourceFrame when inFrame/outFrame are both omitted", () => {
      const cases: Array<[number, number]> = [
        [0, 0],
        [1, 1],
        [42, 42],
      ];
      for (const [localFrame, expected] of cases) {
        expect(resolveVideoSourceFrame({}, localFrame)).toBe(expected);
      }
    });
  });

  describe("trim boundaries: inFrame=10, outFrame=19 (a 10-frame range), playbackRate=1", () => {
    const mapping = { inFrame: 10, outFrame: 19, playbackRate: 1 } as const;

    it("maps localFrame 0 to exactly inFrame", () => {
      expect(resolveVideoSourceFrame(mapping, 0)).toBe(10);
    });

    it("maps localFrame 1 (just after the start boundary) to inFrame + 1", () => {
      expect(resolveVideoSourceFrame(mapping, 1)).toBe(11);
    });

    it("maps localFrame 8 (just before the placement's own last frame) to outFrame - 1", () => {
      expect(resolveVideoSourceFrame(mapping, 8)).toBe(18);
    });

    it("maps localFrame 9 (the placement's own last frame) to exactly outFrame", () => {
      expect(resolveVideoSourceFrame(mapping, 9)).toBe(19);
    });

    it("holds at outFrame one frame past the placement's own last frame (default outOfRangeBehavior)", () => {
      expect(resolveVideoSourceFrame(mapping, 10)).toBe(19);
    });

    it("holds at outFrame for many frames past the placement's own last frame", () => {
      expect(resolveVideoSourceFrame(mapping, 50)).toBe(19);
    });
  });

  describe("outOfRangeBehavior: 'hold' (explicit)", () => {
    const mapping = { inFrame: 10, outFrame: 19, playbackRate: 1, outOfRangeBehavior: "hold" } as const;

    it("is exact at outFrame itself", () => {
      expect(resolveVideoSourceFrame(mapping, 9)).toBe(19);
    });

    it("clamps to outFrame one frame past", () => {
      expect(resolveVideoSourceFrame(mapping, 10)).toBe(19);
    });

    it("clamps to outFrame arbitrarily far past", () => {
      expect(resolveVideoSourceFrame(mapping, 1000)).toBe(19);
    });
  });

  describe("outOfRangeBehavior: 'loop'", () => {
    const mapping = { inFrame: 10, outFrame: 19, playbackRate: 1, outOfRangeBehavior: "loop" } as const;

    it("is exact at outFrame itself (does not wrap early)", () => {
      expect(resolveVideoSourceFrame(mapping, 9)).toBe(19);
    });

    it("wraps to inFrame exactly one frame past the placement's own last frame", () => {
      expect(resolveVideoSourceFrame(mapping, 10)).toBe(10);
    });

    it("continues advancing from inFrame after wrapping", () => {
      expect(resolveVideoSourceFrame(mapping, 11)).toBe(11);
    });

    it("wraps a second time after a full second pass through the range", () => {
      // range length is 10 (10..19 inclusive); localFrame 20 is two full
      // passes past localFrame 0, landing back on inFrame again.
      expect(resolveVideoSourceFrame(mapping, 20)).toBe(10);
    });

    it("wraps partway through a later pass, not just at exact multiples of the range length", () => {
      // localFrame 23 is 3 frames into the third pass (20 + 3).
      expect(resolveVideoSourceFrame(mapping, 23)).toBe(13);
    });
  });

  describe("non-1 playbackRate: rate 2 consumes the trimmed range in half the localFrame span", () => {
    const mapping = { inFrame: 10, outFrame: 19, playbackRate: 2 } as const;

    it("maps localFrame 0 to exactly inFrame regardless of playbackRate", () => {
      expect(resolveVideoSourceFrame(mapping, 0)).toBe(10);
    });

    it("advances the source by 2 frames per localFrame", () => {
      expect(resolveVideoSourceFrame(mapping, 1)).toBe(12);
      expect(resolveVideoSourceFrame(mapping, 2)).toBe(14);
    });

    it("reaches outFrame exactly at localFrame 4 (one frame before the range is consumed)", () => {
      expect(resolveVideoSourceFrame(mapping, 4)).toBe(18);
    });

    it("is out of range starting at localFrame 5 (half the 10-frame range's duration at rate 1)", () => {
      expect(resolveVideoSourceFrame({ ...mapping, outOfRangeBehavior: "hold" }, 5)).toBe(19);
      expect(resolveVideoSourceFrame({ ...mapping, outOfRangeBehavior: "loop" }, 5)).toBe(10);
    });
  });

  describe("fractional playbackRate: rate 0.5 takes twice as long to consume the range", () => {
    const mapping = { inFrame: 10, outFrame: 19, playbackRate: 0.5 } as const;

    it("maps localFrame 0 to exactly inFrame", () => {
      expect(resolveVideoSourceFrame(mapping, 0)).toBe(10);
    });

    it("floors fractional advances rather than rounding", () => {
      expect(resolveVideoSourceFrame(mapping, 1)).toBe(10);
      expect(resolveVideoSourceFrame(mapping, 2)).toBe(11);
      expect(resolveVideoSourceFrame(mapping, 3)).toBe(11);
    });

    it("takes twice as many localFrames to reach outFrame", () => {
      expect(resolveVideoSourceFrame(mapping, 18)).toBe(19);
    });
  });

  describe("inFrame omitted (defaults to 0)", () => {
    it("maps localFrame 0 to exactly 0", () => {
      expect(resolveVideoSourceFrame({ outFrame: 9 }, 0)).toBe(0);
    });

    it("holds at outFrame past the range with inFrame defaulted", () => {
      expect(resolveVideoSourceFrame({ outFrame: 9, outOfRangeBehavior: "hold" }, 15)).toBe(9);
    });

    it("loops back to 0 past the range with inFrame defaulted", () => {
      expect(resolveVideoSourceFrame({ outFrame: 9, outOfRangeBehavior: "loop" }, 10)).toBe(0);
    });
  });

  describe("outFrame omitted (unbounded range, never triggers outOfRangeBehavior)", () => {
    it("keeps advancing indefinitely with no hold or loop applied", () => {
      expect(resolveVideoSourceFrame({ inFrame: 10, outOfRangeBehavior: "hold" }, 0)).toBe(10);
      expect(resolveVideoSourceFrame({ inFrame: 10, outOfRangeBehavior: "hold" }, 10000)).toBe(10010);
      expect(resolveVideoSourceFrame({ inFrame: 10, outOfRangeBehavior: "loop" }, 10000)).toBe(10010);
    });
  });

  describe("determinism", () => {
    it("returns the exact same result for the same inputs every call", () => {
      const mapping = { inFrame: 5, outFrame: 50, playbackRate: 1.5, outOfRangeBehavior: "loop" } as const;
      expect(resolveVideoSourceFrame(mapping, 37)).toBe(resolveVideoSourceFrame(mapping, 37));
    });
  });
});
