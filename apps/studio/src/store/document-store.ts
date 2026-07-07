import { createComposition, createProject } from "@cadra/core";
import type { SceneDocument, SceneParseDiagnostic } from "@cadra/schema";
import { CURRENT_SCHEMA_VERSION, parseScene } from "@cadra/schema";
import { create } from "zustand";

import type { DocumentHandle, DocumentPersistence } from "../persistence/document-persistence.js";
import { fileSystemAccessPersistence } from "../persistence/file-system-access-persistence.js";

/**
 * The studio's central state store: the current, always-schema-valid
 * `SceneDocument` (Phase 4's DSL envelope), plus the UI-only state layered
 * on top of it (which composition is selected, the open/save persistence
 * handle and display name, and the outcome of the most recent attempted
 * edit).
 *
 * Every mutation to `document` is required to go through `commitDocument`
 * (directly, or via one of the higher-level actions below that all funnel
 * through it: `newDocument`, `openDocument`, and any future "apply this edit"
 * action a later phase adds), which runs the candidate through
 * `parseScene` before ever assigning it to `document`. An edit that would
 * produce an invalid document is rejected outright: `document` stays at its
 * last-known-valid value, and `lastValidationError` is populated with the
 * rejected edit's diagnostics for the UI to surface (no diagnostic UI exists
 * yet this phase; the store field alone satisfies this phase's acceptance
 * criterion that a store consumer *could* surface them). This is what
 * guarantees this phase's "every store state validates against the schema"
 * acceptance criterion: there is no code path that assigns to `document`
 * other than `commitDocument`'s own success branch.
 */

/** A studio document's persistence provenance: never saved yet, or saved/opened via some `DocumentHandle`. */
export interface DocumentProvenance {
  /** Display name shown in the UI (e.g. a filename), or a fixed placeholder for a brand-new, unsaved document. */
  name: string;
  /** Opaque handle passed back into `DocumentPersistence.save` so a subsequent save writes back to the same place; `undefined` for a document never yet saved or opened. */
  handle: DocumentHandle | undefined;
}

export interface DocumentStoreState {
  /** The current scene document. Always the last value that passed `parseScene`; see this module's own doc. */
  document: SceneDocument;
  /** Which of `document.project.compositions` is currently selected/previewed. */
  selectedCompositionId: string;
  /** This document's persistence provenance (display name and save handle). */
  provenance: DocumentProvenance;
  /**
   * Diagnostics from the most recently *rejected* edit attempt (an edit
   * that failed `parseScene` and was therefore not committed), or
   * `undefined` if the last attempted edit succeeded (or no edit has been
   * attempted yet this session). Cleared back to `undefined` on the next
   * successful commit, so this always reflects only the outcome of the
   * single most recent attempt, never a stale error from several edits ago.
   */
  lastValidationError: SceneParseDiagnostic[] | undefined;
  /** True while an `openDocument`/`saveDocument` call is in flight. */
  isPersistenceBusy: boolean;
  /**
   * Set when `openDocument` or `saveDocument` itself fails (a real error,
   * e.g. the opened file's contents were not even valid JSON, distinct from
   * `lastValidationError`, which is about a rejected *edit*), or `undefined`
   * otherwise. Cleared at the start of every new `openDocument`/
   * `saveDocument` call.
   */
  lastPersistenceError: string | undefined;

  /**
   * Attempts to replace `document` with `candidate`, running it through
   * `parseScene` first. Returns `true` and commits on success (also
   * resetting `selectedCompositionId` to `candidate`'s first composition if
   * the currently selected id no longer exists in it); returns `false` and
   * leaves `document`/`selectedCompositionId` untouched on failure, only
   * updating `lastValidationError`. This is the single funnel every other
   * mutating action below goes through; a later phase's "apply this
   * property edit" action should call this too, not assign to `document`
   * any other way.
   */
  commitDocument(candidate: unknown): boolean;
  /** Selects a different composition to preview, if `compositionId` exists in the current document. No-op (does not throw) otherwise. */
  selectComposition(compositionId: string): void;
  /** Resets to a small, fresh, valid starting document: one empty composition. Always succeeds (its own output always passes `parseScene`). */
  newDocument(): void;
  /** Opens a document via `persistence.open()`. No-op if the user cancels the picker. Rejects (via `lastValidationError`) and does not commit if the opened file's contents fail `parseScene`; sets `lastPersistenceError` if reading the file itself fails (e.g. invalid JSON). */
  openDocument(): Promise<void>;
  /** Saves the current `document` via `persistence.save()`, reusing `provenance.handle` if set. No-op if the user cancels a save-location prompt. */
  saveDocument(): Promise<void>;
}

/** Frame rate, duration, and pixel size for the single composition a brand-new document starts with. */
const NEW_DOCUMENT_DEFAULTS = {
  fps: 30,
  durationInFrames: 150,
  width: 1920,
  height: 1080,
} as const;

/** Builds the small, valid starting document `newDocument` resets to: one project, one empty composition. */
function buildFreshDocument(): SceneDocument {
  const composition = createComposition({
    id: "composition-1",
    name: "Composition 1",
    fps: NEW_DOCUMENT_DEFAULTS.fps,
    durationInFrames: NEW_DOCUMENT_DEFAULTS.durationInFrames,
    width: NEW_DOCUMENT_DEFAULTS.width,
    height: NEW_DOCUMENT_DEFAULTS.height,
  });
  const project = createProject({
    id: "project-1",
    name: "Untitled Project",
    compositions: [composition],
  });
  return { schemaVersion: CURRENT_SCHEMA_VERSION, project };
}

/** Display name a brand-new, never-yet-saved document shows in the UI. */
const UNTITLED_DOCUMENT_NAME = "Untitled";

/**
 * Constructs the studio document store. `persistence` is injectable
 * (defaulting to the real `fileSystemAccessPersistence`) purely so tests can
 * supply `createFakeDocumentPersistence()` instead, exactly this codebase's
 * established real-vs-fake seam pattern; production code (`main.tsx`) never
 * passes this argument at all.
 */
export function createDocumentStore(
  persistence: DocumentPersistence = fileSystemAccessPersistence,
) {
  const initialDocument = buildFreshDocument();

  return create<DocumentStoreState>((set, get) => ({
    document: initialDocument,
    selectedCompositionId: initialDocument.project.compositions[0]?.id ?? "",
    provenance: { name: UNTITLED_DOCUMENT_NAME, handle: undefined },
    lastValidationError: undefined,
    isPersistenceBusy: false,
    lastPersistenceError: undefined,

    commitDocument(candidate) {
      const result = parseScene(candidate);
      if (!result.success) {
        set({ lastValidationError: result.diagnostics });
        return false;
      }

      const { selectedCompositionId } = get();
      const stillSelected = result.document.project.compositions.some(
        (composition) => composition.id === selectedCompositionId,
      );
      set({
        document: result.document,
        selectedCompositionId: stillSelected
          ? selectedCompositionId
          : (result.document.project.compositions[0]?.id ?? ""),
        lastValidationError: undefined,
      });
      return true;
    },

    selectComposition(compositionId) {
      const exists = get().document.project.compositions.some(
        (composition) => composition.id === compositionId,
      );
      if (!exists) {
        return;
      }
      set({ selectedCompositionId: compositionId });
    },

    newDocument() {
      const fresh = buildFreshDocument();
      // buildFreshDocument's own output always passes parseScene (it is
      // built entirely from createProject/createComposition, the same
      // factories every valid document in this codebase is built from), so
      // commitDocument here can only ever take its success branch; routing
      // through it anyway (rather than assigning `document` directly) keeps
      // this action honest with the "every write to `document` goes through
      // commitDocument" invariant this store's own doc states, with no
      // special-cased exception for this one call site.
      get().commitDocument(fresh);
      set({ provenance: { name: UNTITLED_DOCUMENT_NAME, handle: undefined } });
    },

    async openDocument() {
      set({ isPersistenceBusy: true, lastPersistenceError: undefined });
      try {
        const opened = await persistence.open();
        if (opened === undefined) {
          // Cancelled picker: not an error, nothing to do.
          return;
        }

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(opened.contents);
        } catch (error) {
          set({
            lastPersistenceError: `The opened file is not valid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          return;
        }

        const committed = get().commitDocument(parsedJson);
        if (!committed) {
          set({
            lastPersistenceError:
              "The opened file's contents did not pass scene schema validation; see lastValidationError for details.",
          });
          return;
        }

        set({ provenance: { name: opened.name, handle: opened.handle } });
      } finally {
        set({ isPersistenceBusy: false });
      }
    },

    async saveDocument() {
      set({ isPersistenceBusy: true, lastPersistenceError: undefined });
      try {
        const { document, provenance } = get();
        const serialized = JSON.stringify(document, null, 2);
        const saved = await persistence.save(serialized, provenance.handle);
        if (saved === undefined) {
          // Cancelled save-location prompt: not an error, nothing to do.
          return;
        }
        set({ provenance: { name: saved.name, handle: saved.handle } });
      } catch (error) {
        set({
          lastPersistenceError: `Save failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        set({ isPersistenceBusy: false });
      }
    },
  }));
}

/** The real, app-wide document store, backed by the real `fileSystemAccessPersistence`. */
export const useDocumentStore = createDocumentStore();
