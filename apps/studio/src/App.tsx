import type { ObserveResizeFn, PreviewHandle } from "@cadra/player";
import type { SceneParseDiagnostic } from "@cadra/schema";
import type { JSX } from "react";
import { useState } from "react";

import { AssetPanel } from "./components/AssetPanel.js";
import { DslPanel } from "./components/DslPanel.js";
import { InspectorPanel } from "./components/InspectorPanel.js";
import { TimelinePanel } from "./components/TimelinePanel.js";
import { Toolbar } from "./components/Toolbar.js";
import type { CreateRendererFn } from "./components/Viewport.js";
import { Viewport } from "./components/Viewport.js";
import { useDocumentStore } from "./store/document-store.js";

/** Props for `App`. Every field is optional; production (`main.tsx`) renders `<App />` with no props at all. */
export interface AppProps {
  /**
   * The document store hook to read from. Defaults to the real, module-level
   * `useDocumentStore` (backed by the real `fileSystemAccessPersistence`).
   * Injectable so `App.test.tsx` can render against a store built from
   * `createDocumentStore(createFakeDocumentPersistence())` instead, never
   * exercising a real file picker from a rendered `App`.
   */
  useStore?: typeof useDocumentStore;
  /** Forwarded to `Viewport`; see that component's own doc for why this is injectable. */
  createRenderer?: CreateRendererFn;
  /** Forwarded to `Viewport`; see that component's own doc for why this is injectable. */
  observeResize?: ObserveResizeFn;
}

/**
 * The studio shell layout: a top toolbar, then a body split into a left
 * asset sidebar, a center column (viewport above, full-width timeline
 * below), and a right inspector sidebar.
 *
 * This arrangement follows this phase's own design grounding rather than
 * inventing a novel layout: real video/animation editors (Runway, Canva,
 * VEED, TikTok Studio, Vidyard) consistently put the preview/viewport in the
 * main central area (usually upper), a full-width timeline along the
 * bottom, a media/asset panel in a left sidebar, and tool/property
 * (inspector) panels in a right sidebar.
 *
 * Shared preview handle (Phase 38): `App` is where `Viewport`'s
 * `PreviewHandle` (see that component's own doc for why it can no longer
 * stay entirely private to `Viewport`) is lifted into a plain `useState`,
 * via `Viewport`'s `onHandleChange` callback, and passed down to
 * `TimelinePanel` as a prop. This is a small, explicit "lift state up to the
 * nearest common ancestor and pass it down as props" - the same
 * store-reading/prop-passing style already used for every other piece of
 * state this component threads to its children - rather than a new React
 * context, since there is exactly one consumer pair (`Viewport`,
 * `TimelinePanel`) and no deeper prop-drilling problem a context would
 * actually solve here.
 *
 * Node selection (Phase 39): `selectedNodeId` (the store's new, previously
 * nonexistent concept of "the selected node") and `previewHandle` are both
 * passed to `InspectorPanel` alongside `commitDocument`, following the exact
 * same pattern - the store's `selectNode` action is passed to `TimelinePanel`
 * as `onSelectNode`, so clicking a clip there is what actually sets it (see
 * that component's own doc), and `InspectorPanel` only ever reads the
 * resulting id back out of the store, never sets it itself.
 *
 * Unified selection and code round trip (Phase 40): the same `selectedNodeId`/
 * `selectNode` pair is now also threaded to `Viewport` (its own raycast
 * click-to-select calls `selectNode` via `onSelectNode`, and it reads
 * `selectedNodeId` back to know which node to attach a transform gizmo to)
 * and to the new `DslPanel` (its own bounded textarea-click-to-select also
 * calls `selectNode`, and it reads `selectedNodeId` back for its own
 * selection-driven highlight). Since `Viewport`, `TimelinePanel`, and
 * `DslPanel` all read the exact same store field and all funnel their edits
 * through the exact same `commitDocument` (`Viewport`'s gizmo drags directly;
 * `DslPanel`'s manual edits via `commitDslEdit`, below, the identical
 * "commit and read back diagnostics on failure" shape `commitPropertyEdit`
 * already established for `InspectorPanel`), there is exactly one selection
 * and exactly one document for all three surfaces to ever disagree about -
 * this phase adds no second synchronization mechanism, only more readers/
 * writers of the one that already existed.
 */
export function App({
  useStore = useDocumentStore,
  createRenderer,
  observeResize,
}: AppProps = {}): JSX.Element {
  const document = useStore((state) => state.document);
  const selectedCompositionId = useStore((state) => state.selectedCompositionId);
  const selectedNodeId = useStore((state) => state.selectedNodeId);
  const provenance = useStore((state) => state.provenance);
  const isPersistenceBusy = useStore((state) => state.isPersistenceBusy);
  const lastPersistenceError = useStore((state) => state.lastPersistenceError);
  const lastValidationError = useStore((state) => state.lastValidationError);
  const newDocument = useStore((state) => state.newDocument);
  const openDocument = useStore((state) => state.openDocument);
  const saveDocument = useStore((state) => state.saveDocument);
  const commitDocument = useStore((state) => state.commitDocument);
  const undo = useStore((state) => state.undo);
  const redo = useStore((state) => state.redo);
  const selectNode = useStore((state) => state.selectNode);

  const [previewHandle, setPreviewHandle] = useState<PreviewHandle | undefined>(undefined);

  /**
   * A `commitDocument` wrapper that also reports the rejected edit's own
   * diagnostics back to the caller, for `InspectorPanel`'s inline
   * per-field diagnostics (Phase 39's task 5). `commitDocument`'s own store
   * action already sets `lastValidationError` synchronously (a zustand
   * `set` call resolves before it returns), so reading it via
   * `useStore.getState()` immediately after calling `commitDocument` here
   * always reflects this exact attempt's outcome, not a stale value from
   * some earlier attempt or a value that has not "caught up" yet through a
   * subscription. `useStore.getState()` (a zustand store hook's own static
   * accessor, distinct from the reactive `useStore(selector)` calls above)
   * works identically whether `useStore` is the real, production hook or
   * `App.test.tsx`'s injected fake-persistence-backed one, since both are
   * real zustand stores from `createDocumentStore`.
   */
  function commitPropertyEdit(candidate: unknown): SceneParseDiagnostic[] | undefined {
    const committed = commitDocument(candidate);
    return committed ? undefined : useStore.getState().lastValidationError;
  }

  /**
   * `DslPanel`'s own commit path: byte-identical logic to
   * `commitPropertyEdit` above (same synchronous-`lastValidationError`-
   * readback reasoning applies verbatim), kept as its own named function
   * rather than reusing `commitPropertyEdit` directly under a second prop
   * name, so each panel's own prop name stays self-documenting about which
   * edit surface produced a given candidate, without actually duplicating
   * any commit logic.
   */
  function commitDslEdit(candidate: unknown): SceneParseDiagnostic[] | undefined {
    const committed = commitDocument(candidate);
    return committed ? undefined : useStore.getState().lastValidationError;
  }

  return (
    <div className="cadra-studio-shell">
      <Toolbar
        documentName={provenance.name}
        isPersistenceBusy={isPersistenceBusy}
        lastPersistenceError={lastPersistenceError}
        lastValidationError={lastValidationError}
        onNew={newDocument}
        onOpen={() => void openDocument()}
        onSave={() => void saveDocument()}
      />
      <div className="cadra-studio-body">
        <AssetPanel />
        <div className="cadra-studio-center">
          <Viewport
            document={document}
            selectedCompositionId={selectedCompositionId}
            onHandleChange={setPreviewHandle}
            selectedNodeId={selectedNodeId}
            onSelectNode={selectNode}
            commitDocument={commitDocument}
            {...(createRenderer !== undefined && { createRenderer })}
            {...(observeResize !== undefined && { observeResize })}
          />
          <TimelinePanel
            document={document}
            selectedCompositionId={selectedCompositionId}
            commitDocument={commitDocument}
            previewHandle={previewHandle}
            onUndo={undo}
            onRedo={redo}
            selectedNodeId={selectedNodeId}
            onSelectNode={selectNode}
          />
        </div>
        <InspectorPanel
          document={document}
          selectedNodeId={selectedNodeId}
          previewHandle={previewHandle}
          commitPropertyEdit={commitPropertyEdit}
        />
        <DslPanel
          document={document}
          commitDslEdit={commitDslEdit}
          selectedNodeId={selectedNodeId}
          onSelectNode={selectNode}
        />
      </div>
    </div>
  );
}
