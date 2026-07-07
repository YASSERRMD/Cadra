/**
 * Ambient type declarations for the File System Access API's global entry
 * points (`showOpenFilePicker`/`showSaveFilePicker`), which this
 * TypeScript version's bundled `lib.dom.d.ts` does not yet declare (it does
 * already declare the handle-side interfaces these return, e.g.
 * `FileSystemFileHandle`, `FileSystemWritableFileStream`): these two
 * `Window` methods are a de facto Chromium-only web platform feature that
 * has not (yet, as of this TypeScript release) landed in the official DOM
 * IDL TypeScript ships from. Kept minimal: only the members
 * `file-system-access-persistence.ts` actually calls.
 */

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string | string[]>;
}

interface FilePickerOptions {
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
}

interface OpenFilePickerOptions extends FilePickerOptions {
  multiple?: boolean;
}

interface SaveFilePickerOptions extends FilePickerOptions {
  suggestedName?: string;
}

interface Window {
  showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}
