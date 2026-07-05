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
 * deterministic frames end to end. Phase 6 owns the real reconciler that
 * turns a `SceneNode` tree (from `@cadra/core`) into rendered output, and
 * will replace this placeholder's shape rather than extend it.
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
  RenderableScene,
  Renderer,
  RendererBackend,
  RendererCapabilities,
  RenderSize,
  RenderTarget,
  SimplePrimitive,
} from "./renderer.js";
