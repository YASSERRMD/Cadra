import { lerp } from "../interpolation/lerp.js";
import { createFrameRandom } from "./prng.js";

/**
 * Deterministic, continuous (not flickery) pseudo-random noise: a classic
 * value-noise construction over `createFrameRandom`'s own per-frame
 * generator, used as the random source at fixed integer checkpoints
 * (`floor(frame / periodFrames)` frames apart) and linearly interpolated
 * between them.
 *
 * `createFrameRandom(seed, frame).next()` alone is unsuitable for a jitter
 * or wobble effect sampled once per frame: it is deliberately re-seeded
 * fresh every single frame (so evaluating frame 500 in isolation matches
 * evaluating frames 0..999 in order), which means consecutive frames'
 * values have no correlation at all - sampled directly, it looks like
 * flickering static, not an organic wobble. Interpolating between values
 * anchored at sparser checkpoints (rather than every frame) is what turns
 * that into a smooth, continuous signal, while remaining exactly as
 * deterministic: the same `(seed, frame, periodFrames)` always resolves to
 * the same output, regardless of evaluation order.
 *
 * Returns a value in `[-1, 1]`.
 */
export function smoothNoise(seed: string | number, frame: number, periodFrames: number): number {
  const checkpoint = Math.floor(frame / periodFrames);
  const localProgress = frame / periodFrames - checkpoint;
  const start = createFrameRandom(seed, checkpoint).next();
  const end = createFrameRandom(seed, checkpoint + 1).next();
  return lerp(start, end, localProgress) * 2 - 1;
}
