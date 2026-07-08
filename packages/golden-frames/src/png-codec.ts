import type { PixelBuffer } from "@cadra/renderer";
import { PNG } from "pngjs";

/**
 * Encodes a `PixelBuffer` (top-left origin, RGBA8, the exact layout every
 * `PixelReadableRenderer.readPixels()` in this codebase already returns) to
 * PNG bytes. `pngjs`'s own `PNG.data` is the identical top-left-origin RGBA8
 * layout, so this is a straight byte copy into a `PNG` instance, no row-flip
 * or channel reorder.
 */
export function encodePixelBufferToPng(pixels: PixelBuffer): Buffer {
  const png = new PNG({ width: pixels.width, height: pixels.height });
  png.data = Buffer.from(pixels.data);
  return PNG.sync.write(png);
}

/**
 * Decodes PNG bytes back to a `PixelBuffer`. The inverse of
 * `encodePixelBufferToPng`; round-tripping a `PixelBuffer` through both is
 * lossless (PNG is itself a lossless format, and this module applies no
 * color-profile or bit-depth conversion of its own).
 */
export function decodePngToPixelBuffer(bytes: Buffer | Uint8Array): PixelBuffer {
  const png = PNG.sync.read(Buffer.from(bytes));
  return {
    width: png.width,
    height: png.height,
    data: Uint8ClampedArray.from(png.data),
  };
}
