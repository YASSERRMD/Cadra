import type { Easing } from "@cadra/core";
import type { JSX } from "react";

/**
 * Every value `Keyframe.easing` can hold (Phase 9's 13 named continuous
 * curves plus `'hold'`), in the same order `@cadra/core`'s own `Easing`
 * union declares them. A keyframe editor's easing picker needs to offer
 * every one of these (Phase 39's task 3), so this is a plain, exhaustive
 * literal list rather than derived from `EASING_FUNCTIONS` (which
 * deliberately excludes `'hold'`, since that name has no
 * `(t: number) => number` form; see that constant's own doc in
 * `@cadra/core`'s `easing.ts`).
 */
const ALL_EASING_VALUES: Easing[] = [
  "linear",
  "easeInCubic",
  "easeOutCubic",
  "easeInOutCubic",
  "easeInExpo",
  "easeOutExpo",
  "easeInOutExpo",
  "easeInBack",
  "easeOutBack",
  "easeInOutBack",
  "easeInElastic",
  "easeOutElastic",
  "easeInOutElastic",
  "hold",
];

/** Props for `EasingPicker`. */
export interface EasingPickerProps {
  /** The keyframe's current easing; `undefined` means the `Keyframe.easing` field itself is omitted, which defaults to `'linear'` (see `Keyframe.easing`'s own doc), so this picker shows `'linear'` selected in that case rather than a blank/unset option. */
  value: Easing | undefined;
  onChange: (next: Easing) => void;
  testId?: string;
}

/** A `<select>` offering every `Easing` value, for one keyframe's own easing (Phase 39's task 3). Commits immediately on selection, matching how a native `<select>`'s own single "choose one" gesture has no meaningful in-progress state to defer. */
export function EasingPicker({ value, onChange, testId }: EasingPickerProps): JSX.Element {
  return (
    <select
      className="cadra-inspector__easing-picker"
      value={value ?? "linear"}
      data-testid={testId}
      onChange={(event) => onChange(event.target.value as Easing)}
    >
      {ALL_EASING_VALUES.map((easing) => (
        <option key={easing} value={easing}>
          {easing}
        </option>
      ))}
    </select>
  );
}
