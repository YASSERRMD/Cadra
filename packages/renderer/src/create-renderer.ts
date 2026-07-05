import type { WebGpuDetector } from "./capability-detection.js";
import type { Renderer } from "./renderer.js";
import { defaultThreeRendererDependencies, ThreeRenderer } from "./three-renderer.js";

/**
 * Options for `createRenderer`. Deliberately narrow: only WebGPU detection
 * is exposed here, since it is the one seam a consumer outside this package
 * (e.g. an app choosing to force the WebGL2 path) has a legitimate reason to
 * override. Swapping the underlying Three.js renderer construction itself
 * is an internal testing seam (see `ThreeRendererDependencies` in
 * `./three-renderer.ts`), not part of the public surface, since exposing it
 * would mean exposing Three.js-shaped types here too.
 */
export interface CreateRendererOptions {
  detectWebGpuSupport?: WebGpuDetector;
}

/**
 * Creates a `Renderer`. With no `options`, constructs one backed by real
 * Three.js, selecting WebGPU when available and falling back to WebGL2
 * otherwise.
 */
export function createRenderer(options?: CreateRendererOptions): Renderer {
  return new ThreeRenderer({
    ...defaultThreeRendererDependencies,
    ...(options?.detectWebGpuSupport ? { detectWebGpuSupport: options.detectWebGpuSupport } : {}),
  });
}
