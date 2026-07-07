import type { ObserveResizeFn } from "@cadra/player";
import { mountPreview } from "@cadra/player";
import type { Renderer } from "@cadra/renderer";
import { createRenderer as createRealRenderer } from "@cadra/renderer";
import type { JSX } from "react";
import { useEffect, useRef } from "react";

import type { DocumentStoreState } from "../store/document-store.js";

/** Constructs a `Renderer`, matching `@cadra/renderer`'s own `createRenderer()` signature. */
export type CreateRendererFn = () => Renderer;

/** Props for `Viewport`: exactly the slice of store state the preview needs. */
export interface ViewportProps {
  document: DocumentStoreState["document"];
  selectedCompositionId: string;
  /**
   * Constructs the `Renderer` handed to `mountPreview`. Defaults to
   * `@cadra/renderer`'s real `createRenderer` (WebGPU falling back to
   * WebGL2). Injectable for the same reason `mountPreview`'s own
   * `observeResize` option is: a real `Renderer` construction reaches into
   * real WebGPU/WebGL2 canvas contexts no DOM test environment (jsdom, in
   * this package's own Vitest suite) implements, so `Viewport.test.tsx`
   * supplies a fake `Renderer` here instead, never exercising real Three.js
   * or a real GPU context, matching this codebase's established
   * `ObserveResizeFn`/`BrowserLauncher` seam pattern.
   */
  createRenderer?: CreateRendererFn;
  /**
   * Forwarded directly to `mountPreview`'s own `observeResize` option
   * (defaulting to the same real `ResizeObserver`-backed implementation
   * `mountPreview` itself defaults to). Exposed here for exactly the same
   * reason `createRenderer` is: jsdom implements no `ResizeObserver` at
   * all, so `Viewport.test.tsx` must override this to something that never
   * touches one.
   */
  observeResize?: ObserveResizeFn;
}

/**
 * Embeds Phase 14's `mountPreview` (a framework-agnostic, purely-imperative
 * widget: it builds its own canvas/controls DOM inside a container element
 * and manages a `Transport`/`Renderer` internally) as a React component,
 * following the idiomatic wrapping pattern for this kind of widget: a
 * `container` held via `useRef`, `mountPreview` called inside a `useEffect`
 * on mount, and the returned handle's `dispose()` called in that effect's
 * cleanup.
 *
 * Remount-on-edit design decision: this effect is keyed on
 * `[document, selectedCompositionId]`, so *any* change to either (a brand
 * new document from `newDocument`/`openDocument`, or switching which
 * composition is selected) tears down the previous `PreviewHandle` and
 * mounts a fresh one against the new `project`/`compositionId`, rather than
 * trying to push the edit into the already-mounted preview some cheaper
 * way. `mountPreview` has no "update the project it is showing" method, only
 * full construct/dispose, so *some* remount is unavoidable for a change of
 * this shape regardless; the real choice this phase actually faces is
 * "remount on every `document` change" versus "diff the change and only
 * remount when the diff is structural (e.g. a track/clip added or removed)
 * versus leave the mounted preview running and push a fine-grained property
 * tweak into it some other way".
 *
 * This phase deliberately takes the simpler "remount on every `document`
 * change" option, for two reasons specific to where the codebase actually is
 * right now, not because it is the only defensible choice in general:
 *
 * 1. The inspector/timeline/asset panels are still stubs this phase (Phases
 *    38/39/40 build their real contents), so nothing in this phase's UI
 *    actually produces fine-grained, high-frequency edits (e.g. dragging a
 *    property slider) that a full remount-per-keystroke would make janky.
 *    Every edit `document` can currently undergo (`newDocument`,
 *    `openDocument`) is already a wholesale document replacement in
 *    substance, not a small tweak, so "remount fully" and "the cheapest
 *    correct update" happen to coincide exactly for every edit this phase's
 *    UI can actually perform.
 * 2. `document` changing identity is `commitDocument`'s own success signal
 *    (see `document-store.ts`): it only ever replaces `document` with a
 *    *freshly `parseScene`-validated* object, never mutates the existing one
 *    in place. So this effect's dependency array is also exactly "did the
 *    store just commit a new valid document", with no separate change-
 *    tracking of its own needed.
 *
 * This is a real architectural tradeoff, not a solved problem elsewhere in
 * this codebase: once a later phase's inspector starts pushing frequent,
 * fine-grained property edits through `commitDocument` (e.g. live-dragging a
 * transform value), remounting the whole preview (tearing down and
 * reinitializing the renderer, which for WebGPU is asynchronous) on every
 * single intermediate value would be visibly worse than pushing the edit
 * into the still-mounted `Transport`/`Renderer` some more targeted way. That
 * is an explicit non-goal of this phase, deferred to whichever future phase
 * first adds a genuinely interactive, high-frequency property editor.
 */
export function Viewport({
  document,
  selectedCompositionId,
  createRenderer = createRealRenderer,
  observeResize,
}: ViewportProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return undefined;
    }

    const composition = document.project.compositions.find(
      (candidate) => candidate.id === selectedCompositionId,
    );
    if (composition === undefined) {
      // No composition to preview yet (e.g. a document with zero
      // compositions); nothing to mount.
      return undefined;
    }

    const renderer = createRenderer();
    const handle = mountPreview(container, {
      project: document.project,
      compositionId: selectedCompositionId,
      renderer,
      ...(observeResize !== undefined && { observeResize }),
    });

    return () => {
      handle.dispose();
    };
    // Deliberately not depending on `createRenderer`/`observeResize`
    // themselves: this effect's remount trigger is exactly
    // `[document, selectedCompositionId]` per this component's own doc
    // above, and both are fixed construction dependencies (the real
    // implementations in production, fixed fakes in tests), never
    // something that changes across a component's own lifetime the way
    // `document`/`selectedCompositionId` do. (eslint-plugin-react-hooks is
    // not part of this workspace's lint config, so no exhaustive-deps
    // suppression is needed here either.)
  }, [document, selectedCompositionId]);

  return <div className="cadra-studio-viewport" data-testid="studio-viewport" ref={containerRef} />;
}
