import type { FrameContext, SceneState } from "@cadra/core";

import type { PixelBuffer, PixelReadableRenderer } from "./pixel-readable-renderer.js";
import type {
  Renderer,
  RendererBackend,
  RendererCapabilities,
  RenderSize,
  RenderTarget,
} from "./renderer.js";
import { defaultThreeRendererDependencies, ThreeRenderer } from "./three-renderer.js";

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
 * path. Every `Renderer` method delegates straight through to the wrapped
 * instance unchanged; this module's only addition is tracking the most
 * recent `init`/`resize` target and size so `readPixels` knows what to read
 * from, plus the `readPixels` method itself.
 */
export function createPixelReadableRenderer(
  options: CreatePixelReadableRendererOptions,
): PixelReadableRenderer {
  const inner = options.renderer ?? new ThreeRenderer(defaultThreeRendererDependencies);
  const readPixelsImpl = options.readPixels;

  let currentTarget: RenderTarget | undefined;
  let currentSize: RenderSize | undefined;

  async function init(target: RenderTarget, size: RenderSize): Promise<void> {
    await inner.init(target, size);
    currentTarget = target;
    currentSize = size;
  }

  function resize(size: RenderSize): void {
    inner.resize(size);
    currentSize = size;
  }

  async function readPixels(): Promise<PixelBuffer> {
    if (currentTarget === undefined || currentSize === undefined) {
      throw new PixelReadableRendererNotInitializedError();
    }
    return readPixelsImpl(currentTarget, currentSize);
  }

  return {
    init,
    renderFrame(sceneState: SceneState, frameContext: FrameContext): void {
      inner.renderFrame(sceneState, frameContext);
    },
    resize,
    dispose(): void {
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
