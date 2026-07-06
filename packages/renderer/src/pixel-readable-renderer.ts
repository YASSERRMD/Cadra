import type { Renderer } from "./renderer.js";

/**
 * One frame's read-back pixel buffer, top-left origin, RGBA8 per pixel:
 * `data.length` is always `width * height * 4`.
 */
export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * A `Renderer` that can additionally read back the pixels of whatever it
 * most recently drew. Deliberately a separate, additive interface rather
 * than a new method on `Renderer` itself: `Renderer` is depended on by
 * already-tested live-preview code (`@cadra/player`'s `Transport`/
 * `mountPreview`), and neither of those need pixel readback, so widening
 * their one shared contract would ripple a capability they never use into
 * every implementation and fake of `Renderer` that already exists.
 *
 * Headless rendering (`@cadra/headless`) is the one consumer that needs
 * both a `Renderer`'s ordinary drawing and this readback capability, so it
 * depends on `PixelReadableRenderer` specifically instead.
 */
export interface PixelReadableRenderer extends Renderer {
  /**
   * Reads back the pixels of whatever the most recent `renderFrame` call
   * drew. Must be called only after at least one `renderFrame` call has
   * completed; behavior before that (or before `init`) is implementation-
   * defined, matching `Renderer`'s own "not safe to use before init"
   * convention for its other methods.
   */
  readPixels(): Promise<PixelBuffer>;
}
