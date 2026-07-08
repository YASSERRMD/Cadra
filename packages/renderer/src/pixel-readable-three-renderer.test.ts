import { createFrameContext, type SceneState } from "@cadra/core";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import type { CreatePathTracedFrameRenderer, PathTracedFrameRenderer } from "./path-traced/path-traced-frame-renderer.js";
import {
  createPixelReadableRenderer,
  PathTracedRenderRequiresThreeRendererError,
  PixelReadableRendererNotInitializedError,
  type ReadPixelsFn,
} from "./pixel-readable-three-renderer.js";
import type { Renderer, RendererCapabilities, RenderSize, RenderTarget } from "./renderer.js";
import type { ThreeRendererDependencies, ThreeRendererFactory } from "./three-renderer.js";
import { ThreeRenderer } from "./three-renderer.js";

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

/** A minimal fake standing in for a real Three.js renderer instance: records calls, touches no GPU. Mirrors `three-renderer.test.ts`'s own helper of the same shape. */
function createFakeThreeRendererLike() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    setSize: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    capabilities: { maxTextureSize: 4096 },
    toneMappingExposure: 1,
    createEnvironmentMap: vi.fn((equirectangular: THREE.Texture) => equirectangular),
  };
}

/** A real `ThreeRenderer`, backed entirely by fakes via `ThreeRendererDependencies` - reconciliation, camera resolution, and `getScene()`/`getActiveCamera()` all work exactly as they do in production; only the underlying WebGPU/WebGL2 draw call is faked. */
function createRealThreeRendererWithFakeDeps(): ThreeRenderer {
  const fakeRenderer = createFakeThreeRendererLike();
  const deps: ThreeRendererDependencies = {
    detectWebGpuSupport: () => false,
    createWebGpuRenderer: vi.fn() as unknown as ThreeRendererFactory,
    createWebGl2Renderer: vi.fn(() => fakeRenderer) as unknown as ThreeRendererFactory,
    initPhysics: vi.fn().mockResolvedValue(undefined),
    createPhysicsBake: vi.fn(() => ({
      advanceTo: vi.fn(() => new Map()),
      dispose: vi.fn(),
    })) as unknown as ThreeRendererDependencies["createPhysicsBake"],
    createParticleRuntime: vi.fn(() => ({
      resolve: vi.fn(() => new Map()),
      dispose: vi.fn(),
    })) as unknown as ThreeRendererDependencies["createParticleRuntime"],
  };
  return new ThreeRenderer(deps);
}

/** A fake `PathTracedFrameRenderer`: records calls, touches no GPU. */
function createFakePathTracedFrameRenderer(): PathTracedFrameRenderer & {
  render: ReturnType<typeof vi.fn>;
} {
  return {
    render: vi.fn().mockResolvedValue({ width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) }),
    dispose: vi.fn(),
  };
}

const pathTracedSceneState: SceneState = {
  ...sceneState,
  renderMode: "pathTraced",
  pathTracing: { samples: 4, bounces: 2 },
};

describe("createPixelReadableRenderer: path-traced rendering (Phase 65)", () => {
  it("still reconciles via the wrapped Renderer's own renderFrame before doing anything path-traced-specific", async () => {
    const threeRenderer = createRealThreeRendererWithFakeDeps();
    const createPathTracedFrameRenderer: CreatePathTracedFrameRenderer = () =>
      createFakePathTracedFrameRenderer();
    const renderer = createPixelReadableRenderer({
      renderer: threeRenderer,
      readPixels: vi.fn(),
      createPathTracedFrameRenderer,
    });
    await renderer.init(target, size);

    await expect(renderer.renderFrame(pathTracedSceneState, frameContext)).resolves.toBeUndefined();
  });

  it("routes a path-traced frame to the injected path-traced-frame-renderer with the live scene/camera and the frame's own colorGrading/pathTracing", async () => {
    const threeRenderer = createRealThreeRendererWithFakeDeps();
    const fakePathTracedFrameRenderer = createFakePathTracedFrameRenderer();
    const createPathTracedFrameRenderer: CreatePathTracedFrameRenderer = () => fakePathTracedFrameRenderer;
    const renderer = createPixelReadableRenderer({
      renderer: threeRenderer,
      readPixels: vi.fn(),
      createPathTracedFrameRenderer,
    });
    await renderer.init(target, size);

    await renderer.renderFrame(pathTracedSceneState, frameContext);

    expect(fakePathTracedFrameRenderer.render).toHaveBeenCalledOnce();
    const [scene, camera, colorGrading, pathTracingConfig] = fakePathTracedFrameRenderer.render.mock.calls[0]!;
    expect(scene).toBe(threeRenderer.getScene());
    expect(camera).toBe(threeRenderer.getActiveCamera());
    expect(colorGrading).toBe(pathTracedSceneState.colorGrading);
    expect(pathTracingConfig).toBe(pathTracedSceneState.pathTracing);
  });

  it("readPixels() returns the path-traced result instead of calling the injected readPixels primitive", async () => {
    const threeRenderer = createRealThreeRendererWithFakeDeps();
    const fakePathTracedFrameRenderer = createFakePathTracedFrameRenderer();
    const readPixels: ReadPixelsFn = vi.fn().mockResolvedValue({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray(4),
    });
    const renderer = createPixelReadableRenderer({
      renderer: threeRenderer,
      readPixels,
      createPathTracedFrameRenderer: () => fakePathTracedFrameRenderer,
    });
    await renderer.init(target, size);
    await renderer.renderFrame(pathTracedSceneState, frameContext);

    const result = await renderer.readPixels();

    expect(result).toEqual({ width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) });
    expect(readPixels).not.toHaveBeenCalled();
  });

  it("a raster frame after a path-traced one falls back to the injected readPixels primitive again", async () => {
    const threeRenderer = createRealThreeRendererWithFakeDeps();
    const fakePathTracedFrameRenderer = createFakePathTracedFrameRenderer();
    const rasterPixels = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
    const readPixels: ReadPixelsFn = vi.fn().mockResolvedValue(rasterPixels);
    const renderer = createPixelReadableRenderer({
      renderer: threeRenderer,
      readPixels,
      createPathTracedFrameRenderer: () => fakePathTracedFrameRenderer,
    });
    await renderer.init(target, size);

    await renderer.renderFrame(pathTracedSceneState, frameContext);
    await renderer.renderFrame(sceneState, frameContext);
    const result = await renderer.readPixels();

    expect(result).toBe(rasterPixels);
  });

  it("does not construct the path-traced-frame-renderer at all for a render that stays raster the whole way through", async () => {
    const threeRenderer = createRealThreeRendererWithFakeDeps();
    const createPathTracedFrameRenderer = vi.fn<CreatePathTracedFrameRenderer>(() =>
      createFakePathTracedFrameRenderer(),
    );
    const renderer = createPixelReadableRenderer({
      renderer: threeRenderer,
      readPixels: vi.fn().mockResolvedValue({ width: 1, height: 1, data: new Uint8ClampedArray(4) }),
      createPathTracedFrameRenderer,
    });
    await renderer.init(target, size);

    await renderer.renderFrame(sceneState, frameContext);
    await renderer.readPixels();

    expect(createPathTracedFrameRenderer).not.toHaveBeenCalled();
  });

  it("throws PathTracedRenderRequiresThreeRendererError when the wrapped Renderer is not a real ThreeRenderer", async () => {
    const fakeRenderer = createFakeRenderer();
    const renderer = createPixelReadableRenderer({
      renderer: fakeRenderer,
      readPixels: vi.fn(),
      createPathTracedFrameRenderer: () => createFakePathTracedFrameRenderer(),
    });
    await renderer.init(target, size);

    await expect(renderer.renderFrame(pathTracedSceneState, frameContext)).rejects.toThrow(
      PathTracedRenderRequiresThreeRendererError,
    );
  });

  it("resize() disposes the cached path-traced-frame-renderer so it is rebuilt at the new size next time", async () => {
    const threeRenderer = createRealThreeRendererWithFakeDeps();
    const firstFake = createFakePathTracedFrameRenderer();
    const secondFake = createFakePathTracedFrameRenderer();
    const createPathTracedFrameRenderer = vi
      .fn<CreatePathTracedFrameRenderer>()
      .mockReturnValueOnce(firstFake)
      .mockReturnValueOnce(secondFake);
    const renderer = createPixelReadableRenderer({
      renderer: threeRenderer,
      readPixels: vi.fn(),
      createPathTracedFrameRenderer,
    });
    await renderer.init(target, size);
    await renderer.renderFrame(pathTracedSceneState, frameContext);

    renderer.resize({ width: 100, height: 100 });
    await renderer.renderFrame(pathTracedSceneState, frameContext);

    expect(firstFake.dispose).toHaveBeenCalledOnce();
    expect(createPathTracedFrameRenderer).toHaveBeenCalledTimes(2);
    expect(secondFake.render).toHaveBeenCalledOnce();
  });

  it("dispose() frees the cached path-traced-frame-renderer alongside the wrapped Renderer", async () => {
    const threeRenderer = createRealThreeRendererWithFakeDeps();
    const fakePathTracedFrameRenderer = createFakePathTracedFrameRenderer();
    const renderer = createPixelReadableRenderer({
      renderer: threeRenderer,
      readPixels: vi.fn(),
      createPathTracedFrameRenderer: () => fakePathTracedFrameRenderer,
    });
    await renderer.init(target, size);
    await renderer.renderFrame(pathTracedSceneState, frameContext);

    renderer.dispose();

    expect(fakePathTracedFrameRenderer.dispose).toHaveBeenCalledOnce();
  });
});
