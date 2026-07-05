import { describe, expect, it } from "vitest";

import type { KeyframeTrack, Property } from "./keyframe-track.js";
import { isKeyframeTrack } from "./keyframe-track.js";

describe("isKeyframeTrack", () => {
  it("returns false for a plain constant number", () => {
    const property: Property<number> = 42;
    expect(isKeyframeTrack(property)).toBe(false);
  });

  it("returns false for a plain constant string", () => {
    const property: Property<string> = "hello";
    expect(isKeyframeTrack(property)).toBe(false);
  });

  it("returns true for a KeyframeTrack", () => {
    const track: KeyframeTrack<number> = {
      type: "keyframeTrack",
      keyframes: [{ frame: 0, value: 0 }],
    };
    const property: Property<number> = track;
    expect(isKeyframeTrack(property)).toBe(true);
  });

  it("uses the discriminant, not shape-sniffing: a plain object with a 'keyframes' field but no 'type' tag is not a track", () => {
    // `T` here is deliberately an object shape that coincidentally has a
    // `keyframes` field, proving the guard checks the `type` discriminant
    // rather than "has a keyframes array".
    interface LookalikeValue {
      keyframes: number[];
    }
    const lookalike: LookalikeValue = { keyframes: [1, 2, 3] };
    const property: Property<LookalikeValue> = lookalike;
    expect(isKeyframeTrack(property)).toBe(false);
  });

  it("returns false for a constant object value whose 'type' field happens to be a different string", () => {
    interface TaggedValue {
      type: string;
      amount: number;
    }
    const value: TaggedValue = { type: "not-a-track", amount: 5 };
    const property: Property<TaggedValue> = value;
    expect(isKeyframeTrack(property)).toBe(false);
  });

  it("returns false for null", () => {
    const property: Property<null> = null;
    expect(isKeyframeTrack(property)).toBe(false);
  });
});
