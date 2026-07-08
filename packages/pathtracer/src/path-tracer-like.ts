import * as THREE from "three";
import { WebGLPathTracer } from "three-gpu-pathtracer";

/**
 * The subset of `WebGLPathTracer` (`three-gpu-pathtracer`) this package
 * actually drives, mirroring `@cadra/renderer`'s own `ThreeRendererLike`
 * pattern: injectable so unit tests can substitute a fake and never touch a
 * real GPU, and narrow so this package's own public surface never leaks a
 * `three-gpu-pathtracer` type directly.
 */
export interface WebGLPathTracerLike {
  /** Total samples accumulated so far into `target`, since the last `setSceneAsync` (which resets accumulation) or construction. */
  readonly samples: number;
  /** The accumulated render target; its own `.texture` is the current, in-progress or converged, result. */
  readonly target: THREE.WebGLRenderTarget;
  /** Maximum light bounce depth. Mirrors `PathTracingConfig.bounces` (`@cadra/core`) one-to-one. */
  bounces: number;
  /**
   * Extracts BVH, materials, lights, and environment from `scene` (sharing
   * it directly, not copying it - see `renderPathTracedFrame`'s own doc for
   * why this is exactly what lets a path-traced final share the identical
   * scene graph a raster preview already built) and resets accumulation.
   */
  setSceneAsync(scene: THREE.Scene, camera: THREE.Camera): Promise<void>;
  /** Accumulates exactly one more deterministically seeded sample into `target` (see `WebGLPathTracerLike`'s own doc: `three-gpu-pathtracer`'s own internal seed is a plain incrementing counter, reset to `0` by `setSceneAsync`, never `Math.random()` or a wall-clock value). */
  renderSample(): void;
  /** Frees the BVH, textures, and render target this instance owns. Every `CreatePathTracer` result must eventually be disposed - there is no finalizer. */
  dispose(): void;
}

/** Constructs the real `WebGLPathTracerLike` for a given `WebGLRenderer`. */
export type CreatePathTracer = (renderer: THREE.WebGLRenderer) => WebGLPathTracerLike;

/** The dependency `renderPathTracedFrame` uses when no override is supplied, i.e. the real `three-gpu-pathtracer`. */
export const defaultCreatePathTracer: CreatePathTracer = (renderer) => new WebGLPathTracer(renderer);
