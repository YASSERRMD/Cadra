import type { SceneDocument, SceneParseDiagnostic } from "@cadra/schema";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";

import { findSelectedClip } from "../inspector/find-selected-clip.js";

/** Props for `DslPanel`. */
export interface DslPanelProps {
  /** The current, always-schema-valid scene document; the textarea's displayed text is re-derived from this whenever the panel is not mid-edit (see this component's own doc). */
  document: SceneDocument;
  /**
   * Commits a candidate value (the panel's own `JSON.parse`d textarea
   * contents) through the store's `commitDocument` funnel, returning
   * `undefined` on success or the rejected edit's diagnostics on failure.
   * The exact same shape as `App.tsx`'s own `commitPropertyEdit` (built for
   * `InspectorPanel`, Phase 39): a thin wrapper around the store's
   * `commitDocument` that also reads back `lastValidationError` synchronously.
   */
  commitDslEdit: (candidate: unknown) => SceneParseDiagnostic[] | undefined;
  /**
   * Which `SceneNode` (by id) is currently selected, or `undefined` if
   * nothing is. Drives this panel's own bounded "highlight the selected
   * node's JSON region" behavior (see this component's own doc for its
   * exact scope) whenever selection changes from elsewhere (the viewport or
   * timeline) and this panel is not itself mid-edit.
   */
  selectedNodeId?: string | undefined;
  /**
   * Calls the store's `selectNode` action. Invoked by this panel's own
   * bounded click-to-select handler (see `handleTextareaClick` below) when a
   * click lands after a `"id": "<value>"` occurrence whose value matches a
   * real node somewhere in `document`.
   */
  onSelectNode?: (nodeId: string | undefined) => void;
}

/** Serializes `document` exactly the way this panel's textarea always displays it, and the way the store's own `saveDocument` serializes to disk (`JSON.stringify(document, null, 2)`), so round-tripping through this panel with no edits reproduces byte-identical text. */
function serializeDocument(document: SceneDocument): string {
  return JSON.stringify(document, null, 2);
}

/**
 * A live, editable JSON view of the current scene document: a plain
 * `<textarea>` (per this phase's own scope note, a real code editor library
 * is not required) showing `JSON.stringify(document, null, 2)`, that the
 * user can edit directly and apply back through the exact same
 * `commitDocument` funnel every other edit surface in this app uses.
 *
 * Edit-preservation and re-sync strategy (this phase's task 2's own open
 * design question): this panel tracks a local `isDirty` boolean, set to
 * `true` the moment the textarea's text diverges from the last text this
 * panel itself derived from `document` (via `onChange`), and reset to
 * `false` whenever an edit is either successfully applied or explicitly
 * reverted. The displayed text is re-derived from a *new* `document` prop
 * (e.g. a gizmo drag committed elsewhere, or an undo/redo) via a `useEffect`
 * keyed on `[document]` - but only actually overwrites the textarea's value
 * when `isDirty` is `false`. This is the "only auto-refresh when not
 * currently dirty" option this phase's spec offers as one reasonable
 * choice, chosen over "diff and preserve cursor position" for a concrete
 * reason: a diff-based cursor-preserving merge is substantial additional
 * complexity (mapping a cursor offset through an arbitrary structural text
 * diff) for a scope this phase's own note says should stay proportionate,
 * and "the textarea is entirely user-owned the moment they start editing,
 * and only ever snaps back to the live document on their own explicit
 * apply/revert action" is simple to reason about, simple to test, and never
 * silently destroys in-progress typing - the one hard requirement this
 * phase's spec calls out by name. The cost is real and worth stating
 * plainly: while `isDirty`, an external edit (e.g. a teammate's gizmo drag,
 * in a hypothetical multi-user future, or even just the user's own gizmo
 * drag on a *different* node while this textarea has unrelated pending
 * text) does not visibly appear in this panel until the user applies or
 * reverts their own pending edit - this panel intentionally favors "never
 * clobber what you are typing" over "always show the absolute latest
 * state", since the former is the failure mode this phase's spec explicitly
 * warns against and the latter is not.
 *
 * Apply/revert: blurring the textarea, or clicking the explicit "Apply"
 * button, attempts to `JSON.parse` the current text and run the result
 * through `commitDslEdit`. A `JSON.parse` failure (invalid JSON syntax) is
 * caught directly here; a `commitDslEdit` failure (valid JSON that fails
 * `commitDocument`'s own `parseScene` schema gate) surfaces that call's own
 * `SceneParseDiagnostic[]`. Either failure populates this panel's own
 * `parseError`/`validationDiagnostics` state, rendered inline directly under
 * the textarea (not only the existing toolbar-level `lastValidationError`
 * display, which this panel's edits also still set, but which this phase's
 * task 5 requires *additionally* surfacing right where the user is
 * actually editing). "Revert" (rendered alongside the diagnostics) resets
 * the textarea's text to `serializeDocument(document)` - `document` is
 * always the last value that passed `parseScene` (see `document-store.ts`'s
 * own invariant: a rejected edit never updates `document`), so this always
 * restores a genuinely valid, previously-committed state, never a guess.
 *
 * DSL-panel click-to-select (this phase's task 4, the least natural of the
 * three selection surfaces for a plain textarea): implemented exactly as
 * follows, and no further. A plain click inside the textarea (one that
 * moves the cursor, not a drag-selection) searches the text *backward* from
 * the click's own cursor offset for the nearest preceding `"id": "<value>"`
 * occurrence, extracts `<value>`, and - only if that value actually matches
 * a real node somewhere in the current `document` (checked via
 * `findSelectedClip`, the same tree walk every other selection lookup in
 * this app already uses) - calls `onSelectNode(value)`. Explicit limits:
 * this is a nearest-preceding-occurrence heuristic over the raw JSON text,
 * not a real JSON-path/AST-aware click target; it can select the "wrong"
 * node if the cursor lands inside a deeply nested value whose own `"id"`
 * key happens to be further back in the text than some sibling's (this
 * cannot actually happen for this app's own `SceneNode`/`Clip`/`Track`/
 * `Composition` shapes, since every one of those places its own `"id"` key
 * as the *first* key of its own JSON object, ahead of any nested children,
 * but a hand-edited document that reorders keys could defeat this
 * assumption); a click before the very first `"id"` occurrence in the
 * document, or one that lands inside a value with no relevant `"id"` (e.g.
 * a bare number in the middle of a `position` array), simply does not
 * select anything (a no-op, not a wrong selection). There is no true
 * click-to-select-by-JSON-path support (parsing the click position against
 * a real parsed structure to resolve exactly which JSON node/array element
 * the cursor is inside), which this phase's own spec explicitly says is not
 * required. In the other direction, when `selectedNodeId` changes from
 * elsewhere (the viewport's raycast click, or `TimelinePanel`'s clip click)
 * while this panel is not `isDirty`, this panel finds the first
 * `"id": "<selectedNodeId>"` occurrence in the *currently displayed* text
 * and selects that whole substring via the textarea's own
 * `setSelectionRange` (highlighting it, the browser's native text-selection
 * highlight) and scrolls it into view - "select and scroll to the matching
 * text", not a richer JSON-region (e.g. the whole enclosing object)
 * highlight.
 */
export function DslPanel({
  document,
  commitDslEdit,
  selectedNodeId,
  onSelectNode,
}: DslPanelProps): JSX.Element {
  const [text, setText] = useState(() => serializeDocument(document));
  const [isDirty, setIsDirty] = useState(false);
  const [parseError, setParseError] = useState<string | undefined>(undefined);
  const [validationDiagnostics, setValidationDiagnostics] = useState<
    SceneParseDiagnostic[] | undefined
  >(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Re-sync from a new document, but only while not mid-edit; see this
  // component's own doc for the full "why not diff-and-preserve-cursor"
  // reasoning.
  useEffect(() => {
    if (isDirty) {
      return;
    }
    setText(serializeDocument(document));
    // isDirty is deliberately excluded from this effect's own dependency
    // array: including it would rerun this effect (and therefore
    // re-serialize/overwrite text) the moment isDirty itself flips back to
    // false from handleApply/handleRevert below, which already set `text`
    // themselves to the exact value this effect would recompute anyway -
    // harmless in outcome, but this keeps the effect's own trigger limited
    // to "document identity changed", matching every other document-driven
    // effect in this app (Viewport's own mount effect keys on
    // [document, selectedCompositionId] for the identical reason).
    // (eslint-plugin-react-hooks is not part of this workspace's lint
    // config, so no exhaustive-deps suppression is needed here either,
    // matching Viewport.tsx's own identical note.)
  }, [document]);

  // Selection-driven highlight: only while not mid-edit (see this
  // component's own doc for why an external selection change must not move
  // the user's cursor while they are actively typing unrelated text).
  useEffect(() => {
    if (isDirty || selectedNodeId === undefined) {
      return;
    }
    const textarea = textareaRef.current;
    if (textarea === null) {
      return;
    }
    const needle = `"id": "${selectedNodeId}"`;
    const index = text.indexOf(needle);
    if (index === -1) {
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(index, index + needle.length);
    // scrollIntoView-equivalent for a textarea's own internal scroll: derive
    // an approximate line number from the number of newlines before `index`
    // and scroll proportionally. jsdom (this app's own test environment)
    // implements neither real textarea layout nor scrollHeight/clientHeight
    // meaningfully, so this is guarded to a no-op when scrollHeight reports
    // nothing usable, rather than asserted on in a test.
    const linesBefore = text.slice(0, index).split("\n").length;
    const totalLines = text.split("\n").length;
    if (textarea.scrollHeight > 0 && totalLines > 0) {
      textarea.scrollTop = (linesBefore / totalLines) * textarea.scrollHeight;
    }
    // Deliberately excludes `text`/`isDirty` from this effect's own
    // dependency array: this should only ever run in reaction to a
    // selection change, not on every keystroke (the effect body's own
    // `isDirty` guard above already covers correctness; adding it here too
    // would only make this effect rerun-and-immediately-no-op on every
    // keystroke instead of not running at all, an unnecessary difference in
    // behavior for no benefit).
  }, [selectedNodeId]);

  function handleChange(event: React.ChangeEvent<HTMLTextAreaElement>): void {
    setText(event.target.value);
    setIsDirty(true);
  }

  /** Attempts to apply the current textarea text: JSON.parse, then commitDslEdit. Sets parseError/validationDiagnostics on either failure; clears isDirty and both error states on success. */
  function applyEdit(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      setParseError(error instanceof Error ? error.message : String(error));
      setValidationDiagnostics(undefined);
      return;
    }
    const diagnostics = commitDslEdit(parsed);
    if (diagnostics !== undefined) {
      setValidationDiagnostics(diagnostics);
      setParseError(undefined);
      return;
    }
    setParseError(undefined);
    setValidationDiagnostics(undefined);
    setIsDirty(false);
  }

  /** Restores the textarea to `document`'s own serialized form (always the last-known-valid state; see this component's own doc), discarding any pending edit and its diagnostics. */
  function handleRevert(): void {
    setText(serializeDocument(document));
    setIsDirty(false);
    setParseError(undefined);
    setValidationDiagnostics(undefined);
  }

  /**
   * Bounded click-to-select: see this component's own doc for the exact
   * heuristic and its documented limits. Only ever selects (never clears
   * selection): a click that finds no matching preceding `"id"` is a no-op,
   * distinct from `Viewport`'s own click-to-deselect-on-miss behavior, since
   * a textarea click is primarily a text-editing gesture (placing a cursor
   * to type), not primarily a selection gesture the way a viewport/timeline
   * click is.
   */
  function handleTextareaClick(event: React.MouseEvent<HTMLTextAreaElement>): void {
    const textarea = event.currentTarget;
    const cursorOffset = textarea.selectionStart;
    const textBeforeCursor = text.slice(0, cursorOffset);
    const idPattern = /"id":\s*"([^"]*)"/g;
    let lastMatch: RegExpExecArray | undefined;
    for (
      let match = idPattern.exec(textBeforeCursor);
      match !== null;
      match = idPattern.exec(textBeforeCursor)
    ) {
      lastMatch = match;
    }
    if (lastMatch === undefined) {
      return;
    }
    const candidateId = lastMatch[1];
    if (candidateId === undefined || candidateId === "") {
      return;
    }
    if (findSelectedClip(document, candidateId) === undefined) {
      // Not a real node id (e.g. the cursor landed after some other
      // document's "id" field this app does not treat as a SceneNode, such
      // as project.id or a composition's own id): a no-op, not a wrong
      // selection.
      return;
    }
    onSelectNode?.(candidateId);
  }

  return (
    <div className="cadra-studio-dsl-panel" data-testid="studio-dsl-panel">
      <div className="cadra-studio-dsl-panel__toolbar">
        <span className="cadra-studio-dsl-panel__label">Document JSON</span>
        {isDirty && (
          <span
            className="cadra-studio-dsl-panel__dirty-indicator"
            data-testid="dsl-panel-dirty-indicator"
          >
            Unapplied edits
          </span>
        )}
        <button type="button" onClick={applyEdit} data-testid="dsl-panel-apply">
          Apply
        </button>
        <button
          type="button"
          onClick={handleRevert}
          disabled={!isDirty && parseError === undefined && validationDiagnostics === undefined}
          data-testid="dsl-panel-revert"
        >
          Revert
        </button>
      </div>
      <textarea
        ref={textareaRef}
        className="cadra-studio-dsl-panel__textarea"
        data-testid="dsl-panel-textarea"
        value={text}
        spellCheck={false}
        onChange={handleChange}
        onBlur={applyEdit}
        onClick={handleTextareaClick}
      />
      {parseError !== undefined && (
        <div className="cadra-studio-dsl-panel__diagnostics" data-testid="dsl-panel-parse-error">
          Invalid JSON: {parseError}
        </div>
      )}
      {validationDiagnostics !== undefined && (
        <ul
          className="cadra-studio-dsl-panel__diagnostics"
          data-testid="dsl-panel-validation-errors"
        >
          {validationDiagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.path}-${index}`}>
              {diagnostic.path}: {diagnostic.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
