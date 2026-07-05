import { interpolate } from "../interpolation/interpolate.js";
import type { Transition } from "../scene-graph/timeline.js";

/**
 * Computes how far into `transition` has progressed, as a `0..1` blend
 * factor, given `framesIntoTransition` (the number of frames since the
 * incoming clip's own `startFrame`, i.e. `frame - clip.startFrame`).
 *
 * Reuses Phase 9's `interpolate` with `inputRange: [0, transition.durationInFrames]`
 * and `outputRange: [0, 1]`, clamped on both sides (`extrapolateLeft: 'clamp'`,
 * `extrapolateRight: 'clamp'`): `0` at or before the transition starts, `1`
 * at or after it ends, and a straight linear ramp in between. Clamping
 * (rather than the `interpolate` default of `'extend'`) is deliberate here,
 * since a blend factor outside `[0, 1]` has no meaningful interpretation as
 * an opacity.
 */
export function resolveTransitionBlend(
  transition: Transition,
  framesIntoTransition: number,
): number {
  return interpolate(framesIntoTransition, [0, transition.durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}
