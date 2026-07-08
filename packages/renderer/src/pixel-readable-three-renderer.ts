import type { FrameContext, SceneState } from "@cadra/core";

import {
  type CreatePathTracedFrameRenderer,
  defaultCreatePathTracedFrameRenderer,
  type PathTracedFrameRenderer,
} from "./path-traced/path-traced-frame-renderer.js";
import type { PixelBuffer, PixelReadableRenderer } from "./pixel-readable-renderer.js";
import type {
  Renderer,
  RendererBackend,
  RendererCapabilities,
  RenderSize,
  RenderTarget,
} from "./renderer.js";
import { defaultThreeRendererDependencies, ThreeRenderer } from "./three-renderer.js";

/** Thrown when a frame's `sceneState.renderMode` is `"pathTraced"` but the wrapped `Renderer` is not a real `ThreeRenderer` (path tracing needs its live `THREE.Scene`/active camera, only reachable off the concrete class - see `ThreeRenderer`'s own narrow accessors). */
export class PathTracedRenderRequiresThreeRendererError extends Error {
  constructor() {
    super(
      "A sceneState with renderMode 'pathTraced' was rendered through a PixelReadableRenderer " +
        "whose wrapped Renderer is not a real ThreeRenderer. Path tracing needs the live " +
        "THREE.Scene/camera a ThreeRenderer reconciles, which a test double structurally " +
        "satisfying the Renderer interface does not have.",
    );
    this.name = "PathTracedRenderRequiresThreeRendererError";
  }
}

/**
 * Reads back `size`'s worth of pixels from `target` after a `renderFrame`
 * call has drawn into it. Real GPU pixel readback (`gl.readPixels`,
 * `canvas.convertToBlob`, etc.) is not exercisable in this headless
 * Node/Vitest environment, so this is always injected, exactly like every
 * other GPU-touching primitive in this package (`ThreeRendererDependencies`,
 * `WebGpuDetector`): production code supplies a real implementation, tests
 * supply a fake.
 */
export type ReadPixelsFn = (target: RenderTarget, size: RenderSize) => Promise<PixelBuffer>;

/** Options accepted by `createPixelReadableRenderer`. */
export interface CreatePixelReadableRendererOptions {
  /** Underlying `Renderer` to wrap. Defaults to a real `ThreeRenderer`. */
  renderer?: Renderer;
  /** Reads pixels back from the render target. Required in production; see `ReadPixelsFn`'s doc for why this has no real default. */
  readPixels: ReadPixelsFn;
  /**
   * Constructs the path-traced rendering capability used when a frame's
   * `sceneState.renderMode` is `"pathTraced"`. Defaults to a real one.
   * Never constructed (and never needs a real GPU) for a render that stays
   * raster the whole way through - the common case, since preview always
   * does and a composition's `renderMode` defaults to raster.
   */
  createPathTracedFrameRenderer?: CreatePathTracedFrameRenderer;
}

/** Thrown when `readPixels()` is called before `init()` has resolved. */
export class PixelReadableRendererNotInitializedError extends Error {
  constructor() {
    super("PixelReadableRenderer.readPixels() called before init() resolved.");
    this.name = "PixelReadableRendererNotInitializedError";
  }
}

/**
 * Wraps a `Renderer` (a real `ThreeRenderer` by default) with `readPixels()`,
 * producing a `PixelReadableRenderer` for the direct, in-process rendering
 * path. Every ordinary (raster) `Renderer` method delegates straight through
 * to the wrapped instance unchanged; this module's own additions are
 * tracking the most recent `init`/`resize` target and size so `readPixels`
 * knows what to read from, the `readPixels` method itself, and (Phase 65)
 * branching `renderFrame` into `@cadra/pathtracer` when a frame's own
 * `sceneState.renderMode` is `"pathTraced"`.
 *
 * Preview (`@cadra/player`'s `Transport`) never reaches any of this: it
 * constructs a plain `Renderer` (via `createRenderer`/`createBestAvailableRenderer`)
 * directly and never wraps it in a `PixelReadableRenderer` at all, exactly
 * like `PixelReadableRenderer`'s own doc says - so "preview always uses
 * raster" (`CompositionRenderMode`'s own doc in `@cadra/core`) holds
 * structurally, not by a runtime check anywhere in this file.
 */
export function createPixelReadableRenderer(
  options: CreatePixelReadableRendererOptions,
): PixelReadableRenderer {
  const inner = options.renderer ?? new ThreeRenderer(defaultThreeRendererDependencies);
  const readPixelsImpl = options.readPixels;
  const createPathTracedFrameRendererImpl =
    options.createPathTracedFrameRenderer ?? defaultCreatePathTracedFrameRenderer;

  let currentTarget: RenderTarget | undefined;
  let currentSize: RenderSize | undefined;
  let pathTracedFrameRenderer: PathTracedFrameRenderer | undefined;
  let pathTracedFrameRendererSize: RenderSize | undefined;
  /** The most recent path-traced frame's own pixels, returned by `readPixels()` instead of `readPixelsImpl` - `undefined` whenever the most recent `renderFrame` call was raster (the normal case). */
  let lastPathTracedResult: PixelBuffer | undefined;

  async function init(target: RenderTarget, size: RenderSize): Promise<void> {
    await inner.init(target, size);
    currentTarget = target;
    currentSize = size;
  }

  function resize(size: RenderSize): void {
    inner.resize(size);
    currentSize = size;
    // The path-traced renderer (if any) is fixed at whatever size it was
    // built for; disposing it here (rather than resizing it in place) lets
    // it lazily rebuild at the new size the next time a path-traced frame
    // is actually requested, exactly like `pathTracedFrameRenderer`'s own
    // lazy-construction-on-first-use already does for the ordinary case.
    pathTracedFrameRenderer?.dispose();
    pathTracedFrameRenderer = undefined;
    pathTracedFrameRendererSize = undefined;
  }

  async function readPixels(): Promise<PixelBuffer> {
    if (lastPathTracedResult !== undefined) {
      return lastPathTracedResult;
    }
    if (currentTarget === undefined || currentSize === undefined) {
      throw new PixelReadableRendererNotInitializedError();
    }
    return readPixelsImpl(currentTarget, currentSize);
  }

  async function renderFrame(sceneState: SceneState, frameContext: FrameContext): Promise<void> {
    // Reconciliation (materials, lights, environment, shadows, active
    // camera) always runs, even for a path-traced frame: path tracing
    // shares this exact live scene graph rather than rebuilding its own
    // (see `PathTracedFrameRenderer`'s own doc). The raster draw call this
    // also performs is simply not read back in that case.
    await inner.renderFrame(sceneState, frameContext);

    if (sceneState.renderMode !== "pathTraced") {
      lastPathTracedResult = undefined;
      return;
    }

    if (!(inner instanceof ThreeRenderer)) {
      throw new PathTracedRenderRequiresThreeRendererError();
    }
    if (currentSize === undefined) {
      throw new PixelReadableRendererNotInitializedError();
    }

    if (pathTracedFrameRenderer === undefined || pathTracedFrameRendererSize?.width !== currentSize.width || pathTracedFrameRendererSize?.height !== currentSize.height) {
      pathTracedFrameRenderer?.dispose();
      pathTracedFrameRenderer = createPathTracedFrameRendererImpl(currentSize);
      pathTracedFrameRendererSize = currentSize;
    }

    const scene = inner.getScene();
    // `inner.renderFrame` above always sets `lastUsedCamera` before
    // returning (falling back to `defaultCamera` when the scene has none
    // active), so `getActiveCamera()` is never `undefined` here - the `!`
    // reflects that already-established invariant, not an assumption.
    const camera = inner.getActiveCamera()!;

    lastPathTracedResult = await pathTracedFrameRenderer.render(
      scene,
      camera,
      sceneState.colorGrading,
      sceneState.pathTracing,
    );
  }

  return {
    init,
    renderFrame,
    resize,
    dispose(): void {
      pathTracedFrameRenderer?.dispose();
      inner.dispose();
    },
    readPixels,
    get backend(): RendererBackend {
      return inner.backend;
    },
    get capabilities(): RendererCapabilities {
      return inner.capabilities;
    },
  };
}
