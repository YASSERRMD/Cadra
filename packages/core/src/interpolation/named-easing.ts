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
} from "./easing.js";

/**
 * Every named curve `easing.ts` exports (excluding `cubicBezier`, a factory
 * rather than a ready-made curve), as a serializable string: the bridge
 * between a JSON scene document (which cannot carry a function value) and
 * the real `(t: number) => number` curve `interpolate`'s own `easing`
 * option expects.
 */
export type EasingName =
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
  | "easeInOutElastic";

const EASING_FUNCTIONS_BY_NAME: Readonly<Record<EasingName, (t: number) => number>> = {
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

/** Resolves an `EasingName` to the real curve function it names, for handing to `interpolate`'s `options.easing`. */
export function resolveEasingFunction(name: EasingName): (t: number) => number {
  return EASING_FUNCTIONS_BY_NAME[name];
}
