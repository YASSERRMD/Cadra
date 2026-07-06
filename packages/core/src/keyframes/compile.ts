import { interpolateColor, interpolateVector3, lerp } from "../interpolation/lerp.js";
import type { ColorRGBA, Vector3 } from "../scene-graph/primitives.js";
import { EASING_FUNCTIONS } from "./easing.js";
import {
  isKeyframeTrack,
  type Keyframe,
  type KeyframeTrack,
  type Property,
} from "./keyframe-track.js";

/**
 * Compiles a `KeyframeTrack<T>` into a reusable evaluator closure: a pure
 * `(frame: number) => T` function, exactly the same shape as every other
 * frame function in this package (see `../frame/use-frame.ts`).
 *
 * `interpolateValue` supplies the actual blending math for `T` (e.g. `lerp`
 * for `number`, `interpolateVector3` for `Vector3`): this function only
 * handles picking the right pair of keyframes and computing local, eased
 * progress between them, so it works for any `T` without needing to know
 * anything about `T`'s shape.
 *
 * Semantics:
 * - Before the first keyframe's frame: holds at the first keyframe's value.
 * - After the last keyframe's frame: holds at the last keyframe's value.
 * - Between two keyframes `k1` and `k2`: computes local progress
 *   `t = (frame - k1.frame) / (k2.frame - k1.frame)`, applies `k1.easing`'s
 *   curve to `t` (default `'linear'`), then calls
 *   `interpolateValue(k1.value, k2.value, easedT)`.
 * - Exception: if `k1.easing === 'hold'`, the segment holds at `k1.value` for
 *   its entire span (no call to `interpolateValue`), only jumping to
 *   `k2.value` once `frame` reaches `k2.frame` exactly (that landing value
 *   comes from the *next* segment's start, or the "after the last keyframe"
 *   case if `k2` is the last keyframe).
 *
 * Does not validate `track.keyframes`: pass it through `validateKeyframeTrack`
 * first if the track may be untrusted, agent-authored input. A track with
 * exactly one keyframe still works, behaving as a constant lookup (its value
 * both before and after its own frame); a track with zero keyframes throws,
 * since there is no value to return for a track authored with no points at
 * all.
 */
export function compileKeyframeTrack<T>(
  track: KeyframeTrack<T>,
  interpolateValue: (a: T, b: T, t: number) => T,
): (frame: number) => T {
  const { keyframes } = track;
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("compileKeyframeTrack: KeyframeTrack must have at least one keyframe.");
  }

  return function evaluate(frame: number): T {
    if (frame <= first.frame) {
      return first.value;
    }
    if (frame >= last.frame) {
      return last.value;
    }

    const segmentIndex = findSegmentIndex(keyframes, frame);
    const k1 = keyframes[segmentIndex];
    const k2 = keyframes[segmentIndex + 1];
    if (k1 === undefined || k2 === undefined) {
      throw new Error("compileKeyframeTrack: invalid segment index.");
    }

    // Landing exactly on k2's frame always snaps to k2's value, independent
    // of k1's easing. For continuous curves this is a no-op (any curve with
    // easing(1) === 1 already reaches k2.value at t=1), but 'hold' never
    // calls interpolateValue at all, so without this check it would keep
    // reporting k1.value one frame too long, at the exact frame that is
    // supposed to be the jump.
    if (frame === k2.frame) {
      return k2.value;
    }

    if (k1.easing === "hold") {
      return k1.value;
    }

    const localT = (frame - k1.frame) / (k2.frame - k1.frame);
    const easingName = k1.easing ?? "linear";
    const easedT = EASING_FUNCTIONS[easingName](localT);
    return interpolateValue(k1.value, k2.value, easedT);
  };
}

/**
 * Finds the index `i` such that `keyframes[i].frame <= frame <=
 * keyframes[i + 1].frame`, for `frame` already known to be strictly between
 * the first and last keyframe's frames. Linear scan: keyframe tracks are
 * expected to be short, mirroring `findSegmentIndex` in
 * `../interpolation/interpolate.ts`.
 */
function findSegmentIndex<T>(keyframes: ReadonlyArray<Keyframe<T>>, frame: number): number {
  for (let i = 0; i < keyframes.length - 1; i += 1) {
    const segmentEnd = keyframes[i + 1];
    if (segmentEnd === undefined || frame <= segmentEnd.frame) {
      return i;
    }
  }
  return keyframes.length - 2;
}

/**
 * Resolves a `Property<T>` at a given `frame`: the one code path constant and
 * keyframed properties both flow through.
 *
 * If `property` is a plain constant (not a `KeyframeTrack`), returns it
 * directly, unchanged by `frame`. Otherwise compiles and evaluates the track
 * via `compileKeyframeTrack`. Callers that resolve the same track across many
 * frames (e.g. once per rendered frame of a composition) may prefer to call
 * `compileKeyframeTrack` once and reuse the returned closure, rather than
 * recompiling on every `resolveProperty` call.
 */
export function resolveProperty<T>(
  property: Property<T>,
  frame: number,
  interpolateValue: (a: T, b: T, t: number) => T,
): T {
  if (!isKeyframeTrack(property)) {
    return property;
  }
  return compileKeyframeTrack(property, interpolateValue)(frame);
}

// Thin `(a, b, t)`-shaped adapters over Phase 9's `(t, from, to)`-ordered
// interpolation helpers, so the specializations below share the exact same
// `interpolateValue` signature `compileKeyframeTrack`/`resolveProperty` use
// generically.
function lerpValue(a: number, b: number, t: number): number {
  return lerp(a, b, t);
}
function interpolateVector3Value(a: Vector3, b: Vector3, t: number): Vector3 {
  return interpolateVector3(t, a, b);
}
function interpolateColorValue(a: ColorRGBA, b: ColorRGBA, t: number): ColorRGBA {
  return interpolateColor(t, a, b);
}

/**
 * Step-function "interpolation" for `boolean`: there is no continuous blend
 * between `true` and `false`, so this holds `a` for the entire segment and
 * only switches to `b` once `t` reaches `1`. In practice, `compileKeyframeTrack`
 * already snaps to `k2.value` exactly at `frame === k2.frame` (independent of
 * easing), so this function's `t === 1` branch is rarely the one actually
 * invoked; it exists so `resolveBooleanProperty` still returns a well-defined
 * value for every `t`, matching the `(a, b, t) => T` shape every other
 * specialization uses, even for a segment authored with a continuous easing
 * (e.g. `'linear'`) instead of the natural `'hold'`.
 */
function stepBooleanValue(a: boolean, b: boolean, t: number): boolean {
  return t >= 1 ? b : a;
}

/** `resolveProperty` specialized for plain `number` properties, using `lerp`. */
export function resolveNumberProperty(property: Property<number>, frame: number): number {
  return resolveProperty(property, frame, lerpValue);
}

/** `resolveProperty` specialized for `Vector3` properties, using `interpolateVector3`. */
export function resolveVector3Property(property: Property<Vector3>, frame: number): Vector3 {
  return resolveProperty(property, frame, interpolateVector3Value);
}

/** `resolveProperty` specialized for `ColorRGBA` properties, using `interpolateColor`. */
export function resolveColorProperty(property: Property<ColorRGBA>, frame: number): ColorRGBA {
  return resolveProperty(property, frame, interpolateColorValue);
}

/**
 * `resolveProperty` specialized for `boolean` properties, using
 * `stepBooleanValue`: a keyframed `visible` (or any other boolean property)
 * steps discretely between keyframe values rather than blending, since there
 * is nothing to blend between `true` and `false`. Authoring a boolean
 * keyframe track with `'hold'` easing (see `Keyframe.easing`) makes this
 * step explicit and is the recommended convention; a track authored with a
 * continuous easing still behaves correctly (see `stepBooleanValue`), just
 * without a meaningful "in-between" value.
 */
export function resolveBooleanProperty(property: Property<boolean>, frame: number): boolean {
  return resolveProperty(property, frame, stepBooleanValue);
}
