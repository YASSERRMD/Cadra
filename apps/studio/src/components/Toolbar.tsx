import type { JSX } from "react";

import type { DocumentStoreState } from "../store/document-store.js";

/** Props for `Toolbar`: the store slices and actions needed for new/open/save plus status display. */
export interface ToolbarProps {
  documentName: string;
  isPersistenceBusy: boolean;
  lastPersistenceError: string | undefined;
  lastValidationError: DocumentStoreState["lastValidationError"];
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
}

/**
 * Top toolbar: new/open/save actions plus a minimal status readout for
 * persistence and validation failures. No dedicated diagnostics UI exists
 * yet this phase (a later phase builds one against
 * `DocumentStoreState.lastValidationError`'s full `SceneParseDiagnostic[]`
 * shape); this just proves the store's error state is something a
 * component *can* surface, satisfying this phase's own "no need to build
 * real diagnostic UI yet" scope note.
 */
export function Toolbar({
  documentName,
  isPersistenceBusy,
  lastPersistenceError,
  lastValidationError,
  onNew,
  onOpen,
  onSave,
}: ToolbarProps): JSX.Element {
  return (
    <div className="cadra-studio-toolbar" data-testid="studio-toolbar">
      <span className="cadra-studio-toolbar__document-name">{documentName}</span>
      <button type="button" onClick={onNew} disabled={isPersistenceBusy}>
        New
      </button>
      <button type="button" onClick={onOpen} disabled={isPersistenceBusy}>
        Open
      </button>
      <button type="button" onClick={onSave} disabled={isPersistenceBusy}>
        Save
      </button>
      {lastPersistenceError !== undefined && (
        <span className="cadra-studio-toolbar__error" data-testid="studio-persistence-error">
          {lastPersistenceError}
        </span>
      )}
      {lastValidationError !== undefined && (
        <span className="cadra-studio-toolbar__error" data-testid="studio-validation-error">
          {lastValidationError.length} validation issue(s) rejected the last edit.
        </span>
      )}
    </div>
  );
}
