import { interpolate } from "../interpolation/interpolate.js";
import type { AudioClip } from "../scene-graph/timeline.js";

/**
 * Effective fade durations for `clip`, clamped so `fadeIn` and `fadeOut`
 * never overlap past the clip's own midpoint.
 *
 * A clip authored with `fadeIn.durationInFrames + fadeOut.durationInFrames`
 * exceeding `durationInFrames` would otherwise have its two ramps cross
 * before either finishes, producing a non-monotonic (dip-then-rise) gain
 * curve near the middle of the clip. Instead, each fade is capped at half the
 * clip's duration (`fadeIn` at `floor(durationInFrames / 2)`, `fadeOut` at
 * `ceil(durationInFrames / 2)`, which always sum to exactly
 * `durationInFrames`): the two ramps meet at, but never cross, the midpoint,
 * so gain reaches (at worst) 0 for a single instant at the middle of a very
 * short clip rather than ever rising again after it starts falling.
 */
function effectiveFadeDurations(clip: AudioClip): {
  fadeInFrames: number;
  fadeOutFrames: number;
} {
  const half = clip.durationInFrames / 2;
  const fadeInFrames = Math.min(clip.fadeIn?.durationInFrames ?? 0, Math.floor(half));
  const fadeOutFrames = Math.min(clip.fadeOut?.durationInFrames ?? 0, Math.ceil(half));
  return { fadeInFrames, fadeOutFrames };
}

/**
 * Computes the gain `clip` should play at, at `localFrame` (a frame index
 * local to the clip's own window: `0` at `clip.startFrame`, matching
 * `resolveSequenceFrame`'s `localFrame` convention).
 *
 * Base gain is `clip.gain` (defaulting to `1`). When `fadeIn` is present,
 * gain ramps linearly from `0` up to `clip.gain` over the first
 * `fadeIn.durationInFrames` frames. When `fadeOut` is present, gain ramps
 * linearly from `clip.gain` down to `0` over the last
 * `fadeOut.durationInFrames` frames. Outside any fade window, gain is simply
 * `clip.gain`. See `effectiveFadeDurations` for how an over-long fade (or two
 * fades that would otherwise overlap) is clamped.
 *
 * Built on `interpolate` (Phase 9): the fade shape is a piecewise-linear
 * ramp through a handful of `(frame, gain)` breakpoints, exactly what
 * `interpolate` already computes, with `extrapolateLeft`/`extrapolateRight:
 * "clamp"` so `localFrame` outside `[0, durationInFrames)` holds at the
 * nearest boundary gain (silent before the clip starts and after it ends)
 * rather than continuing a ramp indefinitely.
 */
export function computeGainAtLocalFrame(clip: AudioClip, localFrame: number): number {
  const gain = clip.gain ?? 1;
  const { fadeInFrames, fadeOutFrames } = effectiveFadeDurations(clip);

  if (fadeInFrames === 0 && fadeOutFrames === 0) {
    return gain;
  }

  const fadeOutStart = clip.durationInFrames - fadeOutFrames;

  // Breakpoints in strictly increasing frame order, each paired with the
  // gain reached at that frame. Only the breakpoints an active fade actually
  // needs are included, since interpolate requires a strictly increasing
  // inputRange: a duplicate frame (e.g. fadeInFrames === fadeOutStart, no gap
  // between the two ramps) would violate that if both were unconditionally
  // included.
  const frames: number[] = [0];
  const gains: number[] = [fadeInFrames > 0 ? 0 : gain];

  if (fadeInFrames > 0) {
    frames.push(fadeInFrames);
    gains.push(gain);
  }
  if (fadeOutFrames > 0 && fadeOutStart > (frames.at(-1) ?? 0)) {
    frames.push(fadeOutStart);
    gains.push(gain);
  }
  if (fadeOutFrames > 0) {
    frames.push(clip.durationInFrames);
    gains.push(0);
  }

  return interpolate(localFrame, frames, gains, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}
