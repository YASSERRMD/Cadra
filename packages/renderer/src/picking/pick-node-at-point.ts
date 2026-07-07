import * as THREE from "three";

import type { Renderer } from "../renderer.js";
import { ThreeRenderer } from "../three-renderer.js";

/** Normalized device coordinates (each in `[-1, 1]`), the origin-at-center convention `THREE.Raycaster.setFromCamera` expects. */
export interface NormalizedDeviceCoordinates {
  x: number;
  y: number;
}

/** Options accepted by `pickNodeAtPoint`. */
export interface PickNodeAtPointOptions {
  /**
   * The `Renderer` whose live scene is raycast against. Kept as the public,
   * Three.js-free `Renderer` type; see `attach-transform-gizmo.ts`'s own doc
   * for the identical boundary rationale this module follows.
   */
  renderer: Renderer;
  /** Where to cast the ray from, in normalized device coordinates (e.g. derived from a click's clientX/clientY and the canvas's own bounding rect). */
  point: NormalizedDeviceCoordinates;
}

/**
 * Casts a ray from `point` through the renderer's currently active camera
 * into its live scene, returning the `SceneNode.id` of the nearest
 * intersected node, or `undefined` if the ray hits nothing (or nothing
 * pickable).
 *
 * The `Object3D.name`-by-id lookup this needs is the exact inverse of
 * `ThreeRenderer.getObject3DByNodeId` (also added for this phase): given a
 * hit `Object3D`, this walks up its ancestor chain to the nearest one with a
 * non-empty `.name`, since a raycast can hit a leaf mesh nested several
 * levels below the `SceneNode`-tagged object that produced it (e.g. a
 * `group` node's mesh child), not necessarily the tagged object itself.
 *
 * Two kinds of `Object3D` in the live scene are deliberately excluded from
 * ever being returned as a pick result:
 *
 * 1. `TransformControls`'s own gizmo helper (added directly to the scene by
 *    `attachTransformGizmo`, a sibling of the reconciled content, not a
 *    descendant of it): its internal handle meshes are named things like
 *    `"X"`/`"XY"`/`"AXIS"` (`TransformControls`'s own convention, see that
 *    addon's source), never a real `SceneNode.id`, so without this
 *    exclusion a click on a gizmo arrow would walk up to one of those
 *    synthetic names instead of leaving the current selection alone. Skipped
 *    by checking `isTransformControlsRoot` (set by the addon itself) on each
 *    ancestor while walking up.
 * 2. The synthetic wrapper root `ThreeRenderer` builds around every
 *    `SceneState`'s layers each frame (`SCENE_STATE_ROOT_ID` in
 *    `three-renderer.ts`, not exported): reaching this ancestor while
 *    walking up means the ray hit the wrapper's own empty space, not any
 *    real layer, so it is treated the same as "nothing pickable" rather
 *    than resolved to a synthetic id no `SceneNode` in the document actually
 *    has.
 *
 * Returns `undefined` (never throws) if `renderer` is not a real
 * `ThreeRenderer`, or no frame has been rendered yet (no active camera to
 * cast from): the same "not ready yet, not a programming error" posture
 * `attachTransformGizmo` takes, for the same reasons.
 */
export function pickNodeAtPoint(options: PickNodeAtPointOptions): string | undefined {
  const { renderer, point } = options;

  if (!(renderer instanceof ThreeRenderer)) {
    return undefined;
  }

  const camera = renderer.getActiveCamera();
  if (camera === undefined) {
    return undefined;
  }

  const scene = renderer.getScene();
  const pickableChildren = scene.children.filter(
    (child) => !(child as unknown as { isTransformControlsRoot?: boolean }).isTransformControlsRoot,
  );

  // A real WebGL/WebGPU renderer's own render() call updates every
  // object's (and the camera's) world matrix as a side effect, which
  // Raycaster's own math depends on; this function has no guarantee it is
  // called right after such a render() (e.g. a click handler firing well
  // after the last rendered frame), so it updates them explicitly itself
  // rather than relying on that incidental side effect from elsewhere.
  camera.updateMatrixWorld();
  scene.updateMatrixWorld();

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(point.x, point.y), camera);
  const intersections = raycaster.intersectObjects(pickableChildren, true);

  const firstHit = intersections[0];
  if (firstHit === undefined) {
    return undefined;
  }

  return findNearestNamedAncestorId(firstHit.object);
}

/** Synthetic wrapper root id `ThreeRenderer` builds every frame (mirrors `SCENE_STATE_ROOT_ID` in `../three-renderer.ts`, not itself exported); never a real, authored `SceneNode.id`. */
const SCENE_STATE_ROOT_ID = "__cadra_scene_state_root__";

/** Walks up from `object3D` to the nearest ancestor (inclusive) with a non-empty, non-synthetic `.name`, returning it, or `undefined` if none is found before running out of parents. */
function findNearestNamedAncestorId(object3D: THREE.Object3D): string | undefined {
  let current: THREE.Object3D | null = object3D;
  while (current !== null) {
    if (
      (current as unknown as { isTransformControlsRoot?: boolean }).isTransformControlsRoot === true
    ) {
      return undefined;
    }
    if (current.name !== "" && current.name !== SCENE_STATE_ROOT_ID) {
      return current.name;
    }
    current = current.parent;
  }
  return undefined;
}
