/**
 * Reverses the row order of a raw RGBA8 pixel buffer, converting a
 * bottom-to-top buffer (WebGL's own `gl.readPixels`/`readRenderTargetPixels`
 * convention, verified directly against this project's installed
 * `three@0.185.1` source: a bare `_gl.readPixels` call with no row-flip of
 * its own) into the top-left-origin convention `PixelBuffer` documents.
 * `createRealReadPixels`'s own canvas-based readback (`@cadra/encode`) never
 * needed this: `CanvasRenderingContext2D.drawImage`/`getImageData` already
 * present a WebGL canvas's content top-left-origin regardless of the source
 * canvas's own internal row order.
 */
export function flipPixelBufferRows(data: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const bytesPerRow = width * 4;
  const flipped = new Uint8ClampedArray(data.length);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = row * bytesPerRow;
    const destStart = (height - 1 - row) * bytesPerRow;
    flipped.set(data.subarray(sourceStart, sourceStart + bytesPerRow), destStart);
  }
  return flipped;
}
