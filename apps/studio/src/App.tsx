import type { ObserveResizeFn } from "@cadra/player";
import type { JSX } from "react";

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
            {...(createRenderer !== undefined && { createRenderer })}
            {...(observeResize !== undefined && { observeResize })}
          />
          <TimelinePanel />
        </div>
        <InspectorPanel />
      </div>
    </div>
  );
}
