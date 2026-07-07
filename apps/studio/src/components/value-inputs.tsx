import type { ColorRGBA, Vector3 } from "@cadra/core";
import type { JSX } from "react";
import { useEffect, useState } from "react";

/**
 * The plain-value editors `PropertyEditor` renders for a constant (non-
 * keyframed) property, or for one keyframe's own `value` in the keyframe
 * list editor: one component per `PropertyValueKind` (see
 * `../inspector/property-descriptors.js`).
 *
 * Commit-on-blur/Enter, never on every keystroke: `NumberInput` (and
 * `ColorInput`'s own alpha field, which is just a `NumberInput`) tracks its
 * typed-but-not-yet-committed text in local `useState`, calling `onCommit`
 * only on blur or on an Enter keypress, exactly the strategy this phase's
 * own design note calls for (see `App.tsx`'s and `Viewport.tsx`'s docs on
 * why a `document` change remounts the whole preview, which a commit-per-
 * keystroke would make janky). `BooleanInput`'s checkbox and `ColorInput`'s
 * own native color-picker both commit immediately instead, on their one
 * single-step "choose a value" gesture (a checkbox toggle, or a color
 * picker's own confirm/apply): neither has a meaningful "still typing,
 * nothing decided yet" moment the way a text field does, so there is no
 * in-progress state worth deferring for either. `Vector3Input` is three
 * independent `NumberInput`s (one per component), each following this same
 * blur/Enter posture on its own.
 *
 * `NumberInput` re-syncs its local text from `value` whenever `value`
 * itself changes for a reason other than this input's own last commit (e.g.
 * the playhead moved to a different frame, so the resolved constant is now
 * different, or an undo/redo restored a different value): the `useEffect`
 * keyed on `value` is what keeps a not-currently-focused input from showing
 * a stale value after such a change.
 */

/** Props shared by every plain-value editor below: the resolved current value, and a commit callback. */
interface ValueInputProps<T> {
  value: T;
  onCommit: (next: T) => void;
  /** Forwarded to the rendered input's own `data-testid`, so a specific property's editor is targetable in tests. */
  testId?: string;
}

/** A single-line numeric text input, committing its parsed value on blur or Enter. Invalid (non-numeric) text is discarded on commit, reverting to the last-known `value` rather than committing `NaN`. */
export function NumberInput({ value, onCommit, testId }: ValueInputProps<number>): JSX.Element {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  function commit(): void {
    const parsed = Number(text);
    if (Number.isFinite(parsed)) {
      onCommit(parsed);
    } else {
      setText(String(value));
    }
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      className="cadra-inspector__number-input"
      value={text}
      data-testid={testId}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** A checkbox for a `boolean` property, committing immediately on toggle (a checkbox has no meaningful "in-progress" state to defer, unlike a text field or drag). */
export function BooleanInput({ value, onCommit, testId }: ValueInputProps<boolean>): JSX.Element {
  return (
    <input
      type="checkbox"
      className="cadra-inspector__boolean-input"
      checked={value}
      data-testid={testId}
      onChange={(event) => onCommit(event.target.checked)}
    />
  );
}

/** Labels for a `Vector3`'s three components, in order. */
const VECTOR3_COMPONENT_LABELS = ["X", "Y", "Z"] as const;

/** Three `NumberInput`s side by side for a `Vector3`, committing the whole tuple (with just that one component replaced) whenever any single component commits. */
export function Vector3Input({ value, onCommit, testId }: ValueInputProps<Vector3>): JSX.Element {
  return (
    <div className="cadra-inspector__vector3-input">
      {VECTOR3_COMPONENT_LABELS.map((componentLabel, index) => (
        <label key={componentLabel} className="cadra-inspector__vector3-component">
          <span className="cadra-inspector__vector3-component-label">{componentLabel}</span>
          <NumberInput
            value={value[index] ?? 0}
            testId={testId !== undefined ? `${testId}-${componentLabel.toLowerCase()}` : undefined}
            onCommit={(next) => {
              const nextVector: Vector3 = [...value];
              nextVector[index] = next;
              onCommit(nextVector);
            }}
          />
        </label>
      ))}
    </div>
  );
}

/** Converts a 0-1 `ColorRGBA` channel to a 2-digit hex string. */
function channelToHex(channel: number): string {
  const clamped = Math.min(1, Math.max(0, channel));
  return Math.round(clamped * 255)
    .toString(16)
    .padStart(2, "0");
}

/** Converts a `ColorRGBA` (each channel 0-1) to a `#rrggbb` string for a native `<input type="color">` (which has no alpha channel of its own; see this component's own separate alpha `NumberInput`). */
function colorToHex(color: ColorRGBA): string {
  return `#${channelToHex(color[0])}${channelToHex(color[1])}${channelToHex(color[2])}`;
}

/** Converts a `#rrggbb` (or `#rgb`) hex string back to 0-1 red/green/blue channels, preserving the existing alpha. */
function hexToColor(hex: string, previousAlpha: number): ColorRGBA {
  const normalized = hex.length === 4
    ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
    : hex;
  const red = parseInt(normalized.slice(1, 3), 16) / 255;
  const green = parseInt(normalized.slice(3, 5), 16) / 255;
  const blue = parseInt(normalized.slice(5, 7), 16) / 255;
  return [red, green, blue, previousAlpha];
}

/** A native color picker for RGB, plus a separate `NumberInput` for alpha (0-1), together committing a full `ColorRGBA`. */
export function ColorInput({ value, onCommit, testId }: ValueInputProps<ColorRGBA>): JSX.Element {
  return (
    <div className="cadra-inspector__color-input">
      <input
        type="color"
        value={colorToHex(value)}
        data-testid={testId}
        onChange={(event) => onCommit(hexToColor(event.target.value, value[3]))}
      />
      <NumberInput
        value={value[3]}
        testId={testId !== undefined ? `${testId}-alpha` : undefined}
        onCommit={(alpha) => onCommit([value[0], value[1], value[2], alpha])}
      />
    </div>
  );
}
