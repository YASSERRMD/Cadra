import { describe, expect, it } from "vitest";

import type { KeyframeTrack } from "./keyframe-track.js";
import { validateKeyframeTrack } from "./validate.js";

describe("validateKeyframeTrack", () => {
  it("returns no diagnostics for a valid ascending-integer-frame track", () => {
    const track: KeyframeTrack<number> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: 0 },
        { frame: 10, value: 1 },
        { frame: 25, value: 2 },
      ],
    };
    expect(validateKeyframeTrack(track)).toEqual([]);
  });

  it("returns no diagnostics for an empty track", () => {
    const track: KeyframeTrack<number> = { type: "keyframeTrack", keyframes: [] };
    expect(validateKeyframeTrack(track)).toEqual([]);
  });

  it("returns no diagnostics for a single-keyframe track", () => {
    const track: KeyframeTrack<number> = {
      type: "keyframeTrack",
      keyframes: [{ frame: 0, value: 0 }],
    };
    expect(validateKeyframeTrack(track)).toEqual([]);
  });

  it("reports out-of-order frames", () => {
    const track: KeyframeTrack<number> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 10, value: 0 },
        { frame: 5, value: 1 },
      ],
    };
    const diagnostics = validateKeyframeTrack(track);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.index).toBe(1);
    expect(diagnostics[0]?.frame).toBe(5);
  });

  it("reports duplicate frames", () => {
    const track: KeyframeTrack<number> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 5, value: 0 },
        { frame: 5, value: 1 },
      ],
    };
    const diagnostics = validateKeyframeTrack(track);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.index).toBe(1);
    expect(diagnostics[0]?.frame).toBe(5);
  });

  it("reports negative frames", () => {
    const track: KeyframeTrack<number> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: -5, value: 0 },
        { frame: 10, value: 1 },
      ],
    };
    const diagnostics = validateKeyframeTrack(track);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.index).toBe(0);
    expect(diagnostics[0]?.frame).toBe(-5);
  });

  it("reports non-integer frames", () => {
    const track: KeyframeTrack<number> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: 0 },
        { frame: 5.5, value: 1 },
      ],
    };
    const diagnostics = validateKeyframeTrack(track);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.index).toBe(1);
    expect(diagnostics[0]?.frame).toBe(5.5);
  });

  it("reports multiple independent problems in one pass", () => {
    const track: KeyframeTrack<number> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: -1, value: 0 },
        { frame: 2.5, value: 1 },
        { frame: 2.5, value: 2 },
      ],
    };
    const diagnostics = validateKeyframeTrack(track);
    // index 0: negative frame.
    // index 1: non-integer frame (2.5), but still strictly greater than -1
    //   so no ordering diagnostic.
    // index 2: non-integer frame (2.5) AND a duplicate-frame diagnostic
    //   against index 1's frame.
    expect(diagnostics.map((d) => d.index)).toEqual([0, 1, 2, 2]);
  });

  it("does not throw for any invalid input, only returns diagnostics", () => {
    const track: KeyframeTrack<number> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 10, value: 0 },
        { frame: -5, value: 1 },
        { frame: 10, value: 2 },
        { frame: 3.3, value: 3 },
      ],
    };
    expect(() => validateKeyframeTrack(track)).not.toThrow();
    expect(validateKeyframeTrack(track).length).toBeGreaterThan(0);
  });
});
