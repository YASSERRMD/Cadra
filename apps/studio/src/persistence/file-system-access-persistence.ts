import type {
  DocumentHandle,
  DocumentPersistence,
  OpenDocumentResult,
  SaveDocumentResult,
} from "./document-persistence.js";

/**
 * The real `DocumentPersistence`: the File System Access API
 * (`showOpenFilePicker`/`showSaveFilePicker`) where the browser implements
 * it, falling back to a hidden `<input type="file">` for open and an
 * anchor-tag download for save where it does not (Firefox and Safari, as of
 * this writing, implement neither picker method).
 *
 * The fallback trades away a few conveniences a full polyfill could
 * recover (a browser-native "Save"-writes-back-to-the-same-file experience,
 * a remembered starting directory, a matching native-styled dialog): a
 * fallback "save" always downloads a new file via the browser's ordinary
 * download UI (there is no way for page script to silently overwrite an
 * arbitrary file on disk without the picker API) rather than truly writing
 * back to whatever the document was opened from, and a fallback "open"
 * cannot offer a remembered directory or file-type-aware icons the way a
 * native picker does. Both are still fully functional for this phase's
 * actual requirement (open a `.json` DSL document, edit it, save it back
 * out), and neither fallback path is reachable from this package's own test
 * suite: `createDocumentStore`'s tests always inject a fake
 * `DocumentPersistence` (see `document-persistence.fake.ts`), never this
 * module, matching this codebase's established browser-API seam pattern
 * (`ObserveResizeFn`, `BrowserLauncher`).
 */

/** MIME type and extension for a Cadra scene document, shared by every code path below. */
const DOCUMENT_MIME_TYPE = "application/json";
const DOCUMENT_EXTENSION = ".cadra.json";
const DEFAULT_SUGGESTED_NAME = "untitled.cadra.json";

/** The subset of `window` this module touches, narrowed for readability at each call site. */
function hasFileSystemAccessApi(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker ===
      "function" &&
    typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function"
  );
}

/**
 * A real `FileSystemFileHandle` (from either picker) wrapped so
 * `DocumentPersistence`'s `handle` stays the opaque `DocumentHandle` type
 * callers cannot inspect, while this module can still recover the real
 * handle back out on a later `save`.
 */
interface FileSystemHandleHolder extends DocumentHandle {
  readonly fileHandle: FileSystemFileHandle;
}

function isFileSystemHandleHolder(handle: DocumentHandle): handle is FileSystemHandleHolder {
  return (
    typeof handle === "object" &&
    handle !== null &&
    "fileHandle" in handle &&
    typeof (handle as { fileHandle?: unknown }).fileHandle === "object"
  );
}

/** Opens via the real File System Access API's `showOpenFilePicker`. */
async function openWithFilePicker(): Promise<OpenDocumentResult | undefined> {
  let fileHandles: FileSystemFileHandle[];
  try {
    fileHandles = await window.showOpenFilePicker({
      types: [
        {
          description: "Cadra scene document",
          accept: { [DOCUMENT_MIME_TYPE]: [".json", DOCUMENT_EXTENSION] },
        },
      ],
      excludeAcceptAllOption: false,
      multiple: false,
    });
  } catch (error) {
    // AbortError is the picker's own signal for "the user cancelled",
    // resolved as `undefined` (see this module's own doc); any other error
    // (e.g. a permissions failure) is a genuine failure the caller should
    // see.
    if (error instanceof DOMException && error.name === "AbortError") {
      return undefined;
    }
    throw error;
  }

  const fileHandle = fileHandles[0];
  if (fileHandle === undefined) {
    return undefined;
  }
  const file = await fileHandle.getFile();
  const contents = await file.text();
  const holder: FileSystemHandleHolder = { fileHandle };
  return { contents, name: file.name, handle: holder };
}

/** Saves via the real File System Access API, reusing `existingFileHandle` if given, else prompting via `showSaveFilePicker`. */
async function saveWithFilePicker(
  contents: string,
  existingFileHandle: FileSystemFileHandle | undefined,
): Promise<SaveDocumentResult | undefined> {
  let fileHandle = existingFileHandle;
  if (fileHandle === undefined) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: DEFAULT_SUGGESTED_NAME,
        types: [
          {
            description: "Cadra scene document",
            accept: { [DOCUMENT_MIME_TYPE]: [".json", DOCUMENT_EXTENSION] },
          },
        ],
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return undefined;
      }
      throw error;
    }
  }

  const writable = await fileHandle.createWritable();
  await writable.write(contents);
  await writable.close();

  const holder: FileSystemHandleHolder = { fileHandle };
  return { name: fileHandle.name, handle: holder };
}

/**
 * Opens via the fallback path: a hidden `<input type="file">` clicked
 * programmatically. Resolves `undefined` if the user dismisses the native
 * file dialog without choosing a file (the `<input>`'s own `cancel` event,
 * broadly supported in browsers lacking the File System Access API), same
 * "cancel is not an error" contract as the real picker path.
 */
async function openWithFileInput(): Promise<OpenDocumentResult | undefined> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${DOCUMENT_MIME_TYPE},.json,${DOCUMENT_EXTENSION}`;
    input.style.display = "none";

    function cleanUp(): void {
      input.removeEventListener("change", handleChange);
      input.removeEventListener("cancel", handleCancel);
      input.remove();
    }

    function handleChange(): void {
      const file = input.files?.[0];
      cleanUp();
      if (file === undefined) {
        resolve(undefined);
        return;
      }
      file
        .text()
        .then((contents) => resolve({ contents, name: file.name, handle: {} }))
        .catch(reject);
    }

    function handleCancel(): void {
      cleanUp();
      resolve(undefined);
    }

    input.addEventListener("change", handleChange);
    input.addEventListener("cancel", handleCancel);
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Saves via the fallback path: an anchor tag with a `Blob` object URL and a
 * `download` attribute, clicked programmatically to trigger the browser's
 * ordinary download UI. Always "downloads a new file" rather than truly
 * overwriting whatever the document was opened from (see this module's own
 * doc for why); `handle` is accepted for interface conformance but never
 * consulted, and the returned handle carries nothing meaningful either,
 * since there is nothing further a subsequent fallback save could reuse.
 */
async function saveWithAnchorDownload(contents: string): Promise<SaveDocumentResult | undefined> {
  const blob = new Blob([contents], { type: DOCUMENT_MIME_TYPE });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = DEFAULT_SUGGESTED_NAME;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return { name: DEFAULT_SUGGESTED_NAME, handle: {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The real, production `DocumentPersistence`. Selects the File System
 * Access API when the browser implements it, falling back to a plain
 * `<input type="file">`/anchor-download otherwise, decided fresh on every
 * call (rather than once at module load) so a single build behaves
 * correctly across every target browser without a separate build per
 * browser.
 */
export const fileSystemAccessPersistence: DocumentPersistence = {
  async open() {
    if (hasFileSystemAccessApi()) {
      return openWithFilePicker();
    }
    return openWithFileInput();
  },
  async save(contents, handle) {
    if (hasFileSystemAccessApi()) {
      const existingFileHandle =
        handle !== undefined && isFileSystemHandleHolder(handle) ? handle.fileHandle : undefined;
      return saveWithFilePicker(contents, existingFileHandle);
    }
    return saveWithAnchorDownload(contents);
  },
};
