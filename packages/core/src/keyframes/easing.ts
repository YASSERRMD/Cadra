import {
  easeInBack,
  easeInCubic,
  easeInElastic,
  easeInExpo,
  easeInOutBack,
  easeInOutCubic,
  easeInOutElastic,
  easeInOutExpo,
  easeOutBack,
  easeOutCubic,
  easeOutElastic,
  easeOutExpo,
  linear,
} from "../interpolation/easing.js";

/**
 * Every easing curve a `Keyframe` can name, by string literal: every named
 * curve Phase 9's `interpolation/easing.ts` exports, plus `'hold'`.
 *
 * `'hold'` is not a continuous curve like the others: it is a step function
 * (stay at the starting keyframe's value for the whole segment, then jump at
 * the next keyframe's frame) with no `(t: number) => number` representation,
 * so it is handled specially by `compileKeyframeTrack` rather than looked up
 * in `EASING_FUNCTIONS` below.
 */
export type Easing =
  | "linear"
  | "easeInCubic"
  | "easeOutCubic"
  | "easeInOutCubic"
  | "easeInExpo"
  | "easeOutExpo"
  | "easeInOutExpo"
  | "easeInBack"
  | "easeOutBack"
  | "easeInOutBack"
  | "easeInElastic"
  | "easeOutElastic"
  | "easeInOutElastic"
  | "hold";

/** An easing curve name that maps to a real `(t: number) => number` function (every `Easing` except `'hold'`). */
export type ContinuousEasing = Exclude<Easing, "hold">;

/**
 * Lookup from every continuous `Easing` name to its Phase 9 curve function.
 * Deliberately excludes `'hold'`: that name has no `(t: number) => number`
 * form, since it holds a constant value rather than mapping progress to
 * progress. Callers that may see `'hold'` must check for it before indexing
 * into this table (see `compileKeyframeTrack`).
 */
export const EASING_FUNCTIONS: Record<ContinuousEasing, (t: number) => number> = {
  linear,
  easeInCubic,
  easeOutCubic,
  easeInOutCubic,
  easeInExpo,
  easeOutExpo,
  easeInOutExpo,
  easeInBack,
  easeOutBack,
  easeInOutBack,
  easeInElastic,
  easeOutElastic,
  easeInOutElastic,
};
