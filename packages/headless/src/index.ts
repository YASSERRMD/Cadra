/**
 * @cadra/headless
 *
 * Deterministic headless render and orchestration for Cadra scenes, driving
 * @cadra/renderer outside of a browser tab.
 *
 * `renderComposition` is the deterministic render loop: given a `Project`/
 * `compositionId` and an already-`init`-ed `PixelReadableRenderer`, it walks
 * every integer frame from `0` to `durationInFrames - 1` in order, at a
 * fixed timestep with no wall clock and no unseeded randomness anywhere in
 * the loop, yielding each frame's read-back pixels as an async generator.
 * See its own module doc for the full contract (asset-readiness gating,
 * progress reporting, `AbortSignal` cancellation, and renderer disposal).
 *
 * Converting each `RenderedFrame`'s pixel buffer into a `VideoFrame` (via
 * WebCodecs) and encoding the result to a real video container are later
 * phases' jobs, not this one's: this package's scope ends at "byte-for-byte
 * reproducible pixel buffers, in order."
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics.
 */
export const PACKAGE_NAME = "@cadra/headless";

export type {
  GetPendingAssetsFn,
  OnProgressFn,
  RenderCompositionOptions,
  RenderedFrame,
} from "./render-composition.js";
export { CompositionNotFoundForRenderError, renderComposition } from "./render-composition.js";
