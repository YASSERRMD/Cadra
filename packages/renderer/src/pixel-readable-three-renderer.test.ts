import { createFrameContext, type SceneState } from "@cadra/core";
import { describe, expect, it, vi } from "vitest";

import {
  createPixelReadableRenderer,
  PixelReadableRendererNotInitializedError,
  type ReadPixelsFn,
} from "./pixel-readable-three-renderer.js";
import type { Renderer, RendererCapabilities, RenderSize, RenderTarget } from "./renderer.js";

const capabilities: RendererCapabilities = {
  backend: "webgpu",
  isFallback: false,
  maxTextureSize: 8192,
};

/** A minimal fake `Renderer`: records calls, touches no GPU. */
function createFakeRenderer(overrides: Partial<Renderer> = {}): Renderer {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    renderFrame: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    backend: "webgpu",
    capabilities,
    ...overrides,
  };
}

const size: RenderSize = { width: 640, height: 480 };
const target = { width: 0, height: 0 } as unknown as RenderTarget;

const sceneState: SceneState = {
  compositionId: "comp-1",
  frame: 0,
  width: 1920,
  height: 1080,
  layers: [],
};
const frameContext = createFrameContext({ frame: 0, fps: 30, durationInFrames: 90, seed: "s" });

describe("createPixelReadableRenderer", () => {
  it("delegates init/renderFrame/resize/dispose straight through to the wrapped Renderer", async () => {
    const fakeRenderer = createFakeRenderer();
    const readPixels: ReadPixelsFn = vi
      .fn()
      .mockResolvedValue({ width: 1, height: 1, data: new Uint8ClampedArray(4) });
    const renderer = createPixelReadableRenderer({ renderer: fakeRenderer, readPixels });

    await renderer.init(target, size);
    renderer.renderFrame(sceneState, frameContext);
    renderer.resize({ width: 100, height: 100 });
    renderer.dispose();

    expect(fakeRenderer.init).toHaveBeenCalledWith(target, size);
    expect(fakeRenderer.renderFrame).toHaveBeenCalledWith(sceneState, frameContext);
    expect(fakeRenderer.resize).toHaveBeenCalledWith({ width: 100, height: 100 });
    expect(fakeRenderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("exposes the wrapped Renderer's backend/capabilities unchanged", async () => {
    const fakeRenderer = createFakeRenderer();
    const renderer = createPixelReadableRenderer({
      renderer: fakeRenderer,
      readPixels: vi.fn(),
    });

    await renderer.init(target, size);

    expect(renderer.backend).toBe("webgpu");
    expect(renderer.capabilities).toEqual(capabilities);
  });

  it("readPixels(): calls the injected primitive with the most recent init target/size", async () => {
    const fakeRenderer = createFakeRenderer();
    const pixels = { width: 640, height: 480, data: new Uint8ClampedArray(640 * 480 * 4) };
    const readPixels: ReadPixelsFn = vi.fn().mockResolvedValue(pixels);
    const renderer = createPixelReadableRenderer({ renderer: fakeRenderer, readPixels });
    await renderer.init(target, size);

    const result = await renderer.readPixels();

    expect(readPixels).toHaveBeenCalledWith(target, size);
    expect(result).toBe(pixels);
  });

  it("readPixels(): reflects the most recent resize(), not the original init() size", async () => {
    const fakeRenderer = createFakeRenderer();
    const readPixels: ReadPixelsFn = vi
      .fn()
      .mockResolvedValue({ width: 1, height: 1, data: new Uint8ClampedArray(4) });
    const renderer = createPixelReadableRenderer({ renderer: fakeRenderer, readPixels });
    await renderer.init(target, size);

    renderer.resize({ width: 1280, height: 720 });
    await renderer.readPixels();

    expect(readPixels).toHaveBeenCalledWith(target, { width: 1280, height: 720 });
  });

  it("readPixels(): rejects with PixelReadableRendererNotInitializedError before init() resolves", async () => {
    const renderer = createPixelReadableRenderer({
      renderer: createFakeRenderer(),
      readPixels: vi.fn(),
    });

    await expect(renderer.readPixels()).rejects.toThrow(
      PixelReadableRendererNotInitializedError,
    );
  });

  it("defaults to constructing a real ThreeRenderer when no renderer override is supplied", () => {
    // Not calling init()/renderFrame() here (that would touch real Three.js
    // GPU-adjacent construction paths this test suite otherwise fakes out
    // via ThreeRendererDependencies); this only checks that omitting
    // `renderer` does not throw synchronously during construction itself.
    expect(() =>
      createPixelReadableRenderer({ readPixels: vi.fn() }),
    ).not.toThrow();
  });
});
