/**
 * Scene-graph-to-Three.js reconciler: turns a `SceneNode` tree from
 * `@cadra/core` into a live `THREE.Object3D` tree, incrementally updating it
 * on subsequent calls rather than rebuilding it from scratch every frame.
 *
 * Deliberately its own module, separate from the `Renderer`-facing exports in
 * `../index.ts`: unlike `Renderer` (whose whole point is to hide Three.js),
 * this reconciler's whole point is to produce real `THREE.Object3D` values,
 * so its public surface legitimately exposes Three.js types. `ThreeRenderer`
 * (see `../three-renderer.ts`) holds one `Reconciler` instance for its
 * lifetime and drives it from `renderFrame`'s real `SceneState` input, so
 * this module's Three.js-shaped exports never themselves cross into the
 * `Renderer`-facing public surface.
 */

export type { NodeFactoryContext, OwnedResources } from "./node-factory.js";
export type { Reconciler, ReconcilerOptions } from "./reconciler.js";
export { createReconciler } from "./reconciler.js";
export type { GeometryRegistry, MaterialRegistry } from "./registries.js";
export {
  createDefaultGeometryRegistry,
  createDefaultMaterialRegistry,
  DEFAULT_GEOMETRY_REFS,
  DEFAULT_MATERIAL_REFS,
} from "./registries.js";
