import type { Transform } from "@cadra/core";
import type { ObserveResizeFn, PreviewHandle } from "@cadra/player";
import { mountPreview } from "@cadra/player";
import type { CreateRendererOptions, Renderer } from "@cadra/renderer";
import {
  attachTransformGizmo,
  createRenderer as createRealRenderer,
  pickNodeAtPoint,
} from "@cadra/renderer";
import type { JSX } from "react";
import { useEffect, useRef } from "react";

import { buildPreviewRegistries, type BuildPreviewRegistriesFn } from "../preview-assets/build-preview-registries.js";
import { commitNodeTransform } from "../store/document-edits.js";
import type { DocumentStoreState } from "../store/document-store.js";

/** Constructs a `Renderer`, matching `@cadra/renderer`'s own `createRenderer()` signature. */
export type CreateRendererFn = (options?: CreateRendererOptions) => Renderer;

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
  /**
   * Builds the registries/resolvers (`createRenderer`'s own
   * `textureRegistry`/`videoFrameRegistry`/etc., `mountPreview`'s own
   * `resolveAudioBuffer`/`decodeVideoFrame`) that let this viewport render
   * real asset content instead of each node kind's documented placeholder.
   * Defaults to `../preview-assets/build-preview-registries.js`'s own real
   * `buildPreviewRegistries` (fetches bytes from a locally running Cadra MCP
   * server's `GET /assets` endpoint). Injectable for the same reason
   * `createRenderer` is: a real implementation touches `fetch`/`AudioContext`/
   * `document.createElement("video")`, none of which `Viewport.test.tsx`
   * wants a rendered `Viewport` to actually reach for - though in practice
   * every existing test's own asset-free fixture document already resolves
   * the real default synchronously with no such call ever made (see that
   * module's own doc), so overriding this is only needed for a test that
   * specifically exercises asset loading itself.
   */
  buildPreviewRegistries?: BuildPreviewRegistriesFn;
  /**
   * Called with the live `PreviewHandle` right after `Viewport` constructs
   * it, and again with `undefined` during that same effect's cleanup (before
   * `handle.dispose()` runs, so a consumer never sees a handle it has
   * already been told is gone).
   *
   * This is how `Viewport` (the only component with a mounted DOM container
   * to construct `mountPreview` against) shares its one real `PreviewHandle`
   * upward, so a sibling (`TimelinePanel`, via `App.tsx`) can drive/observe
   * the *same* live transport instead of each owning an independent one.
   * See `App.tsx` for how the two are wired together through this callback.
   */
  onHandleChange?: (handle: PreviewHandle | undefined) => void;
  /**
   * Which `SceneNode` (by id) is currently selected, or `undefined` if
   * nothing is. Drives which node (if any) `Viewport` attaches a transform
   * gizmo to. Set via `onSelectNode` (this component's own raycast click
   * handler, below) or externally (e.g. a `TimelinePanel` clip click, or a
   * future DSL panel selection): `Viewport` only ever reads it here, the
   * same read-here/set-via-callback split `TimelinePanel`/`InspectorPanel`
   * already use for this exact store field (Phase 39).
   */
  selectedNodeId?: string | undefined;
  /**
   * Calls the store's `selectNode` action. Invoked by this component's own
   * raycast-based click handler (see `handleCanvasClick` below) with the
   * `SceneNode.id` of whatever was clicked, or `undefined` if the click hit
   * nothing - clicking empty viewport space deselects, the conventional
   * behavior in a real 3D editor.
   */
  onSelectNode?: (nodeId: string | undefined) => void;
  /**
   * The store's `commitDocument` funnel. The transform gizmo's own
   * `onTransformChange` callback (see `attachTransformGizmo` in
   * `@cadra/renderer`) calls this exactly once per completed drag gesture,
   * via `commitNodeTransform` (`../store/document-edits.js`) - the exact
   * same "splice this one node's new value back into the document, via
   * `replaceNodeInDocument`" shape `InspectorPanel`'s own property edits
   * already use - never a second, parallel way of mutating `document`.
   */
  commitDocument?: (candidate: unknown) => boolean;
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
 *
 * Note this remains true for Phase 40's own gizmo drag: `attachTransformGizmo`
 * commits on drag *release* only (never on every intermediate drag frame,
 * see that function's own doc), so a drag gesture produces exactly one
 * `commitDocument` call, and therefore exactly one preview remount, once the
 * user lets go, not a remount per rendered drag frame.
 *
 * Shared-handle wiring (Phase 38): `Viewport` remains the sole owner of
 * *constructing and disposing* the `PreviewHandle` (it is the only component
 * with a mounted DOM container to call `mountPreview` against), but it no
 * longer keeps that handle entirely private. `onHandleChange` (if supplied)
 * is called with the freshly constructed handle immediately after
 * `mountPreview` returns, and again with `undefined` in this same effect's
 * cleanup, before `handle.dispose()` runs. `App.tsx` uses this to lift the
 * handle into state shared with `TimelinePanel`, so scrubbing the timeline
 * calls `seek` on the exact same live transport this viewport is showing,
 * and the timeline's own playhead stays in sync via that handle's
 * `onFrameChanged` subscription, rather than each component managing an
 * independent, disconnected preview.
 *
 * Selection and gizmo wiring (Phase 40): two further, independent
 * `useEffect`s (see below) own click-to-select and gizmo attach/detach,
 * deliberately kept separate from the mount/remount effect above:
 * `selectedNodeId` changing (e.g. a click in `TimelinePanel`) must not
 * itself tear down and reconstruct the whole preview, only the gizmo needs
 * to change, and the click-to-select listener only needs reattaching when
 * the canvas element itself changes, i.e. exactly when the mount effect
 * above reruns. Both new effects read the live `Renderer`/canvas/
 * `PreviewHandle` the mount effect constructs via refs (`rendererRef`/
 * `canvasRef`/`previewHandleRef`), the same "share imperative state a
 * sibling effect needs without adding it to React state" shape
 * `TimelinePanel`'s own `dragPreviewRef` already established.
 */
export function Viewport({
  document,
  selectedCompositionId,
  createRenderer = createRealRenderer,
  observeResize,
  buildPreviewRegistries: buildRegistries = buildPreviewRegistries,
  onHandleChange,
  selectedNodeId,
  onSelectNode,
  commitDocument,
}: ViewportProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  /**
   * The `Renderer`/canvas/`PreviewHandle` most recently constructed by the
   * mount effect below (all three always change together, so one ref each
   * suffices rather than a combined struct). `undefined` before the first
   * mount, and again after unmount or a document-driven remount tears the
   * old trio down before a new one is ready. Read (never written) by the two
   * effects further below.
   */
  const rendererRef = useRef<Renderer | undefined>(undefined);
  const canvasRef = useRef<HTMLCanvasElement | undefined>(undefined);
  const previewHandleRef = useRef<PreviewHandle | undefined>(undefined);
  /**
   * Always the latest `document`/`commitDocument`, readable from inside the
   * gizmo's `onTransformChange` callback without that callback needing to be
   * rebuilt (which would mean detaching and reattaching the whole gizmo,
   * visibly interrupting a would-be in-progress drag) every time `document`
   * changes for a reason unrelated to the current drag. Mirrors
   * `TimelinePanel`'s own `dragPreviewRef` pattern for the identical "a
   * long-lived imperative callback must not close over a stale value"
   * reason.
   */
  const latestDocumentRef = useRef(document);
  latestDocumentRef.current = document;
  const latestCommitDocumentRef = useRef(commitDocument);
  latestCommitDocumentRef.current = commitDocument;

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

    // Built and wired synchronously (not awaited): `buildRegistries` itself
    // never blocks on network I/O, only the *content* of what it returns
    // fills in asynchronously in the background (see that function's own
    // doc). Constructing `renderer`/`handle` synchronously here, exactly as
    // before this phase, is what keeps every ref this effect sets
    // (`rendererRef`/`canvasRef`/`previewHandleRef`) populated by the time
    // the click-to-select and gizmo effects below run in this same
    // commit - both key on this same `[document, selectedCompositionId]`
    // pair, so they always run immediately after this effect; had this
    // effect instead awaited asset loading before constructing anything,
    // both sibling effects would find every ref still empty every time and
    // never get a chance to re-run once loading finished.
    const registries = buildRegistries(document.project, composition.fps, () => {
      // Nudges the current frame to redraw once a background asset fetch
      // succeeds: `@cadra/renderer`'s own reconciler re-checks its own
      // registry on every later `applyNodeProperties` call for as long as a
      // node is still showing its own placeholder (see `node-factory.ts`'s
      // `"image"` case), so seeking to the frame already showing is enough
      // to pick up newly arrived content - no remount needed. A harmless
      // no-op if the preview already tore down/moved on by the time this
      // fires (`seek` past `dispose()` is itself a no-op).
      previewHandleRef.current?.seek(previewHandleRef.current.getFrame());
    });

    const renderer = createRenderer(registries.createRendererOptions);
    const handle = mountPreview(container, {
      project: document.project,
      compositionId: selectedCompositionId,
      renderer,
      ...(observeResize !== undefined && { observeResize }),
      ...(registries.resolveAudioBuffer !== undefined && {
        resolveAudioBuffer: registries.resolveAudioBuffer,
      }),
      ...(registries.audioContext !== undefined && { audioContext: registries.audioContext }),
      ...(registries.decodeVideoFrame !== undefined && { decodeVideoFrame: registries.decodeVideoFrame }),
    });
    rendererRef.current = renderer;
    canvasRef.current =
      container.querySelector<HTMLCanvasElement>(".cadra-preview__canvas") ?? undefined;
    previewHandleRef.current = handle;
    onHandleChange?.(handle);

    return () => {
      onHandleChange?.(undefined);
      handle.dispose();
      registries.dispose();
      rendererRef.current = undefined;
      canvasRef.current = undefined;
      previewHandleRef.current = undefined;
    };
    // Deliberately not depending on `createRenderer`/`observeResize`/
    // `buildRegistries`/`onHandleChange` themselves: this effect's remount
    // trigger is exactly `[document, selectedCompositionId]` per this
    // component's own doc above, and all four are fixed construction
    // dependencies (the real implementations in production, fixed fakes/
    // setters in tests), never something that changes across a component's
    // own lifetime the way `document`/`selectedCompositionId` do.
    // (eslint-plugin-react-hooks is not part of this workspace's lint
    // config, so no exhaustive-deps suppression is needed here either.)
  }, [document, selectedCompositionId]);

  // Click-to-select: a plain `click` listener on the mounted canvas,
  // (re)attached whenever the mount effect above reruns (a new canvas/
  // renderer pair exists). Converts the click's canvas-relative position to
  // normalized device coordinates (the [-1, 1] convention `pickNodeAtPoint`
  // expects, origin at canvas center, +y up; the DOM's own clientY grows
  // downward, hence the negation), then raycasts via `pickNodeAtPoint`. A
  // click that hits nothing (`undefined`) still calls `onSelectNode`:
  // clicking empty viewport space deselects, matching a conventional 3D
  // editor's own click-to-deselect behavior.
  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (canvas === undefined || renderer === undefined) {
      return undefined;
    }

    function handleCanvasClick(event: MouseEvent): void {
      if (canvas === undefined || renderer === undefined) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return;
      }
      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      const nodeId = pickNodeAtPoint({ renderer, point: { x, y } });
      onSelectNode?.(nodeId);
    }

    canvas.addEventListener("click", handleCanvasClick);
    return () => {
      canvas.removeEventListener("click", handleCanvasClick);
    };
    // Reruns whenever the mount effect's own dependencies change (a new
    // canvas/renderer pair) or onSelectNode itself changes. canvasRef's/
    // rendererRef's own identity cannot itself be a dependency (refs never
    // trigger a rerender), so this effect keys on the same
    // `[document, selectedCompositionId]` pair the mount effect uses, which
    // is exactly when a new canvas/renderer pair becomes available.
  }, [document, selectedCompositionId, onSelectNode]);

  // Gizmo attach/detach: (re)attaches a transform gizmo for `selectedNodeId`
  // whenever it changes, or whenever a new renderer replaces the old one
  // (document/selectedCompositionId changed). `attachTransformGizmo`
  // gracefully returns `undefined` if the renderer has not rendered a frame
  // yet (no active camera/reconciled node to attach to; see that function's
  // own doc): this effect's `onFrameChanged` subscription is what retries
  // once a frame actually has rendered, rather than leaving a just-selected
  // node's gizmo permanently missing because the very first attach attempt
  // happened to race the renderer's own async init(). Retrying stops the
  // moment attachment succeeds (no need to keep re-attempting once the
  // gizmo is live).
  useEffect(() => {
    const renderer = rendererRef.current;
    const previewHandle = previewHandleRef.current;
    if (renderer === undefined || selectedNodeId === undefined) {
      return undefined;
    }
    // Rebound to its own const: TypeScript does not retain the
    // `!== undefined` narrowing above across the nested function
    // declarations below (`commitTransform`/`tryAttach`), the same closure-
    // narrowing limitation `attachTransformGizmo` itself works around (see
    // that module's own comment for the full explanation).
    const nodeId = selectedNodeId;

    let attached: ReturnType<typeof attachTransformGizmo>;

    /**
     * Commits one completed drag's final `Transform` back through
     * `commitDocument`, via `commitNodeTransform` (see that function's own
     * doc in `../store/document-edits.js` for why it is a standalone,
     * exported function rather than staying inline here: the same splice
     * this app's own convergence test calls directly, proving a gizmo edit
     * and a DSL panel edit commit identical documents). Reads the *latest*
     * `document`/`commitDocument` via the refs above (not this effect's own
     * closed-over `document`/`commitDocument` props, which could be stale by
     * the time a drag actually ends): a no-op if `commitDocument` was never
     * supplied.
     */
    function commitTransform(transform: Transform): void {
      const currentCommitDocument = latestCommitDocumentRef.current;
      if (currentCommitDocument === undefined) {
        return;
      }
      commitNodeTransform(latestDocumentRef.current, nodeId, transform, currentCommitDocument);
    }

    function tryAttach(): void {
      if (attached !== undefined || rendererRef.current === undefined) {
        return;
      }
      attached = attachTransformGizmo({
        renderer: rendererRef.current,
        nodeId,
        onTransformChange: commitTransform,
      });
    }

    tryAttach();
    const unsubscribe = previewHandle?.onFrameChanged(() => {
      tryAttach();
    });

    return () => {
      unsubscribe?.();
      attached?.dispose();
    };
  }, [selectedNodeId, document, selectedCompositionId]);

  return <div className="cadra-studio-viewport" data-testid="studio-viewport" ref={containerRef} />;
}
