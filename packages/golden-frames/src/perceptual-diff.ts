import type { PixelBuffer } from "@cadra/renderer";
import pixelmatch from "pixelmatch";

/**
 * `pixelmatch`'s own per-pixel color-difference sensitivity (its
 * `threshold` option, 0 to 1, smaller is more sensitive). Left at
 * `pixelmatch`'s documented default (`0.1`): this harness's "tight
 * tolerance" (see `DEFAULT_DIFF_RATIO_TOLERANCE`) is expressed as how many
 * pixels are allowed to differ at all, not as a looser per-pixel color
 * match, so there is no reason to also loosen the per-pixel check itself.
 */
export const DEFAULT_PIXELMATCH_THRESHOLD = 0.1;

/**
 * The fraction of a golden frame's pixels allowed to mismatch before
 * `compareAgainstReference` reports a failing diff: `0.001` (0.1%).
 *
 * Not `0`: this codebase's own real end-to-end determinism tests (e.g.
 * `render-frame-native-gpu.e2e.test.ts`'s same-session re-evaluation
 * check) establish that a single renderer instance reproduces byte-identical
 * pixels for plain raster content, but a golden-frame reference is checked
 * in once and compared against on whatever machine/GPU/driver CI (or a
 * contributor) happens to run on next, and real GPU rendering is not
 * generally bit-exact across different hardware/drivers - only a tight
 * tolerance, not exact byte equality, is a realistic cross-machine
 * contract. `0.001` still catches any real, visible regression (a wrong
 * color, a missing effect, a moved object changes far more than 0.1% of a
 * scene's pixels) while tolerating the handful of anti-aliased edge pixels
 * that can legitimately differ by a shade across GPUs.
 */
export const DEFAULT_DIFF_RATIO_TOLERANCE = 0.001;

/** Thrown by `comparePixelBuffers` when the two buffers are not the same size (a meaningless comparison, not a diff of any kind). */
export class PixelBufferSizeMismatchError extends Error {
  constructor(a: { width: number; height: number }, b: { width: number; height: number }) {
    super(
      `comparePixelBuffers: size mismatch (${a.width}x${a.height} vs ${b.width}x${b.height}). ` +
        "Both buffers must be the same size to compare.",
    );
    this.name = "PixelBufferSizeMismatchError";
  }
}

/** The result of comparing two same-sized `PixelBuffer`s. */
export interface PerceptualDiffResult {
  /** How many pixels `pixelmatch` judged as mismatched. */
  diffPixelCount: number;
  /** `width * height` of the compared buffers. */
  totalPixelCount: number;
  /** `diffPixelCount / totalPixelCount`. */
  diffRatio: number;
  /** A same-sized visualization: mismatched pixels highlighted, matching pixels dimmed, per `pixelmatch`'s own `diffColor`/`alpha` defaults. */
  diffImage: PixelBuffer;
}

/**
 * Compares two same-sized `PixelBuffer`s pixel by pixel via `pixelmatch`,
 * returning both the raw mismatch count/ratio and a visual diff image
 * (mismatched pixels highlighted in red) suitable for writing to disk for a
 * reviewer to inspect.
 *
 * @throws {PixelBufferSizeMismatchError} if `a`/`b` are not the same size.
 */
export function comparePixelBuffers(
  a: PixelBuffer,
  b: PixelBuffer,
  threshold: number = DEFAULT_PIXELMATCH_THRESHOLD,
): PerceptualDiffResult {
  if (a.width !== b.width || a.height !== b.height) {
    throw new PixelBufferSizeMismatchError(a, b);
  }

  const { width, height } = a;
  const diffData = new Uint8ClampedArray(width * height * 4);
  const diffPixelCount = pixelmatch(a.data, b.data, diffData, width, height, { threshold });
  const totalPixelCount = width * height;

  return {
    diffPixelCount,
    totalPixelCount,
    diffRatio: totalPixelCount === 0 ? 0 : diffPixelCount / totalPixelCount,
    diffImage: { width, height, data: diffData },
  };
}

/** Whether `result`'s `diffRatio` is within `tolerance` (defaults to `DEFAULT_DIFF_RATIO_TOLERANCE`). */
export function isWithinTolerance(
  result: PerceptualDiffResult,
  tolerance: number = DEFAULT_DIFF_RATIO_TOLERANCE,
): boolean {
  return result.diffRatio <= tolerance;
}
