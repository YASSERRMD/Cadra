import { describe, expect, it } from "vitest";

import { resolveSceneColor } from "./resolve-scene-color.js";

describe("resolveSceneColor: sRGB to linear conversion", () => {
  it("converts sRGB mid-gray (0.5) to its known darker linear value, at a no-op white balance gain", () => {
    const [r, g, b] = resolveSceneColor([0.5, 0.5, 0.5, 1], [1, 1, 1]);
    // The standard sRGB EOTF maps 0.5 (encoded) to roughly 0.214 (linear).
    expect(r).toBeCloseTo(0.214, 2);
    expect(g).toBeCloseTo(0.214, 2);
    expect(b).toBeCloseTo(0.214, 2);
  });

  it("leaves pure black and pure white unchanged (both fixed points of the sRGB curve)", () => {
    expect(resolveSceneColor([0, 0, 0, 1], [1, 1, 1])).toEqual([0, 0, 0, 1]);
    const [r, g, b, a] = resolveSceneColor([1, 1, 1, 1], [1, 1, 1]);
    expect(r).toBeCloseTo(1, 5);
    expect(g).toBeCloseTo(1, 5);
    expect(b).toBeCloseTo(1, 5);
    expect(a).toBe(1);
  });

  it("passes alpha through completely unchanged", () => {
    const [, , , a] = resolveSceneColor([0.5, 0.5, 0.5, 0.37], [1, 1, 1]);
    expect(a).toBe(0.37);
  });
});

describe("resolveSceneColor: white balance gain", () => {
  it("multiplies the converted linear color by the gain, per channel", () => {
    const noGain = resolveSceneColor([0.5, 0.5, 0.5, 1], [1, 1, 1]);
    const doubled = resolveSceneColor([0.5, 0.5, 0.5, 1], [2, 1, 0.5]);
    expect(doubled[0]).toBeCloseTo((noGain[0] as number) * 2, 10);
    expect(doubled[1]).toBeCloseTo(noGain[1] as number, 10);
    expect(doubled[2]).toBeCloseTo((noGain[2] as number) * 0.5, 10);
  });
});

describe("resolveSceneColor: determinism", () => {
  it("is a pure function of its own inputs", () => {
    const first = resolveSceneColor([0.3, 0.6, 0.9, 0.8], [1.1, 0.9, 1.05]);
    const second = resolveSceneColor([0.3, 0.6, 0.9, 0.8], [1.1, 0.9, 1.05]);
    expect(second).toEqual(first);
  });
});
