/**
 * @cadra/renderer
 *
 * Backend-agnostic rendering abstraction: selects WebGPU when available and
 * falls back to WebGL2 transparently, so downstream Cadra packages depend
 * only on the `Renderer` interface exported here, never on Three.js
 * directly.
 *
 * `RenderableScene` is a deliberately small placeholder for what
 * `renderFrame` accepts: a background color plus a handful of simple test
 * primitives, just enough to prove the render pipeline produces real,
 * deterministic frames end to end. A later phase replaces this placeholder's
 * shape (rather than extending it) once the timeline resolver defines what a
 * resolved scene state is.
 *
 * `./reconciler` additively exports the scene-graph-to-Three.js reconciler:
 * given a `SceneNode` tree, it produces and incrementally updates a live
 * `THREE.Object3D` tree. Unlike everything above, its exports legitimately
 * expose Three.js types, since mapping to Three.js is its entire purpose; it
 * is not yet wired into `Renderer`/`RenderableScene` (see `./reconciler`'s own
 * module doc for why).
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics.
 */
export const PACKAGE_NAME = "@cadra/renderer";

export type { WebGpuDetector } from "./capability-detection.js";
export type { CreateRendererOptions } from "./create-renderer.js";
export { createRenderer } from "./create-renderer.js";
export type {
  NodeFactoryContext,
  OwnedResources,
  Reconciler,
  ReconcilerOptions,
} from "./reconciler/index.js";
export type { GeometryRegistry, MaterialRegistry } from "./reconciler/index.js";
export {
  createDefaultGeometryRegistry,
  createDefaultMaterialRegistry,
  createReconciler,
  DEFAULT_GEOMETRY_REFS,
  DEFAULT_MATERIAL_REFS,
} from "./reconciler/index.js";
export type {
  RenderableScene,
  Renderer,
  RendererBackend,
  RendererCapabilities,
  RenderSize,
  RenderTarget,
  SimplePrimitive,
} from "./renderer.js";
