import { describe, expect, it } from "vitest";
import { z } from "zod";

import { easingSchema, keyframeSchema, keyframeTrackSchema, propertySchema } from "./keyframes.js";

describe("easingSchema", () => {
  it("accepts every named easing curve plus 'hold'", () => {
    const names = [
      "linear",
      "easeInCubic",
      "easeOutCubic",
      "easeInOutCubic",
      "easeInExpo",
      "easeOutExpo",
      "easeInOutExpo",
      "easeInBack",
      "easeOutBack",
      "easeInOutBack",
      "easeInElastic",
      "easeOutElastic",
      "easeInOutElastic",
      "easeInBounce",
      "easeOutBounce",
      "easeInOutBounce",
      "hold",
    ];
    for (const name of names) {
      expect(easingSchema.safeParse(name).success).toBe(true);
    }
  });

  it("rejects an unrecognized easing name", () => {
    expect(easingSchema.safeParse("easeInQuad").success).toBe(false);
  });
});

describe("keyframeSchema", () => {
  const numberKeyframe = keyframeSchema(z.number());

  it("accepts a keyframe without an easing", () => {
    const result = numberKeyframe.safeParse({ frame: 0, value: 10 });
    expect(result.success).toBe(true);
  });

  it("accepts a keyframe with a named easing", () => {
    const result = numberKeyframe.safeParse({ frame: 0, value: 10, easing: "easeInOutCubic" });
    expect(result.success).toBe(true);
  });

  it("accepts a keyframe with 'hold' easing", () => {
    const result = numberKeyframe.safeParse({ frame: 0, value: 10, easing: "hold" });
    expect(result.success).toBe(true);
  });

  it("rejects a keyframe missing 'value'", () => {
    const result = numberKeyframe.safeParse({ frame: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a keyframe with an unrecognized field (strict object)", () => {
    const result = numberKeyframe.safeParse({ frame: 0, value: 10, extra: "nope" });
    expect(result.success).toBe(false);
  });
});

describe("keyframeTrackSchema", () => {
  const numberTrack = keyframeTrackSchema(z.number());

  it("accepts a valid ascending-integer-frame track", () => {
    const result = numberTrack.safeParse({
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: 0 },
        { frame: 10, value: 1 },
        { frame: 25, value: 2, easing: "easeOutCubic" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a value missing the 'type' discriminant", () => {
    const result = numberTrack.safeParse({
      keyframes: [{ frame: 0, value: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects out-of-order frames with a path-precise diagnostic", () => {
    const result = numberTrack.safeParse({
      type: "keyframeTrack",
      keyframes: [
        { frame: 10, value: 0 },
        { frame: 5, value: 1 },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.join(".") === "keyframes.1.frame");
    expect(issue).toBeDefined();
  });

  it("rejects duplicate frames with a path-precise diagnostic", () => {
    const result = numberTrack.safeParse({
      type: "keyframeTrack",
      keyframes: [
        { frame: 5, value: 0 },
        { frame: 5, value: 1 },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.join(".") === "keyframes.1.frame");
    expect(issue).toBeDefined();
  });

  it("rejects negative frames with a path-precise diagnostic", () => {
    const result = numberTrack.safeParse({
      type: "keyframeTrack",
      keyframes: [
        { frame: -1, value: 0 },
        { frame: 5, value: 1 },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.join(".") === "keyframes.0.frame");
    expect(issue).toBeDefined();
  });

  it("rejects non-integer frames with a path-precise diagnostic", () => {
    const result = numberTrack.safeParse({
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: 0 },
        { frame: 5.5, value: 1 },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.join(".") === "keyframes.1.frame");
    expect(issue).toBeDefined();
  });

  it("works with a non-numeric value schema (Vector3-like tuple)", () => {
    const vectorTrack = keyframeTrackSchema(z.tuple([z.number(), z.number(), z.number()]));
    const result = vectorTrack.safeParse({
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: [0, 0, 0] },
        { frame: 10, value: [1, 2, 3] },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("propertySchema", () => {
  const numberProperty = propertySchema(z.number());

  it("accepts a bare constant number", () => {
    const result = numberProperty.safeParse(42);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(42);
    }
  });

  it("accepts a valid keyframe track JSON shape", () => {
    const result = numberProperty.safeParse({
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: 0 },
        { frame: 10, value: 100 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid keyframe track (out-of-order frames) with a path-precise diagnostic", () => {
    const result = numberProperty.safeParse({
      type: "keyframeTrack",
      keyframes: [
        { frame: 10, value: 0 },
        { frame: 0, value: 1 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a value that is neither a valid number nor a valid keyframe track", () => {
    const result = numberProperty.safeParse({ not: "a valid property" });
    expect(result.success).toBe(false);
  });

  it("rejects a bare string when the value schema is number", () => {
    const result = numberProperty.safeParse("not a number");
    expect(result.success).toBe(false);
  });
});
