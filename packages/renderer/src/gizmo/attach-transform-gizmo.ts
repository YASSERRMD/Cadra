import type { Transform } from "@cadra/core";
import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";

import type { Renderer } from "../renderer.js";
import { ThreeRenderer } from "../three-renderer.js";

/** Which drag mode `TransformControls` presents: move, rotate, or resize handles. */
export type TransformGizmoMode = "translate" | "rotate" | "scale";

/** Options accepted by `attachTransformGizmo`. */
export interface AttachTransformGizmoOptions {
  /**
   * The `Renderer` whose live scene the gizmo attaches into. Kept as the
   * public, Three.js-free `Renderer` type (never `ThreeRenderer` itself) so
   * every caller outside this package (namely `apps/studio`) never needs to
   * import or reference a Three.js-shaped type to use this function; see
   * this module's own doc below for how the real work still happens.
   */
  renderer: Renderer;
  /**
   * Which `SceneNode` (by id) to attach the gizmo to. Looked up via
   * `ThreeRenderer.getObject3DByNodeId`, the same `Object3D.name`-by-id
   * lookup a viewport's own click-to-select raycast uses.
   */
  nodeId: string;
  /**
   * Called with a plain `Transform` (from `@cadra/core`) exactly once per
   * completed drag gesture, i.e. on `TransformControls`'s own
   * `dragging-changed` event transitioning from `true` to `false` (drag
   * release), never on every intermediate drag frame. This is what lets a
   * caller wire this straight to `commitDocument` (via
   * `replaceNodeInDocument`/`updateNode`) with the same "commit on release,
   * not on every mousemove" discipline Phase 39's property editors already
   * established, rather than flooding the undo history with one entry per
   * rendered drag frame.
   */
  onTransformChange: (transform: Transform) => void;
  /** Initial gizmo mode. Defaults to `"translate"`, `TransformControls`'s own default. */
  mode?: TransformGizmoMode;
}

/** What `attachTransformGizmo` returns on success: a single `dispose()` to tear the gizmo down. */
export interface AttachedTransformGizmo {
  /**
   * Removes every listener this call attached, detaches and disposes the
   * underlying `TransformControls` instance, and removes its helper object
   * from the scene. Idempotent: safe to call more than once.
   */
  dispose(): void;
  /** Changes which handles are shown (move/rotate/resize) without tearing down and reattaching the whole gizmo. */
  setMode(mode: TransformGizmoMode): void;
}

/**
 * Attaches a real `three/addons/controls/TransformControls` gizmo (the
 * standard Three.js addon for exactly this: camera-aware drag math for
 * move/rotate/scale handles on a live `Object3D`, the same interaction model
 * DCC tools like Blender use) to the `Object3D` reconciled for `nodeId`,
 * committing a plain `Transform` back to the caller once per completed drag.
 *
 * Three.js-boundary design (see this package's own module docs for the
 * established precedent, e.g. `pixel-readable-three-renderer.ts`): this
 * function's own exported signature (`AttachTransformGizmoOptions`,
 * `AttachedTransformGizmo`) never mentions a Three.js type, and its
 * `renderer` parameter stays the public, Three.js-free `Renderer` interface
 * declared in `../renderer.ts` (untouched by this phase). Internally,
 * though, this function is free to import the real (still not exported
 * *for this purpose*, though `three-renderer.ts` does additively export the
 * class itself for `@cadra/headless`'s unrelated native-GPU seam)
 * `ThreeRenderer` and narrow `renderer` to it via `instanceof`, using the
 * handful of narrow accessor methods added to that class for exactly this
 * (`getObject3DByNodeId`, `getActiveCamera`, `getScene`, `getDomTarget`) to
 * do the real work: constructing a real `TransformControls`, attaching it to
 * the real `Object3D`, and adding its helper object to the real
 * `THREE.Scene`. A caller supplying anything other than a real
 * `ThreeRenderer` (e.g. `Viewport.test.tsx`'s fake `Renderer`, which
 * satisfies the `Renderer` interface structurally but is not `instanceof
 * ThreeRenderer`) gets a graceful `undefined` back instead of a thrown
 * error, since "no real Three.js renderer to attach a real gizmo to" is an
 * expected, not exceptional, condition for a test double.
 *
 * Returns `undefined` (rather than throwing) in every case where a gizmo
 * cannot actually be attached right now: `renderer` is not a `ThreeRenderer`,
 * `nodeId` does not resolve to a reconciled `Object3D` yet (e.g. the document
 * has not rendered a frame including that node), no active camera has been
 * resolved yet, or the renderer's target is not a real `HTMLElement` (an
 * `OffscreenCanvas`, which `TransformControls` cannot bind pointer events to
 * at all). Every one of these is a legitimate "not ready yet" state a caller
 * (e.g. a `useEffect` in `Viewport.tsx` reacting to a selection change before
 * the first frame has rendered) should simply retry on the next relevant
 * change, not treat as a programming error.
 */
export function attachTransformGizmo(
  options: AttachTransformGizmoOptions,
): AttachedTransformGizmo | undefined {
  const { renderer, nodeId, onTransformChange, mode = "translate" } = options;

  if (!(renderer instanceof ThreeRenderer)) {
    return undefined;
  }

  const maybeObject3D = renderer.getObject3DByNodeId(nodeId);
  if (maybeObject3D === undefined) {
    return undefined;
  }
  // Rebound to its own const: TypeScript does not retain the
  // `!== undefined` narrowing above across the function-declaration closure
  // below (`handleDraggingChanged`), since a nested function could in
  // principle be invoked at a point where the outer narrowing no longer
  // holds. Re-binding to a fresh `const` (never reassigned, so the narrowing
  // this time genuinely does hold for the closure's entire lifetime) is the
  // standard way to satisfy that without an `!` non-null assertion.
  const object3D = maybeObject3D;

  const camera = renderer.getActiveCamera();
  if (camera === undefined) {
    return undefined;
  }

  const domTarget = renderer.getDomTarget();
  if (domTarget === undefined || !(domTarget instanceof HTMLElement)) {
    return undefined;
  }

  const scene = renderer.getScene();

  const controls = new TransformControls(camera, domTarget);
  controls.setMode(mode);
  controls.attach(object3D);

  const helper = controls.getHelper();
  scene.add(helper);

  function handleDraggingChanged(event: { value: unknown }): void {
    // `TransformControls` fires "dragging-changed" on both drag start
    // (value: true) and drag end (value: false); only the latter should
    // ever commit, matching Phase 39's own "commit on release, not on every
    // intermediate frame" discipline (see PropertyEditor/InspectorPanel).
    if (event.value !== false) {
      return;
    }
    onTransformChange(object3DToTransform(object3D));
  }

  controls.addEventListener("dragging-changed", handleDraggingChanged);

  function dispose(): void {
    controls.removeEventListener("dragging-changed", handleDraggingChanged);
    controls.detach();
    scene.remove(helper);
    controls.dispose();
  }

  function setMode(nextMode: TransformGizmoMode): void {
    controls.setMode(nextMode);
  }

  return { dispose, setMode };
}

/** Reads `object3D`'s live position/rotation/scale back out as a plain `@cadra/core` `Transform` (Vector3 tuples), the inverse of `applyTransform` in `../reconciler/node-factory.ts`. */
function object3DToTransform(object3D: THREE.Object3D): Transform {
  return {
    position: [object3D.position.x, object3D.position.y, object3D.position.z],
    rotation: [object3D.rotation.x, object3D.rotation.y, object3D.rotation.z],
    scale: [object3D.scale.x, object3D.scale.y, object3D.scale.z],
  };
}
