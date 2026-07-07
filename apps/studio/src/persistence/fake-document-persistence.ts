import type {
  DocumentHandle,
  DocumentPersistence,
  OpenDocumentResult,
} from "./document-persistence.js";

/**
 * An in-memory fake `DocumentPersistence` for tests, following this
 * codebase's established pattern for testing around a real-browser-API seam
 * (see `mount-preview.test.ts`'s fake `ObserveResizeFn`, and this package's
 * own `document-store.test.ts`): production code is handed
 * `fileSystemAccessPersistence` (the real File System Access API, with a
 * plain-input/anchor-download fallback), which no test environment
 * implements; tests instead construct one of these, seed it with
 * `seedFile`, and assert against its recorded `savedFiles` history, with
 * nothing underneath ever touching a real file picker or a real download.
 *
 * Deliberately not a fixed single in-memory "file": open/save round trips
 * across more than one distinct file are exactly what Task 6 (open, edit,
 * save round trips preserve the document) needs to exercise, so this fake
 * models a tiny named-file store instead of one hardcoded slot.
 */
export interface FakeDocumentPersistence extends DocumentPersistence {
  /** Seeds a file this fake's `open()` can return, keyed by the name a caller passes to `openNamed`. */
  seedFile(name: string, contents: string): void;
  /** Every `save()` call this fake has recorded, oldest first, for assertions. */
  readonly savedFiles: ReadonlyArray<{ name: string; contents: string }>;
  /**
   * Directs the next `open()` call to resolve with the file previously
   * seeded under `name` (or `undefined` if none was seeded, simulating a
   * cancelled picker). Consumed after one `open()` call, mirroring a real
   * picker's one-shot nature.
   */
  queueOpen(name: string | undefined): void;
}

/** Opaque handle this fake stashes on every open/save result, carrying just the file's name. */
interface FakeHandle extends DocumentHandle {
  readonly name: string;
}

function isFakeHandle(handle: DocumentHandle): handle is FakeHandle {
  return typeof handle === "object" && handle !== null && "name" in handle;
}

/** Constructs a fresh, empty `FakeDocumentPersistence`. */
export function createFakeDocumentPersistence(): FakeDocumentPersistence {
  const seededFiles = new Map<string, string>();
  const savedFiles: Array<{ name: string; contents: string }> = [];
  let queuedOpenName: string | undefined | "none-queued" = "none-queued";

  return {
    seedFile(name, contents) {
      seededFiles.set(name, contents);
    },

    savedFiles,

    queueOpen(name) {
      queuedOpenName = name;
    },

    async open(): Promise<OpenDocumentResult | undefined> {
      if (queuedOpenName === "none-queued") {
        throw new Error(
          "FakeDocumentPersistence.open() called with no queueOpen() call first; " +
            "call queueOpen(name) (or queueOpen(undefined) to simulate a cancelled picker) before open().",
        );
      }
      const name = queuedOpenName;
      queuedOpenName = "none-queued";

      if (name === undefined) {
        return undefined;
      }
      const contents = seededFiles.get(name);
      if (contents === undefined) {
        throw new Error(`FakeDocumentPersistence.open(): no file seeded under name "${name}".`);
      }
      const handle: FakeHandle = { name };
      return { contents, name, handle };
    },

    async save(contents, handle) {
      const name =
        handle !== undefined && isFakeHandle(handle) ? handle.name : "untitled.cadra.json";
      savedFiles.push({ name, contents });
      // Keep this fake's own "seeded files" store in sync too, so a
      // subsequent open() of the same name (simulating "open the file we
      // just saved") sees the latest saved contents rather than whatever
      // was seeded initially.
      seededFiles.set(name, contents);
      const newHandle: FakeHandle = { name };
      return { name, handle: newHandle };
    },
  };
}
