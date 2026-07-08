import type { PixelBuffer } from "@cadra/renderer";
import { describe, expect, it } from "vitest";

import { decodePngToPixelBuffer, encodePixelBufferToPng } from "./png-codec.js";

/** A small, non-uniform 3x2 RGBA buffer: every pixel a distinct color, including partial transparency and a fully-transparent pixel, so a codec bug (a dropped/misaligned channel, a swapped row) has somewhere real to show up. */
function buildSamplePixelBuffer(): PixelBuffer {
  const width = 3;
  const height = 2;
  const data = new Uint8ClampedArray(width * height * 4);
  const pixels: Array<[number, number, number, number]> = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 0, 128],
    [0, 255, 255, 64],
    [12, 34, 56, 0],
  ];
  pixels.forEach(([r, g, b, a], index) => {
    data.set([r, g, b, a], index * 4);
  });
  return { width, height, data };
}

describe("encodePixelBufferToPng / decodePngToPixelBuffer", () => {
  it("round-trips a PixelBuffer through PNG bytes with no pixel change", () => {
    const original = buildSamplePixelBuffer();
    const pngBytes = encodePixelBufferToPng(original);
    const decoded = decodePngToPixelBuffer(pngBytes);

    expect(decoded.width).toBe(original.width);
    expect(decoded.height).toBe(original.height);
    expect(Array.from(decoded.data)).toEqual(Array.from(original.data));
  });

  it("produces real PNG bytes starting with the PNG file signature", () => {
    const pngBytes = encodePixelBufferToPng(buildSamplePixelBuffer());
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect(Array.from(pngBytes.subarray(0, 8))).toEqual(signature);
  });

  it("round-trips a fully opaque, uniform buffer (the common golden-frame case)", () => {
    const width = 4;
    const height = 4;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data.set([10, 20, 30, 255], i);
    }
    const original: PixelBuffer = { width, height, data };

    const decoded = decodePngToPixelBuffer(encodePixelBufferToPng(original));
    expect(Array.from(decoded.data)).toEqual(Array.from(original.data));
  });

  it("decodes a Uint8Array input (not just a Buffer)", () => {
    const original = buildSamplePixelBuffer();
    const pngBytes = encodePixelBufferToPng(original);
    const plainUint8Array = new Uint8Array(pngBytes);

    const decoded = decodePngToPixelBuffer(plainUint8Array);
    expect(Array.from(decoded.data)).toEqual(Array.from(original.data));
  });
});
