import type { Keyframe, KeyframeTrack } from "@cadra/core";

/**
 * What `.animate()` accepts for a single animatable property: either the
 * bare list of keyframes (the common case, since the `type: "keyframeTrack"`
 * discriminant is pure boilerplate a caller would otherwise repeat on every
 * call), or an already-built `KeyframeTrack<T>` for a caller that already has
 * one (e.g. reusing a track across several nodes).
 */
export type AnimateInput<T> = ReadonlyArray<Keyframe<T>> | KeyframeTrack<T>;

/** Narrows `input` to `KeyframeTrack<T>` by checking for the discriminant, not by array-ness alone. */
function isKeyframeTrackInput<T>(input: AnimateInput<T>): input is KeyframeTrack<T> {
  return !Array.isArray(input);
}

/**
 * Normalizes `.animate()`'s input into a proper `KeyframeTrack<T>`, adding
 * the `type: "keyframeTrack"` discriminant for the bare-array form.
 *
 * Does not validate the keyframes' `frame` ordering itself: `SceneBuilder`'s
 * `.build()` validates the whole assembled document through
 * `@cadra/schema`'s `parseScene` (which enforces strictly-increasing,
 * non-negative integer frames, exactly like `validateKeyframeTrack` in
 * `@cadra/core`), so an out-of-order or malformed track surfaces as a
 * `SceneBuildError` with a precise diagnostic rather than being silently
 * accepted here and failing later with less context.
 */
export function toKeyframeTrack<T>(input: AnimateInput<T>): KeyframeTrack<T> {
  if (isKeyframeTrackInput(input)) {
    return input;
  }
  return { type: "keyframeTrack", keyframes: [...input] };
}
