import type { Easing } from "./easing.js";

/**
 * The declarative keyframe/property model: how animation is authored as data
 * rather than as ad hoc per-frame math. A `Property<T>` is either a plain
 * constant value or a `KeyframeTrack<T>`; both compile down to the same pure
 * `(frame: number) => T` frame function via `resolveProperty` (see
 * `./compile.ts`), matching every other evaluation path in this package.
 */

/**
 * One authored point on a `KeyframeTrack<T>`: a value pinned at a specific
 * integer `frame`, plus how it blends into the *next* keyframe.
 *
 * `easing` describes the segment starting at this keyframe, not the one
 * ending here: it has no effect on the last keyframe of a track, since there
 * is no following segment for it to shape. Omitted means `'linear'`.
 */
export interface Keyframe<T> {
  /** The integer frame this keyframe's value applies at. */
  frame: number;
  /** The value at `frame`. */
  value: T;
  /** How this keyframe blends into the next one. Defaults to `'linear'`. */
  easing?: Easing;
}

/**
 * An ordered list of `Keyframe<T>`s describing how a property varies over
 * time.
 *
 * Carries an explicit `type` discriminant rather than being identified by
 * shape (e.g. "has a `keyframes` array"): `T` itself could coincidentally
 * have a `keyframes` field, so shape-sniffing would be ambiguous in a way a
 * literal discriminant never is. See `isKeyframeTrack` for the corresponding
 * type guard.
 *
 * Keyframes are expected in strictly increasing, non-negative integer
 * `frame` order; `validateKeyframeTrack` (see `./validate.ts`) checks this
 * without throwing, and `compileKeyframeTrack` assumes it (call
 * `validateKeyframeTrack` first if `keyframes` may be attacker- or
 * agent-authored, untrusted input).
 */
export interface KeyframeTrack<T> {
  type: "keyframeTrack";
  keyframes: Keyframe<T>[];
}

/**
 * A property that is either a plain constant value of `T`, or a
 * `KeyframeTrack<T>` describing how it varies over time. This is the type
 * every animatable field on a scene node is expected to eventually take
 * (Phase 11 onward), rather than a plain `T`.
 */
export type Property<T> = T | KeyframeTrack<T>;

/**
 * Narrows a `Property<T>` to `KeyframeTrack<T>` by checking the `type`
 * discriminant, not by inspecting `property`'s shape. This is the only
 * correct way to distinguish a keyframed property from a constant one: a
 * constant `T` could itself be an object with a `keyframes`-shaped field, so
 * only the literal `type: "keyframeTrack"` tag is unambiguous.
 */
export function isKeyframeTrack<T>(property: Property<T>): property is KeyframeTrack<T> {
  return (
    typeof property === "object" &&
    property !== null &&
    "type" in property &&
    property.type === "keyframeTrack"
  );
}
