import { describe, expect, it } from "vitest";

import { downsamplePremultipliedRgba, unpremultiplyRgba } from "./rgba-pixel-math.js";

/** Builds a solid-color, premultiplied-alpha RGBA8 buffer for a width x height image. */
function solidPremultiplied(
  width: number,
  height: number,
  premultipliedR: number,
  premultipliedG: number,
  premultipliedB: number,
  alpha: number,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = premultipliedR;
    pixels[i + 1] = premultipliedG;
    pixels[i + 2] = premultipliedB;
    pixels[i + 3] = alpha;
  }
  return pixels;
}

describe("downsamplePremultipliedRgba", () => {
  it("returns an equivalent copy (not the same reference) when source and target sizes already match", () => {
    const source = solidPremultiplied(4, 4, 10, 20, 30, 255);
    const result = downsamplePremultipliedRgba(source, 4, 4, 4, 4);
    expect(result).toEqual(source);
    expect(result).not.toBe(source);
  });

  it("averages a uniform 2x2 block per output pixel for a clean 2x supersample factor", () => {
    const source = solidPremultiplied(4, 4, 100, 150, 200, 255);
    const result = downsamplePremultipliedRgba(source, 4, 4, 2, 2);
    expect(result).toHaveLength(2 * 2 * 4);
    for (let i = 0; i < result.length; i += 4) {
      expect(result[i]).toBe(100);
      expect(result[i + 1]).toBe(150);
      expect(result[i + 2]).toBe(200);
      expect(result[i + 3]).toBe(255);
    }
  });

  it("blends a sharp half-and-half edge into a mid-value average, proving it is a real box filter", () => {
    // A 2x1 source: left pixel opaque white, right pixel transparent black
    // (premultiplied (0,0,0,0)), downsampled to 1x1 should average to a
    // half-covered pixel: (128-ish, 128-ish, 128-ish, 128-ish).
    const source = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]);
    const result = downsamplePremultipliedRgba(source, 2, 1, 1, 1);
    expect(result[0]).toBeCloseTo(128, -1);
    expect(result[3]).toBeCloseTo(128, -1);
  });
});

describe("unpremultiplyRgba", () => {
  it("recovers the true opaque color from a 50%-alpha premultiplied pixel", () => {
    // Matches this codebase's own empirical finding against real resvg
    // output: a 50%-alpha pure red fill renders as premultiplied (127,0,0,127).
    const premultiplied = new Uint8Array([127, 0, 0, 127]);
    const straight = unpremultiplyRgba(premultiplied);
    expect(straight[0]).toBeGreaterThanOrEqual(253);
    expect(straight[1]).toBe(0);
    expect(straight[2]).toBe(0);
    expect(straight[3]).toBe(127);
  });

  it("leaves a fully opaque pixel unchanged", () => {
    const premultiplied = new Uint8Array([10, 20, 30, 255]);
    expect(unpremultiplyRgba(premultiplied)).toEqual(premultiplied);
  });

  it("produces fully transparent black for a fully transparent pixel, avoiding a division by zero", () => {
    const premultiplied = new Uint8Array([0, 0, 0, 0]);
    expect(unpremultiplyRgba(premultiplied)).toEqual(new Uint8Array([0, 0, 0, 0]));
  });
});
