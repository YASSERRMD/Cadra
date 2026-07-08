import type { PixelBuffer } from "@cadra/renderer";
import { describe, expect, it } from "vitest";

import {
  comparePixelBuffers,
  DEFAULT_DIFF_RATIO_TOLERANCE,
  isWithinTolerance,
  PixelBufferSizeMismatchError,
} from "./perceptual-diff.js";

function solidColorBuffer(width: number, height: number, rgba: [number, number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data.set(rgba, i);
  }
  return { width, height, data };
}

describe("comparePixelBuffers", () => {
  it("reports zero diff for two identical buffers", () => {
    const a = solidColorBuffer(8, 8, [100, 150, 200, 255]);
    const b = solidColorBuffer(8, 8, [100, 150, 200, 255]);

    const result = comparePixelBuffers(a, b);

    expect(result.diffPixelCount).toBe(0);
    expect(result.diffRatio).toBe(0);
    expect(result.totalPixelCount).toBe(64);
    expect(isWithinTolerance(result)).toBe(true);
  });

  it("reports every pixel as different for two entirely different colors", () => {
    const a = solidColorBuffer(4, 4, [0, 0, 0, 255]);
    const b = solidColorBuffer(4, 4, [255, 255, 255, 255]);

    const result = comparePixelBuffers(a, b);

    expect(result.diffPixelCount).toBe(16);
    expect(result.diffRatio).toBe(1);
    expect(isWithinTolerance(result)).toBe(false);
  });

  it("catches a single differing pixel among many identical ones, exceeding a tight tolerance", () => {
    const width = 100;
    const height = 100;
    const a = solidColorBuffer(width, height, [10, 10, 10, 255]);
    const b = solidColorBuffer(width, height, [10, 10, 10, 255]);
    // One pixel out of 10,000 (0.01%) changed to a wildly different color:
    // below DEFAULT_DIFF_RATIO_TOLERANCE (0.1%) by pixel count, so this
    // specifically exercises that the ratio math (not just "any diff at
    // all") is what isWithinTolerance decides on.
    b.data.set([255, 0, 0, 255], 0);

    const result = comparePixelBuffers(a, b);

    expect(result.diffPixelCount).toBe(1);
    expect(result.diffRatio).toBeCloseTo(1 / (width * height));
    expect(isWithinTolerance(result, DEFAULT_DIFF_RATIO_TOLERANCE)).toBe(true);
    expect(isWithinTolerance(result, 0)).toBe(false);
  });

  it("returns a diffImage the same size as the compared buffers", () => {
    const a = solidColorBuffer(5, 3, [1, 2, 3, 255]);
    const b = solidColorBuffer(5, 3, [4, 5, 6, 255]);

    const result = comparePixelBuffers(a, b);

    expect(result.diffImage.width).toBe(5);
    expect(result.diffImage.height).toBe(3);
    expect(result.diffImage.data.length).toBe(5 * 3 * 4);
  });

  it("throws PixelBufferSizeMismatchError for differently-sized buffers", () => {
    const a = solidColorBuffer(4, 4, [0, 0, 0, 255]);
    const b = solidColorBuffer(8, 8, [0, 0, 0, 255]);

    expect(() => comparePixelBuffers(a, b)).toThrow(PixelBufferSizeMismatchError);
  });
});
