import type { ColorRGBA, FrameContext, Vector3 } from "@cadra/core";

/**
 * A canvas-like render target: either a real `HTMLCanvasElement` or an
 * `OffscreenCanvas` (or anything shaped like one, e.g. a headless test
 * double). `init` must work with either without touching a member that only
 * exists on one of the two (e.g. `HTMLCanvasElement.style`).
 */
export type RenderTarget = HTMLCanvasElement | OffscreenCanvas;

/** Pixel dimensions of a render target. */
export interface RenderSize {
  width: number;
  height: number;
}

/** Which underlying GPU API a `Renderer` instance ended up using. */
export type RendererBackend = "webgpu" | "webgl2";

/**
 * A small, non-exhaustive summary of the active backend, not a full GPU
 * capability dump. Extend this only with fields downstream code actually
 * needs; a raw feature-flag grab-bag belongs in the internal implementation,
 * not the public surface.
 */
export interface RendererCapabilities {
  /** The backend actually in use. */
  backend: RendererBackend;
  /**
   * True when WebGPU was requested (implicitly, by default) but unavailable
   * and the renderer fell back to WebGL2.
   */
  isFallback: boolean;
  /**
   * Largest texture dimension the backend supports, when the backend
   * exposes one directly. WebGPURenderer's public API surface (as of this
   * three.js version) does not, so this is `undefined` on `"webgpu"`.
   */
  maxTextureSize: number | undefined;
}

/**
 * A single, very simple built-in shape usable as test/placeholder scene
 * content: a solid-colored primitive at a position. Not part of the real
 * scene graph; see `RenderableScene` for why this exists at all.
 */
export interface SimplePrimitive {
  /** Which built-in shape to draw. Kept to a minimal set on purpose. */
  shape: "cube" | "sphere";
  position: Vector3;
  color: ColorRGBA;
}

/**
 * Placeholder scene-content type accepted by `renderFrame` for Phase 5.
 *
 * Phase 6 owns the real reconciler that turns a `SceneNode` tree from
 * `@cadra/core` into live Three.js objects; that is explicitly out of scope
 * here. This type exists only so the render pipeline (backend selection,
 * lifecycle, determinism) can be proven end to end with real pixel output,
 * without anticipating Phase 6's design. Expect `renderFrame`'s first
 * parameter type to be replaced (not just extended) once the reconciler
 * lands.
 */
export interface RenderableScene {
  /** Background/clear color for the frame. */
  background: ColorRGBA;
  /** A handful of simple test primitives to draw, if any. */
  primitives: SimplePrimitive[];
}

/**
 * The public rendering abstraction downstream Cadra packages depend on.
 * Nothing in this interface (or anything reachable from it) is a Three.js
 * type: callers select and swap the underlying graphics API (WebGPU,
 * falling back to WebGL2) without ever importing `three` themselves.
 *
 * A `Renderer` is stateless with respect to time: every `renderFrame` call
 * is fully determined by its explicit `sceneState` and `frameContext`
 * arguments, so calling it twice with identical arguments produces identical
 * underlying draw calls. Nothing here reads a wall clock, draws randomness,
 * or runs its own `requestAnimationFrame` loop; a host application owns
 * scheduling and calls `renderFrame` once per evaluated frame.
 */
export interface Renderer {
  /**
   * Prepares the renderer to draw into `target` at `size`. Must be called,
   * and its returned promise (if any) awaited, before `renderFrame`. This
   * implementation always returns a `Promise` (WebGPU's async init is the
   * common case to support), but the interface keeps `void` as a legal
   * return too so a future synchronous-only backend is not forced to wrap
   * itself in a trivial resolved promise.
   */
  init(target: RenderTarget, size: RenderSize): Promise<void> | void;
  /**
   * Draws one frame of `sceneState` as evaluated at `frameContext`. Pure
   * with respect to its arguments: no hidden state influences the result,
   * and this method never advances any clock of its own.
   */
  renderFrame(sceneState: RenderableScene, frameContext: FrameContext): void;
  /** Resizes the render target. Safe to call any number of times after `init`. */
  resize(size: RenderSize): void;
  /** Releases GPU resources held by this renderer. Not safe to use afterward. */
  dispose(): void;
  /** The backend this renderer selected, fixed once `init` resolves. */
  readonly backend: RendererBackend;
  /** A small summary of the active backend's capabilities. */
  readonly capabilities: RendererCapabilities;
}
