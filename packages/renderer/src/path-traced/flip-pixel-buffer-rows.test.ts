import { describe, expect, it } from "vitest";

import { flipPixelBufferRows } from "./flip-pixel-buffer-rows.js";

/** A 2x2 RGBA8 buffer with a distinct, recognizable color per row: row 0 red, row 1 green. */
function twoByTwoRedGreen(): Uint8Array {
  return new Uint8Array([
    255, 0, 0, 255, 255, 0, 0, 255, // row 0: red, red
    0, 255, 0, 255, 0, 255, 0, 255, // row 1: green, green
  ]);
}

describe("flipPixelBufferRows", () => {
  it("swaps the top and bottom row of a 2-row buffer", () => {
    const flipped = flipPixelBufferRows(twoByTwoRedGreen(), 2, 2);

    expect(Array.from(flipped)).toEqual([
      0, 255, 0, 255, 0, 255, 0, 255, // row 0 is now the original row 1 (green)
      255, 0, 0, 255, 255, 0, 0, 255, // row 1 is now the original row 0 (red)
    ]);
  });

  it("preserves each row's own pixel order (only rows reverse, not columns)", () => {
    const data = new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8, // row 0: pixel A, pixel B
      9, 10, 11, 12, 13, 14, 15, 16, // row 1: pixel C, pixel D
    ]);

    const flipped = flipPixelBufferRows(data, 2, 2);

    expect(Array.from(flipped)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, // row 1 moved to row 0, pixel order (C, D) unchanged
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("is a no-op for a single-row buffer", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(flipPixelBufferRows(data, 2, 1))).toEqual(Array.from(data));
  });

  it("flipping twice restores the original buffer", () => {
    const data = twoByTwoRedGreen();
    const onceFlipped = new Uint8Array(flipPixelBufferRows(data, 2, 2));
    const twiceFlipped = flipPixelBufferRows(onceFlipped, 2, 2);
    expect(Array.from(twiceFlipped)).toEqual(Array.from(data));
  });

  it("is deterministic: repeated calls with the same input produce the same output", () => {
    const data = twoByTwoRedGreen();
    expect(Array.from(flipPixelBufferRows(data, 2, 2))).toEqual(Array.from(flipPixelBufferRows(data, 2, 2)));
  });
});
