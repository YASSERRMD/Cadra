import type { ObserveResizeFn, PreviewHandle } from "@cadra/player";
import type { JSX } from "react";
import { useState } from "react";

import { AssetPanel } from "./components/AssetPanel.js";
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
 */
export function App({
  useStore = useDocumentStore,
  createRenderer,
  observeResize,
}: AppProps = {}): JSX.Element {
  const document = useStore((state) => state.document);
  const selectedCompositionId = useStore((state) => state.selectedCompositionId);
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

  const [previewHandle, setPreviewHandle] = useState<PreviewHandle | undefined>(undefined);

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
          />
        </div>
        <InspectorPanel />
      </div>
    </div>
  );
}
