import type { DenoiserLike } from "./denoiser-like.js";
import type { PathTracedFrameResult } from "./render-path-traced-frame.js";

/**
 * Applies `denoiser` to a `renderPathTracedFrame` result, replacing its
 * `target` with the denoised one; `samples` passes through unchanged (a
 * denoise pass reports how many samples actually converged into `target`,
 * regardless of what a later, deterministic post-process did to it).
 * A separate, composable step rather than a `renderPathTracedFrame`
 * parameter: sampling and denoising are independent concerns, and callers
 * that do not want denoising (or run it conditionally on
 * `PathTracingConfig.denoise`) simply do not call this.
 */
export function denoisePathTracedResult(denoiser: DenoiserLike, result: PathTracedFrameResult): PathTracedFrameResult {
  return {
    target: denoiser.denoise(result.target),
    samples: result.samples,
  };
}
