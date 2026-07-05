import { createFrameContext, type FrameContext } from "@cadra/core";
import { describe, expect, it, vi } from "vitest";

import type { RenderableScene, RenderSize, RenderTarget } from "./renderer.js";
import type { ThreeRendererDependencies, ThreeRendererFactory } from "./three-renderer.js";
import { ThreeRenderer } from "./three-renderer.js";

/** A minimal fake standing in for a real Three.js renderer instance: records calls, touches no GPU. */
function createFakeThreeRenderer() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    setSize: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    capabilities: { maxTextureSize: 4096 },
  };
}

/** Builds a `ThreeRendererDependencies` set from fakes, defaulting WebGPU to "available". */
function createFakeDeps(overrides: Partial<ThreeRendererDependencies> = {}): {
  deps: ThreeRendererDependencies;
  webGpuRenderer: ReturnType<typeof createFakeThreeRenderer>;
  webGl2Renderer: ReturnType<typeof createFakeThreeRenderer>;
} {
  const webGpuRenderer = createFakeThreeRenderer();
  const webGl2Renderer = createFakeThreeRenderer();

  const deps: ThreeRendererDependencies = {
    detectWebGpuSupport: () => true,
    createWebGpuRenderer: vi.fn(() => webGpuRenderer) as ThreeRendererFactory,
    createWebGl2Renderer: vi.fn(() => webGl2Renderer) as ThreeRendererFactory,
    ...overrides,
  };

  return { deps, webGpuRenderer, webGl2Renderer };
}

const size: RenderSize = { width: 640, height: 480 };
const htmlCanvasLikeTarget = {
  getContext: () => null,
  width: 0,
  height: 0,
  style: {},
} as unknown as RenderTarget;

function makeSceneState(): RenderableScene {
  return {
    background: [0, 0, 0, 1],
    primitives: [{ shape: "cube", position: [0, 0, 0], color: [1, 0, 0, 1] }],
  };
}

function makeFrameContext(): FrameContext {
  return createFrameContext({ frame: 3, fps: 30, durationInFrames: 90, seed: "det-seed" });
}

describe("ThreeRenderer backend selection", () => {
  it("selects webgpu when the injected capability check reports it available", async () => {
    const { deps, webGpuRenderer, webGl2Renderer } = createFakeDeps({
      detectWebGpuSupport: () => true,
    });
    const renderer = new ThreeRenderer(deps);

    await renderer.init(htmlCanvasLikeTarget, size);

    expect(renderer.backend).toBe("webgpu");
    expect(renderer.capabilities.isFallback).toBe(false);
    expect(deps.createWebGpuRenderer).toHaveBeenCalledTimes(1);
    expect(deps.createWebGl2Renderer).not.toHaveBeenCalled();
    expect(webGpuRenderer.init).toHaveBeenCalledTimes(1);
    expect(webGl2Renderer.setSize).not.toHaveBeenCalled();
  });

  it("falls back to webgl2 when the injected capability check reports webgpu unavailable", async () => {
    const { deps, webGpuRenderer, webGl2Renderer } = createFakeDeps({
      detectWebGpuSupport: () => false,
    });
    const renderer = new ThreeRenderer(deps);

    await renderer.init(htmlCanvasLikeTarget, size);

    expect(renderer.backend).toBe("webgl2");
    expect(renderer.capabilities.isFallback).toBe(true);
    expect(deps.createWebGl2Renderer).toHaveBeenCalledTimes(1);
    expect(deps.createWebGpuRenderer).not.toHaveBeenCalled();
    expect(webGpuRenderer.init).not.toHaveBeenCalled();
    expect(webGl2Renderer.setSize).toHaveBeenCalledTimes(1);
  });

  it("surfaces a clear error when even the webgl2 fallback construction fails", async () => {
    const failure = new Error("no GPU context available in this environment");
    const { deps } = createFakeDeps({
      detectWebGpuSupport: () => false,
      createWebGl2Renderer: vi.fn(() => {
        throw failure;
      }) as ThreeRendererFactory,
    });
    const renderer = new ThreeRenderer(deps);

    // Neither backend is available: the underlying construction failure
    // propagates as a rejected init() rather than being swallowed, so
    // callers get an explicit, unambiguous unsupported-environment signal.
    await expect(renderer.init(htmlCanvasLikeTarget, size)).rejects.toThrow(failure);
  });

  it("reports isFallback false and a defined maxTextureSize on the webgpu path's capabilities", async () => {
    const { deps } = createFakeDeps({ detectWebGpuSupport: () => true });
    const renderer = new ThreeRenderer(deps);

    await renderer.init(htmlCanvasLikeTarget, size);

    expect(renderer.capabilities).toEqual({
      backend: "webgpu",
      isFallback: false,
      maxTextureSize: 4096,
    });
  });
});

describe("ThreeRenderer lifecycle", () => {
  it("calls through to the underlying renderer in init -> renderFrame -> resize -> dispose order", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    const callOrder: string[] = [];
    webGpuRenderer.init.mockImplementation(async () => {
      callOrder.push("init");
    });
    webGpuRenderer.render.mockImplementation(() => callOrder.push("render"));
    webGpuRenderer.setSize.mockImplementation(() => callOrder.push("setSize"));
    webGpuRenderer.dispose.mockImplementation(() => callOrder.push("dispose"));

    await renderer.init(htmlCanvasLikeTarget, size);
    renderer.renderFrame(makeSceneState(), makeFrameContext());
    renderer.resize({ width: 1280, height: 720 });
    renderer.dispose();

    // First setSize call is the one init() itself makes (to establish the
    // initial size); the second is the explicit resize() call below.
    expect(callOrder).toEqual(["init", "setSize", "render", "setSize", "dispose"]);
  });

  it("passes resize's width and height through to the underlying renderer, without updating canvas style", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);
    webGpuRenderer.setSize.mockClear();

    renderer.resize({ width: 1920, height: 1080 });

    // The third argument (updateStyle) is explicitly false: true would
    // reach for HTMLCanvasElement-only `.style`, which OffscreenCanvas
    // (and OffscreenCanvas-shaped fakes) does not have.
    expect(webGpuRenderer.setSize).toHaveBeenCalledWith(1920, 1080, false);
  });

  it("throws a clear error if renderFrame is called before init resolves", () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);

    expect(() => renderer.renderFrame(makeSceneState(), makeFrameContext())).toThrow(/init/i);
  });

  it("throws a clear error if resize or dispose are called before init resolves", () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);

    expect(() => renderer.resize(size)).toThrow(/init/i);
    expect(() => renderer.dispose()).toThrow(/init/i);
  });
});

describe("ThreeRenderer determinism", () => {
  it("calling renderFrame twice with identical arguments makes identical calls to the underlying renderer", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);
    const sceneState = makeSceneState();
    const frameContext = makeFrameContext();

    renderer.renderFrame(sceneState, frameContext);
    const [firstScene, firstCamera] = webGpuRenderer.render.mock.calls[0] as [
      { background: unknown },
      { position: { x: number; y: number; z: number } },
    ];
    renderer.renderFrame(sceneState, frameContext);
    const [secondScene, secondCamera] = webGpuRenderer.render.mock.calls[1] as [
      { background: unknown },
      { position: { x: number; y: number; z: number } },
    ];

    expect(webGpuRenderer.render).toHaveBeenCalledTimes(2);
    // The renderer builds a fresh internal Three.js scene/camera per call
    // (see buildScene in three-renderer.ts), so these are different object
    // instances by design; determinism means their observable content is
    // identical, not reference equality. Real GPU pixel-level verification
    // of "same frame in, same pixels out" needs a real browser/GPU and is
    // out of scope in this Node test environment: this is the feasible
    // proxy for it here.
    expect(firstScene.background).toEqual(secondScene.background);
    expect(firstCamera.position).toEqual(secondCamera.position);
  });

  it("does not read the wall clock while rendering a frame", async () => {
    // Math.random() is deliberately not asserted here: constructing real
    // Three.js objects (Object3D, BufferGeometry, Material) calls it
    // internally to generate an opaque `uuid` for each instance. That is
    // Three.js's own bookkeeping, never observable in rendered output or in
    // any field this package's RenderableScene/FrameContext contract
    // exposes, so it does not threaten frame determinism. What would threaten
    // it is this package's own code reaching for wall-clock time, which
    // this test rules out; this package's own code never reaching for
    // Math.random() either is enforced separately, at lint time, by
    // eslint.config.js's no-restricted-properties rule.
    const dateNowSpy = vi.spyOn(Date, "now");
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState(), makeFrameContext());

    expect(dateNowSpy).not.toHaveBeenCalled();
    dateNowSpy.mockRestore();
  });
});

describe("ThreeRenderer with an OffscreenCanvas-shaped target", () => {
  /**
   * Shaped like a real OffscreenCanvas (`getContext`, `width`, `height`)
   * but with no `.style` or other HTMLCanvasElement-only member, since real
   * OffscreenCanvas is unavailable in this Node test environment too.
   */
  const offscreenCanvasLikeTarget = {
    getContext: () => null,
    width: 640,
    height: 480,
  } as unknown as RenderTarget;

  it("initializes without throwing when given an OffscreenCanvas-shaped target", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);

    await expect(renderer.init(offscreenCanvasLikeTarget, size)).resolves.toBeUndefined();
  });

  it("passes the OffscreenCanvas-shaped target straight through to the underlying factory", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);

    await renderer.init(offscreenCanvasLikeTarget, size);

    expect(deps.createWebGpuRenderer).toHaveBeenCalledWith(offscreenCanvasLikeTarget, size);
  });

  it("resizes an OffscreenCanvas-backed renderer without throwing", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(offscreenCanvasLikeTarget, size);

    expect(() => renderer.resize({ width: 800, height: 600 })).not.toThrow();
  });
});
