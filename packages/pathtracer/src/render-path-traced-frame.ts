import type * as THREE from "three";

import type { WebGLPathTracerLike } from "./path-tracer-like.js";
import type { ResolvedPathTracingConfig } from "./sample-budget.js";

/** The outcome of one `renderPathTracedFrame` call. */
export interface PathTracedFrameResult {
  /** The accumulated render target; its `.texture` is the final pixel data, read back exactly like `ThreeRenderer` reads back its own `WebGLRenderTarget`. */
  target: THREE.WebGLRenderTarget;
  /** How many samples `pathTracer` itself reports accumulated - equal to `config.samples` on a normal call, exposed so a caller can assert full convergence rather than trust it silently. */
  samples: number;
}

/**
 * Renders exactly one path-traced frame: shares `scene`/`camera` directly
 * with `pathTracer` (no copying - a path-traced final is meant to be a
 * physically-correct upgrade of the identical raster scene graph, per
 * `CompositionRenderMode`'s own doc in `@cadra/core`), resets accumulation
 * via `setSceneAsync`, then accumulates `config.samples` samples one at a
 * time via `renderSample()`.
 *
 * Deterministic: `renderSample()`'s own seed is a plain incrementing
 * integer counter reset to `0` by `setSceneAsync` (verified against
 * `three-gpu-pathtracer`'s `PathTracingRenderer.js` source, not
 * `Math.random()` or a wall-clock value), and this function always calls it
 * exactly `config.samples` times in the same order for the same inputs.
 */
export async function renderPathTracedFrame(
  pathTracer: WebGLPathTracerLike,
  scene: THREE.Scene,
  camera: THREE.Camera,
  config: ResolvedPathTracingConfig,
): Promise<PathTracedFrameResult> {
  pathTracer.bounces = config.bounces;
  await pathTracer.setSceneAsync(scene, camera);

  for (let sample = 0; sample < config.samples; sample += 1) {
    pathTracer.renderSample();
  }

  return {
    target: pathTracer.target,
    samples: pathTracer.samples,
  };
}
