/**
 * Injectable open/save persistence for a studio document, following this
 * codebase's established seam pattern for a real browser API a test
 * environment cannot exercise (see `ObserveResizeFn` in
 * `packages/player/src/preview/mount-preview.ts`'s `resize-observation.ts`,
 * and `BrowserLauncher` in `packages/headless/src/browser-launcher.ts`): a
 * narrow interface production code drives a real implementation through,
 * with a fully independent fake usable in tests that never touches the real
 * browser API at all.
 *
 * The real API here is the File System Access API
 * (`showOpenFilePicker`/`showSaveFilePicker`), which as of this writing is
 * not implemented by jsdom (Vitest's DOM test environment) or any other
 * environment a Vitest suite runs in, exactly the same gap `ResizeObserver`
 * and a real Chromium launch fill for their own packages. `save` accepts an
 * already-open `DocumentHandle` (returned by a prior `open`, or `undefined`
 * for a brand-new, never-yet-saved document) so a "save" after an "open"
 * writes back to the same file/location rather than always prompting anew,
 * the conventional desktop-app "Save" (write to the known file) versus "Save
 * As" (always prompt) distinction; this phase only needs plain "Save"
 * (prompting again is always a safe, if slightly less convenient, fallback
 * for "Save As", which is not part of this phase's scope).
 */

/**
 * Opaque handle to wherever a document was opened from or saved to, threaded
 * back into a later `save` call so it writes to the same place instead of
 * prompting again. Deliberately untyped beyond this: the real implementation
 * stashes a `FileSystemFileHandle` inside it, the fallback implementation
 * stashes nothing meaningful (every fallback save re-prompts/re-downloads
 * regardless), and a fake in tests stashes whatever it likes. Callers never
 * inspect a `DocumentHandle`'s contents, only pass it through.
 */
export type DocumentHandle = object;

/** The result of a successful `open`. */
export interface OpenDocumentResult {
  /** The raw, as-typed file contents, not yet parsed or validated. */
  contents: string;
  /** A display name for the opened document (e.g. the filename), for UI use. */
  name: string;
  /** Threaded back into a later `save` call so it writes back to this same location. */
  handle: DocumentHandle;
}

/**
 * Prompts the user to choose a file to open and returns its contents.
 * Resolves `undefined` if the user cancels the picker (not an error: a
 * cancelled open is a normal, non-exceptional outcome, matching how a
 * cancelled native "Open" dialog behaves in any desktop app).
 */
export type OpenDocumentFn = () => Promise<OpenDocumentResult | undefined>;

/** Result of a successful `save`, carrying the handle to reuse for a subsequent save. */
export interface SaveDocumentResult {
  /** A display name for the now-saved document (e.g. the filename), for UI use. */
  name: string;
  /** Threaded back into a later `save` call so it writes back to this same location. */
  handle: DocumentHandle;
}

/**
 * Persists `contents` to `handle`'s location if given (an ordinary "Save"),
 * or prompts the user to choose a save location if `handle` is `undefined`
 * (the only option for a brand-new, never-yet-saved document; equivalent to
 * "Save As" for one that already has a handle). Resolves `undefined` if the
 * user cancels a save-location prompt.
 */
export type SaveDocumentFn = (
  contents: string,
  handle: DocumentHandle | undefined,
) => Promise<SaveDocumentResult | undefined>;

/** The full injectable persistence surface a studio document store depends on. */
export interface DocumentPersistence {
  open: OpenDocumentFn;
  save: SaveDocumentFn;
}
