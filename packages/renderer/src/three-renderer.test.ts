import {
  createFrameContext,
  createIdentityTransform,
  type FrameContext,
  type MeshNode,
  type SceneNode,
  type SceneState,
} from "@cadra/core";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import type { RenderSize, RenderTarget } from "./renderer.js";
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

/** A single mesh `SceneNode`, defaulting to the seeded "box"/"default" registry refs. */
function meshNode(id: string, overrides: Partial<MeshNode> = {}): MeshNode {
  return {
    id,
    kind: "mesh",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    geometryRef: "box",
    materialRef: "default",
    ...overrides,
  };
}

/** A single camera `SceneNode` at a fixed, easily-asserted fov. */
function cameraNode(id: string, fov = 60): SceneNode {
  return {
    id,
    kind: "camera",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    fov,
    near: 0.1,
    far: 1000,
    target: [0, 0, 0],
  };
}

/**
 * A minimal, directly-constructed `SceneState` (this package's real
 * `renderFrame` input as of Phase 13): one layer, opacity 1, no active
 * camera. Building it as a plain object (rather than routing through
 * `resolveSceneAtFrame`) keeps these renderer-level tests focused on
 * `ThreeRenderer`'s own reconciliation/opacity/camera-selection behavior.
 */
function makeSceneState(overrides: Partial<SceneState> = {}): SceneState {
  return {
    compositionId: "comp-1",
    frame: 3,
    width: 640,
    height: 480,
    layers: [
      {
        compositionId: "comp-1",
        trackId: "track-1",
        clipId: "clip-1",
        node: meshNode("mesh-1"),
        zIndex: 0,
        localFrame: 3,
        opacity: 1,
      },
    ],
    ...overrides,
  };
}

function makeFrameContext(frame = 3): FrameContext {
  return createFrameContext({ frame, fps: 30, durationInFrames: 90, seed: "det-seed" });
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
      THREE.Scene,
      THREE.Camera,
    ];
    renderer.renderFrame(sceneState, frameContext);
    const [secondScene, secondCamera] = webGpuRenderer.render.mock.calls[1] as [
      THREE.Scene,
      THREE.Camera,
    ];

    expect(webGpuRenderer.render).toHaveBeenCalledTimes(2);
    // The renderer holds one persistent internal Three.js scene and reuses
    // the reconciler's own stable Object3D identity across calls (see
    // three-renderer.ts), so, unlike the old per-call-fresh-scene
    // placeholder, these are now the exact same scene instance both times.
    // Camera choice for an unchanged sceneState/frameContext pair is the
    // same default-camera instance both times too.
    expect(firstScene).toBe(secondScene);
    expect(firstCamera).toBe(secondCamera);
    expect(firstCamera.position.toArray()).toEqual(secondCamera.position.toArray());
  });

  it("does not read the wall clock while rendering a frame", async () => {
    // Math.random() is deliberately not asserted here: constructing real
    // Three.js objects (Object3D, BufferGeometry, Material) calls it
    // internally to generate an opaque `uuid` for each instance. That is
    // Three.js's own bookkeeping, never observable in rendered output or in
    // any field this package's SceneState/FrameContext contract exposes, so
    // it does not threaten frame determinism. What would threaten it is this
    // package's own code reaching for wall-clock time, which this test rules
    // out; this package's own code never reaching for Math.random() either
    // is enforced separately, at lint time, by eslint.config.js's
    // no-restricted-properties rule.
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

describe("ThreeRenderer.renderFrame: real SceneState reconciliation", () => {
  it("reconciles a multi-layer SceneState into the expected Three.js tree shape", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    const sceneState = makeSceneState({
      layers: [
        {
          compositionId: "comp-1",
          trackId: "track-back",
          clipId: "clip-back",
          node: meshNode("back-mesh"),
          zIndex: 0,
          localFrame: 3,
          opacity: 1,
        },
        {
          compositionId: "comp-1",
          trackId: "track-front",
          clipId: "clip-front",
          node: meshNode("front-mesh", { geometryRef: "sphere", materialRef: "wireframe" }),
          zIndex: 1,
          localFrame: 3,
          opacity: 1,
        },
      ],
    });

    renderer.renderFrame(sceneState, makeFrameContext());

    const [scene] = webGpuRenderer.render.mock.calls[0] as [THREE.Scene, THREE.Camera];
    // scene -> wrapper root group -> [back-mesh, front-mesh], one Object3D
    // per layer, in sceneState.layers order.
    expect(scene.children).toHaveLength(1);
    const wrapperRoot = scene.children[0] as THREE.Group;
    expect(wrapperRoot.children).toHaveLength(2);
    expect(wrapperRoot.children[0]?.name).toBe("back-mesh");
    expect(wrapperRoot.children[1]?.name).toBe("front-mesh");
    expect(wrapperRoot.children[0]).toBeInstanceOf(THREE.Mesh);
    expect((wrapperRoot.children[1] as THREE.Mesh).geometry).toBeInstanceOf(THREE.SphereGeometry);
  });

  it("preserves Object3D identity for an unchanged node id across renderFrame calls", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);
    const sceneState = makeSceneState();

    renderer.renderFrame(sceneState, makeFrameContext(3));
    const firstMesh = renderer["scene"].children[0]?.children[0];
    renderer.renderFrame(sceneState, makeFrameContext(4));
    const secondMesh = renderer["scene"].children[0]?.children[0];

    expect(secondMesh).toBe(firstMesh);
  });

  it("updates in place (no growth) when renderFrame is called repeatedly with a stable layer set", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);
    const sceneState = makeSceneState();

    for (let frame = 0; frame < 5; frame += 1) {
      renderer.renderFrame(sceneState, makeFrameContext(frame));
    }

    expect(renderer["scene"].children).toHaveLength(1);
    expect(renderer["scene"].children[0]?.children).toHaveLength(1);
  });
});

describe("ThreeRenderer.renderFrame: layer opacity", () => {
  it("leaves an opacity-1 layer's material as the exact shared registry instance (no clone, no transparency)", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);
    const sceneState = makeSceneState();

    renderer.renderFrame(sceneState, makeFrameContext());

    const mesh = renderer["scene"].children[0]?.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.Material;
    expect(material.transparent).toBe(false);
  });

  it("applies opacity only to the transitioning layer's subtree, leaving sibling layers untouched", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    const sceneState = makeSceneState({
      layers: [
        {
          compositionId: "comp-1",
          trackId: "track-full",
          clipId: "clip-full",
          node: meshNode("full-opacity-mesh"),
          zIndex: 0,
          localFrame: 3,
          opacity: 1,
        },
        {
          compositionId: "comp-1",
          trackId: "track-fading",
          clipId: "clip-fading",
          node: meshNode("fading-mesh"),
          zIndex: 1,
          localFrame: 3,
          opacity: 0.4,
        },
      ],
    });

    renderer.renderFrame(sceneState, makeFrameContext());

    const wrapperRoot = renderer["scene"].children[0] as THREE.Group;
    const fullOpacityMesh = wrapperRoot.children[0] as THREE.Mesh;
    const fadingMesh = wrapperRoot.children[1] as THREE.Mesh;

    expect((fullOpacityMesh.material as THREE.Material).transparent).toBe(false);
    expect((fadingMesh.material as THREE.Material).transparent).toBe(true);
    expect((fadingMesh.material as THREE.Material).opacity).toBeCloseTo(0.4);
  });

  it("does not corrupt an unrelated node sharing the same materialRef when only one of them is transitioning", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    // Both layers reference the exact same pooled "default" material via the
    // renderer's default material registry: applying opacity to the fading
    // layer's mesh must not leak transparency onto the full-opacity layer's
    // mesh, even though both meshes initially resolve to the same shared
    // THREE.Material instance.
    const sceneState = makeSceneState({
      layers: [
        {
          compositionId: "comp-1",
          trackId: "track-full",
          clipId: "clip-full",
          node: meshNode("full-opacity-mesh", { materialRef: "default" }),
          zIndex: 0,
          localFrame: 3,
          opacity: 1,
        },
        {
          compositionId: "comp-1",
          trackId: "track-fading",
          clipId: "clip-fading",
          node: meshNode("fading-mesh", { materialRef: "default" }),
          zIndex: 1,
          localFrame: 3,
          opacity: 0.25,
        },
      ],
    });

    renderer.renderFrame(sceneState, makeFrameContext());

    const wrapperRoot = renderer["scene"].children[0] as THREE.Group;
    const fullOpacityMesh = wrapperRoot.children[0] as THREE.Mesh;
    const fadingMesh = wrapperRoot.children[1] as THREE.Mesh;

    // The two meshes must not end up sharing one mutated material instance.
    expect(fullOpacityMesh.material).not.toBe(fadingMesh.material);
    expect((fullOpacityMesh.material as THREE.Material).transparent).toBe(false);
    expect((fullOpacityMesh.material as THREE.Material).opacity).toBe(1);
    expect((fadingMesh.material as THREE.Material).transparent).toBe(true);
    expect((fadingMesh.material as THREE.Material).opacity).toBeCloseTo(0.25);
  });

  it("re-resolves back to the shared registry material once opacity returns to 1 on a later frame", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    const fadingState = makeSceneState({
      layers: [
        {
          compositionId: "comp-1",
          trackId: "track-1",
          clipId: "clip-1",
          node: meshNode("mesh-1"),
          zIndex: 0,
          localFrame: 3,
          opacity: 0.5,
        },
      ],
    });
    renderer.renderFrame(fadingState, makeFrameContext(3));
    const fadingMesh = renderer["scene"].children[0]?.children[0] as THREE.Mesh;
    expect((fadingMesh.material as THREE.Material).transparent).toBe(true);

    const fullState = makeSceneState({
      layers: [
        {
          compositionId: "comp-1",
          trackId: "track-1",
          clipId: "clip-1",
          node: meshNode("mesh-1"),
          zIndex: 0,
          localFrame: 4,
          opacity: 1,
        },
      ],
    });
    renderer.renderFrame(fullState, makeFrameContext(4));
    const fullMesh = renderer["scene"].children[0]?.children[0] as THREE.Mesh;

    expect((fullMesh.material as THREE.Material).transparent).toBe(false);
  });
});

describe("ThreeRenderer.renderFrame: active camera selection", () => {
  it("renders with the camera object matching sceneState.activeCameraNodeId", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    const sceneState = makeSceneState({
      layers: [
        {
          compositionId: "comp-1",
          trackId: "track-1",
          clipId: "clip-1",
          node: cameraNode("camera-a", 60),
          zIndex: 0,
          localFrame: 3,
          opacity: 1,
        },
      ],
      activeCameraNodeId: "camera-a",
    });

    renderer.renderFrame(sceneState, makeFrameContext());

    const [, camera] = webGpuRenderer.render.mock.calls[0] as [THREE.Scene, THREE.PerspectiveCamera];
    expect(camera.name).toBe("camera-a");
    expect(camera.fov).toBe(60);
  });

  it("picks the correct camera among several candidates by matching activeCameraNodeId", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    const sceneState = makeSceneState({
      layers: [
        {
          compositionId: "comp-1",
          trackId: "track-1",
          clipId: "clip-1",
          node: {
            id: "wrapper",
            kind: "group",
            transform: createIdentityTransform(),
            visible: true,
            children: [cameraNode("camera-a", 40), cameraNode("camera-b", 80)],
          },
          zIndex: 0,
          localFrame: 3,
          opacity: 1,
        },
      ],
      activeCameraNodeId: "camera-b",
    });

    renderer.renderFrame(sceneState, makeFrameContext());

    const [, camera] = webGpuRenderer.render.mock.calls[0] as [THREE.Scene, THREE.PerspectiveCamera];
    expect(camera.name).toBe("camera-b");
    expect(camera.fov).toBe(80);
  });

  it("falls back to the default camera when activeCameraNodeId is unset", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    const sceneState = makeSceneState(); // no activeCameraNodeId
    renderer.renderFrame(sceneState, makeFrameContext());

    const [, camera] = webGpuRenderer.render.mock.calls[0] as [THREE.Scene, THREE.PerspectiveCamera];
    expect(camera.name).toBe("");
    expect(camera.position.toArray()).toEqual([0, 0, 5]);
  });

  it("falls back to the default camera when activeCameraNodeId does not resolve to any reconciled camera", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    const sceneState = makeSceneState({ activeCameraNodeId: "does-not-exist" });
    renderer.renderFrame(sceneState, makeFrameContext());

    const [, camera] = webGpuRenderer.render.mock.calls[0] as [THREE.Scene, THREE.PerspectiveCamera];
    expect(camera.position.toArray()).toEqual([0, 0, 5]);
  });

  it("keeps using the default camera fallback consistently across repeated calls with no active camera", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState(), makeFrameContext(1));
    renderer.renderFrame(makeSceneState(), makeFrameContext(2));

    const [, firstCamera] = webGpuRenderer.render.mock.calls[0] as [THREE.Scene, THREE.Camera];
    const [, secondCamera] = webGpuRenderer.render.mock.calls[1] as [THREE.Scene, THREE.Camera];
    expect(firstCamera).toBe(secondCamera);
  });
});
