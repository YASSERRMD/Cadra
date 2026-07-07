import type { ColorRGBA, Easing, Keyframe, KeyframeTrack, Property, Vector3 } from "@cadra/core";
import {
  isKeyframeTrack,
  resolveBooleanProperty,
  resolveColorProperty,
  resolveNumberProperty,
  resolveVector3Property,
} from "@cadra/core";
import type { SceneParseDiagnostic } from "@cadra/schema";
import type { JSX } from "react";
import { useState } from "react";

import type { PropertyDescriptor } from "../inspector/property-descriptors.js";
import type { AnyPropertyValue } from "../inspector/property-path.js";
import { EasingPicker } from "./EasingPicker.js";
import { BooleanInput, ColorInput, NumberInput, Vector3Input } from "./value-inputs.js";

/** Props for `PropertyEditor`. */
export interface PropertyEditorProps {
  descriptor: PropertyDescriptor;
  /** The raw, unresolved `Property<T>` currently stored at `descriptor.path` (a plain constant or a `KeyframeTrack`). */
  property: AnyPropertyValue;
  /** The shared `PreviewHandle`'s current frame: what a constant is "resolved at" for display, where a newly converted/added keyframe is seeded, and what selecting an existing keyframe seeks to. */
  currentFrame: number;
  /**
   * Commits a candidate replacement for this property (the caller splices
   * it back into the selected node/clip/document and calls the store's
   * `commitDocument`; see `InspectorPanel`). Returns `undefined` on success,
   * or the rejected edit's diagnostics on failure, so this component can
   * show them inline next to the specific field involved (Phase 39's task
   * 5), rather than only the toolbar's existing whole-document
   * `lastValidationError` display.
   */
  onCommitProperty: (next: AnyPropertyValue) => SceneParseDiagnostic[] | undefined;
  /** Calls the shared `PreviewHandle.seek`, so selecting a keyframe moves the playhead to it (Phase 39's task 4, reusing Phase 38's own `seek`). */
  onSeek: (frame: number) => void;
}

/** Formats a `SceneParseDiagnostic[]` as a single inline string: every rejected edit's message, joined, so a field shows all of its own diagnostics at once rather than only the first. */
function formatDiagnostics(diagnostics: SceneParseDiagnostic[]): string {
  return diagnostics.map((diagnostic) => diagnostic.message).join(" ");
}

/** Resolves `property` (any of the four value kinds) to its concrete display value at `frame`, dispatching to the matching `resolve*Property` specialization by `descriptor.valueKind`. Returns the resolved value boxed as `unknown`, unboxed again immediately by each `renderValueInput` branch below (each of which already knows, from its own `valueKind` case, exactly which concrete type it is). */
function resolveDisplayValue(
  descriptor: PropertyDescriptor,
  property: AnyPropertyValue,
  frame: number,
): number | Vector3 | ColorRGBA | boolean {
  switch (descriptor.valueKind) {
    case "number":
      return resolveNumberProperty(property as Property<number>, frame);
    case "vector3":
      return resolveVector3Property(property as Property<Vector3>, frame);
    case "color":
      return resolveColorProperty(property as Property<ColorRGBA>, frame);
    case "boolean":
      return resolveBooleanProperty(property as Property<boolean>, frame);
  }
}

/**
 * One property's full editor: for a constant, the matching plain-value
 * input (Phase 39's task 1) plus a "Convert to keyframes" button (task 2);
 * for a `KeyframeTrack`, a keyframe list with add/move/delete/easing (task
 * 3), two-way bound to `commitDocument` (task 4), with any rejected edit's
 * diagnostics shown inline right below the field that produced them (task
 * 5).
 */
export function PropertyEditor({
  descriptor,
  property,
  currentFrame,
  onCommitProperty,
  onSeek,
}: PropertyEditorProps): JSX.Element {
  const [diagnostics, setDiagnostics] = useState<SceneParseDiagnostic[] | undefined>(undefined);
  const testIdBase = `inspector-property-${descriptor.path}`;

  function commit(next: AnyPropertyValue): void {
    setDiagnostics(onCommitProperty(next));
  }

  const isTrack = isKeyframeTrack(property);
  const displayValue = resolveDisplayValue(descriptor, property, currentFrame);

  return (
    <div className="cadra-inspector__property" data-testid={testIdBase}>
      <div className="cadra-inspector__property-header">
        <span className="cadra-inspector__property-label">{descriptor.label}</span>
        {!isTrack && (
          <button
            type="button"
            data-testid={`${testIdBase}-convert-to-keyframes`}
            onClick={() => {
              const seeded: KeyframeTrack<AnyPropertyValue> = {
                type: "keyframeTrack",
                keyframes: [{ frame: currentFrame, value: property }],
              };
              // Cast justified the same way every branch below is: `seeded`
              // is a KeyframeTrack over exactly `property`'s own value type
              // (whichever of the four AnyPropertyValue members it actually
              // is), which is exactly what `onCommitProperty` expects; the
              // union-of-Propertys shape `AnyPropertyValue` itself is not
              // otherwise expressible as "a KeyframeTrack of whichever
              // member `property` happens to be" without a conditional
              // type this narrow call site does not need.
              commit(seeded as AnyPropertyValue);
            }}
          >
            Convert to keyframes
          </button>
        )}
      </div>

      {!isTrack && (
        <div className="cadra-inspector__property-value" data-testid={`${testIdBase}-constant`}>
          {renderValueInput(descriptor, displayValue, commit, `${testIdBase}-value`)}
        </div>
      )}

      {isTrack && (
        <KeyframeListEditor
          descriptor={descriptor}
          track={property as KeyframeTrack<AnyPropertyValue>}
          currentFrame={currentFrame}
          onCommitTrack={commit}
          onSeek={onSeek}
          testIdBase={testIdBase}
        />
      )}

      {diagnostics !== undefined && diagnostics.length > 0 && (
        <div className="cadra-inspector__property-diagnostics" data-testid={`${testIdBase}-diagnostics`}>
          {formatDiagnostics(diagnostics)}
        </div>
      )}
    </div>
  );
}

/** Renders the matching plain-value input for one resolved display value, dispatching on `descriptor.valueKind`. Each branch narrows `displayValue`/`onCommit` back to its own concrete type via a cast justified by that same `valueKind` check (the same "known by construction, not re-derivable from `unknown` alone without narrowing TypeScript cannot itself perform across this dispatch" shape `resolveDisplayValue` above already has). */
function renderValueInput(
  descriptor: PropertyDescriptor,
  displayValue: number | Vector3 | ColorRGBA | boolean,
  onCommit: (next: AnyPropertyValue) => void,
  testId: string,
): JSX.Element {
  switch (descriptor.valueKind) {
    case "number":
      return (
        <NumberInput
          value={displayValue as number}
          onCommit={(next) => onCommit(next)}
          testId={testId}
        />
      );
    case "vector3":
      return (
        <Vector3Input
          value={displayValue as Vector3}
          onCommit={(next) => onCommit(next)}
          testId={testId}
        />
      );
    case "color":
      return (
        <ColorInput
          value={displayValue as ColorRGBA}
          onCommit={(next) => onCommit(next)}
          testId={testId}
        />
      );
    case "boolean":
      return (
        <BooleanInput
          value={displayValue as boolean}
          onCommit={(next) => onCommit(next)}
          testId={testId}
        />
      );
  }
}

/** Props for `KeyframeListEditor`. */
interface KeyframeListEditorProps {
  descriptor: PropertyDescriptor;
  track: KeyframeTrack<AnyPropertyValue>;
  currentFrame: number;
  onCommitTrack: (next: AnyPropertyValue) => void;
  onSeek: (frame: number) => void;
  testIdBase: string;
}

/**
 * Lists a `KeyframeTrack`'s keyframes (frame, value, easing), letting the
 * user add one at the current playhead frame, retype an existing one's
 * frame or value, delete one, and change its easing to any `Easing` value
 * (Phase 39's task 3). Selecting (clicking) a keyframe's own row seeks the
 * shared `PreviewHandle` to that keyframe's frame (task 4).
 *
 * Every mutation here (add/edit/delete) builds the full next
 * `keyframes` array locally, then calls `onCommitTrack` exactly once with
 * the whole replacement `KeyframeTrack`: there is no separate "add" store
 * action distinct from "edit"/"delete", mirroring how `PropertyEditor`
 * itself has exactly one `onCommitProperty` funnel for both a constant and
 * a track, which itself mirrors `commitDocument` being this whole app's one
 * funnel for every mutation.
 */
function KeyframeListEditor({
  descriptor,
  track,
  currentFrame,
  onCommitTrack,
  onSeek,
  testIdBase,
}: KeyframeListEditorProps): JSX.Element {
  function replaceKeyframes(nextKeyframes: Keyframe<AnyPropertyValue>[]): void {
    // Keyframes are expected in strictly increasing frame order (see
    // `KeyframeTrack`'s own doc); sorting here (rather than trusting
    // insertion order, or requiring the caller to) keeps that invariant
    // true after every edit this editor performs, including "retype an
    // existing keyframe's frame to something past its neighbor's".
    const sorted = [...nextKeyframes].sort((a, b) => a.frame - b.frame);
    const nextTrack: KeyframeTrack<AnyPropertyValue> = { type: "keyframeTrack", keyframes: sorted };
    // Cast justified the same way PropertyEditor's own "Convert to
    // keyframes" button already is: `nextTrack` is a KeyframeTrack over
    // exactly this property's own concrete value type (whichever
    // AnyPropertyValue member `descriptor.valueKind` actually names), which
    // is exactly what `onCommitTrack` (itself typed to accept
    // AnyPropertyValue, matching every other commit funnel in this file)
    // expects; TypeScript cannot itself verify "this KeyframeTrack<union>
    // is actually a KeyframeTrack<one-specific-member>" without a
    // conditional type this call site does not need.
    onCommitTrack(nextTrack as AnyPropertyValue);
  }

  function handleAddKeyframe(): void {
    const existingAtFrame = track.keyframes.find((keyframe) => keyframe.frame === currentFrame);
    if (existingAtFrame !== undefined) {
      // Already a keyframe at this exact frame: adding a second one at the
      // same frame would violate the strictly-increasing-frame invariant,
      // so this is a no-op rather than silently producing an invalid track.
      return;
    }
    const seedValue = resolveDisplayValueForTrack(descriptor, track, currentFrame);
    replaceKeyframes([...track.keyframes, { frame: currentFrame, value: seedValue }]);
  }

  function handleDeleteKeyframe(index: number): void {
    replaceKeyframes(track.keyframes.filter((_keyframe, keyframeIndex) => keyframeIndex !== index));
  }

  function handleFrameChange(index: number, nextFrame: number): void {
    replaceKeyframes(
      track.keyframes.map((keyframe, keyframeIndex) =>
        keyframeIndex === index ? { ...keyframe, frame: nextFrame } : keyframe,
      ),
    );
  }

  function handleValueChange(index: number, nextValue: AnyPropertyValue): void {
    replaceKeyframes(
      track.keyframes.map((keyframe, keyframeIndex) =>
        keyframeIndex === index ? { ...keyframe, value: nextValue } : keyframe,
      ),
    );
  }

  function handleEasingChange(index: number, nextEasing: Easing): void {
    replaceKeyframes(
      track.keyframes.map((keyframe, keyframeIndex) =>
        keyframeIndex === index ? { ...keyframe, easing: nextEasing } : keyframe,
      ),
    );
  }

  return (
    <div className="cadra-inspector__keyframe-list" data-testid={`${testIdBase}-keyframe-list`}>
      <button
        type="button"
        data-testid={`${testIdBase}-add-keyframe`}
        onClick={handleAddKeyframe}
      >
        Add keyframe at frame {currentFrame}
      </button>
      {track.keyframes.map((keyframe, index) => (
        // Keyed on array index: keyframes carry no id of their own (see
        // Keyframe's own doc: they are identified by position/frame, not a
        // stable key), and index is stable across this list's own
        // re-renders since every edit here rebuilds and commits the whole
        // array in one go (see replaceKeyframes above), never reordering
        // rows independent of a full re-render.
        <div
          key={index}
          className="cadra-inspector__keyframe-row"
          data-testid={`${testIdBase}-keyframe-${index}`}
        >
          <button
            type="button"
            className="cadra-inspector__keyframe-seek"
            data-testid={`${testIdBase}-keyframe-${index}-seek`}
            onClick={() => onSeek(keyframe.frame)}
          >
            {"->"}
          </button>
          <NumberInput
            value={keyframe.frame}
            testId={`${testIdBase}-keyframe-${index}-frame`}
            onCommit={(nextFrame) => handleFrameChange(index, nextFrame)}
          />
          {renderValueInput(
            descriptor,
            keyframe.value as number | Vector3 | ColorRGBA | boolean,
            (nextValue) => handleValueChange(index, nextValue),
            `${testIdBase}-keyframe-${index}-value`,
          )}
          <EasingPicker
            value={keyframe.easing}
            testId={`${testIdBase}-keyframe-${index}-easing`}
            onChange={(nextEasing) => handleEasingChange(index, nextEasing)}
          />
          <button
            type="button"
            data-testid={`${testIdBase}-keyframe-${index}-delete`}
            onClick={() => handleDeleteKeyframe(index)}
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}

/** Resolves a `KeyframeTrack<AnyPropertyValue>` to its concrete value at `frame`, used only to seed a newly added keyframe with the property's own current interpolated value (a sensible, lossless starting point identical in spirit to how converting a constant seeds from that constant, per this phase's task 2), rather than an arbitrary default. */
function resolveDisplayValueForTrack(
  descriptor: PropertyDescriptor,
  track: KeyframeTrack<AnyPropertyValue>,
  frame: number,
): AnyPropertyValue {
  // Cast justified the same way every other AnyPropertyValue-union
  // boundary in this file is: `track` is a KeyframeTrack over exactly this
  // property's own concrete value type, matching resolveDisplayValue's own
  // `property: AnyPropertyValue` parameter (which itself already handles a
  // constant-or-track Property<T> uniformly via isKeyframeTrack internally
  // through the individual resolve*Property calls); TypeScript cannot
  // itself verify "this KeyframeTrack<union> is actually one specific
  // union member" without a conditional type this call site does not need.
  return resolveDisplayValue(descriptor, track as AnyPropertyValue, frame) as AnyPropertyValue;
}
