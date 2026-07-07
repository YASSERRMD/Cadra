import { describe, expect, it } from "vitest";

import { resolveSatoriElementStyles } from "./satori-element-animation.js";

describe("resolveSatoriElementStyles", () => {
  it("returns an empty object when there are no element animations", () => {
    expect(resolveSatoriElementStyles(undefined, 10)).toEqual({});
  });

  it("resolves a plain (non-keyframed) value for every animated aspect", () => {
    const resolved = resolveSatoriElementStyles(
      { title: { opacity: 0.5, x: 10, y: -5, color: [1, 0, 0, 1] } },
      0,
    );
    expect(resolved).toEqual({ title: { opacity: 0.5, x: 10, y: -5, color: [1, 0, 0, 1] } });
  });

  it("only includes the aspects a given element's own keyframes actually set", () => {
    const resolved = resolveSatoriElementStyles({ title: { opacity: 1 } }, 0);
    expect(resolved).toEqual({ title: { opacity: 1 } });
    expect(resolved["title"]).not.toHaveProperty("x");
    expect(resolved["title"]).not.toHaveProperty("y");
    expect(resolved["title"]).not.toHaveProperty("color");
  });

  it("resolves a keyframe track at a specific frame, interpolating between two keyframes", () => {
    const resolved = resolveSatoriElementStyles(
      {
        title: {
          opacity: {
            type: "keyframeTrack",
            keyframes: [
              { frame: 0, value: 0 },
              { frame: 10, value: 1 },
            ],
          },
        },
      },
      5,
    );
    expect(resolved["title"]?.opacity).toBeCloseTo(0.5, 5);
  });

  it("resolves multiple distinct elements independently", () => {
    const resolved = resolveSatoriElementStyles(
      {
        title: { opacity: 1 },
        subtitle: { opacity: 0.5, x: 20 },
      },
      0,
    );
    expect(resolved).toEqual({
      title: { opacity: 1 },
      subtitle: { opacity: 0.5, x: 20 },
    });
  });

  it("holds a keyframe track's staggered start value before its own first keyframe, proving independent per-element timing", () => {
    // Two elements with the same shape of animation but staggered start
    // frames (a common "stagger" pattern, relevant to this phase's own
    // "animated lower-third with staggered inner elements" test): before an
    // element's own first keyframe, it holds at that keyframe's value.
    const resolved = resolveSatoriElementStyles(
      {
        first: {
          opacity: {
            type: "keyframeTrack",
            keyframes: [
              { frame: 0, value: 0 },
              { frame: 5, value: 1 },
            ],
          },
        },
        second: {
          opacity: {
            type: "keyframeTrack",
            keyframes: [
              { frame: 5, value: 0 },
              { frame: 10, value: 1 },
            ],
          },
        },
      },
      2,
    );
    expect(resolved["first"]?.opacity).toBeCloseTo(0.4, 5);
    expect(resolved["second"]?.opacity).toBe(0);
  });
});
