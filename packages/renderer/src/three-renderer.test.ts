import {
  type CompositionPhysics,
  computeWhiteBalanceGain,
  createFrameContext,
  createIdentityTransform,
  type FrameContext,
  type LightNode,
  type MeshNode,
  type ModelNode,
  type PhysicsConstraintConfig,
  type SceneNode,
  type SceneState,
  type TextNode,
} from "@cadra/core";
import type { PhysicsTransform } from "@cadra/physics";
import type { TextRenderData } from "@cadra/text";
import * as THREE from "three";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import { GroundedSkybox } from "three/addons/objects/GroundedSkybox.js";
import { describe, expect, it, vi } from "vitest";

import type { LoadedModel } from "./assets/model-registry.js";
import { createInMemoryModelRegistry } from "./assets/model-registry.js";
import type { EnvironmentRegistry } from "./environment/environment-registry.js";
import type { RenderSize, RenderTarget } from "./renderer.js";
import { computeTextNodeRenderKey, createInMemoryTextRenderRegistry } from "./text/text-render-registry.js";
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
    toneMappingExposure: 1,
    // Identity passthrough: real PMREM prefiltering is not testable without
    // a GPU, so tests assert on which input texture reached this call and
    // that its output (here, itself) ends up on scene.environment/.background.
    createEnvironmentMap: vi.fn((equirectangular: THREE.Texture) => equirectangular),
  };
}

/** A minimal fake standing in for a real `PhysicsBake`: records calls, touches no real Rapier/WASM. */
function createFakePhysicsBake() {
  return {
    advanceTo: vi.fn(() => new Map()),
    dispose: vi.fn(),
  };
}

/** A minimal fake standing in for a real `ParticleRuntime`: records calls, touches no real GPU/TSL. */
function createFakeParticleRuntime() {
  return {
    resolve: vi.fn(() => new Map()),
    dispose: vi.fn(),
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
    initPhysics: vi.fn().mockResolvedValue(undefined),
    createPhysicsBake: vi.fn(() => createFakePhysicsBake()) as unknown as ThreeRendererDependencies["createPhysicsBake"],
    createParticleRuntime: vi.fn(
      () => createFakeParticleRuntime(),
    ) as unknown as ThreeRendererDependencies["createParticleRuntime"],
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

/** A single `model` `SceneNode` referencing `assetRef`. */
function modelNode(id: string, assetRef: string, overrides: Partial<ModelNode> = {}): ModelNode {
  return {
    id,
    kind: "model",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    assetRef,
    ...overrides,
  };
}

/** A `LoadedModel` with one plain mesh named `name`, no animations. */
function fakeLoadedModel(name: string): LoadedModel {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.name = name;
  const scene = new THREE.Group();
  scene.add(mesh);
  return { scene, animations: [] };
}

/** A single `text` `SceneNode` with the given `content`. */
function textNode(id: string, content: string): TextNode {
  return {
    id,
    kind: "text",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    content,
    fontSize: 1,
    color: [1, 1, 1, 1],
  };
}

/** A minimal, structurally-valid `TextRenderData` (one glyph, one atlas page): mirrors `node-factory.test.ts`'s own `FAKE_TEXT_RENDER_DATA`. */
const FAKE_TEXT_RENDER_DATA: TextRenderData = {
  lineCount: 1,
  atlasPages: [{ width: 4, height: 4, pixels: new Uint8Array(4 * 4 * 4).fill(255), png: new Uint8Array() }],
  glyphs: [
    {
      glyphId: 1,
      cluster: 0,
      lineIndex: 0,
      wordIndex: 0,
      origin: { x: 0, y: 0 },
      quad: { left: 0, right: 1, bottom: 0, top: 1 },
      page: 0,
      uv: { u0: 0, v0: 0, u1: 1, v1: 1 },
      range: 0.1,
    },
  ],
};

/** A single white point-light `SceneNode`, for asserting resolved color under a color grade. */
function lightNode(id: string, overrides: Partial<LightNode> = {}): LightNode {
  return {
    id,
    kind: "light",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    lightType: "point",
    color: [1, 1, 1, 1],
    intensity: 1,
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

/** A distinguishable, real `THREE.Texture` for environment tests, tagged via `.name` so a resolved value can be traced back to the ref that produced it. */
function makeEnvironmentTexture(name: string): THREE.Texture {
  const texture = new THREE.Texture();
  texture.name = name;
  return texture;
}

/** A fake `EnvironmentRegistry` resolving exactly the given refs, each to its own distinguishable texture. */
function fakeEnvironmentRegistry(refs: readonly string[]): EnvironmentRegistry {
  const textures = new Map(refs.map((ref) => [ref, makeEnvironmentTexture(ref)]));
  return { resolve: (ref: string) => textures.get(ref) };
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

describe("ThreeRenderer.renderFrame: color workflow", () => {
  it("sets toneMappingExposure from colorGrading.exposureStops in photographic stops, defaulting to a no-op 1 when colorGrading is unset", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState(), makeFrameContext());
    expect(webGpuRenderer.toneMappingExposure).toBe(1);

    renderer.renderFrame(makeSceneState({ colorGrading: { exposureStops: 2 } }), makeFrameContext());
    expect(webGpuRenderer.toneMappingExposure).toBe(4);

    renderer.renderFrame(makeSceneState({ colorGrading: { exposureStops: -1 } }), makeFrameContext());
    expect(webGpuRenderer.toneMappingExposure).toBe(0.5);
  });

  it("applies the composition's white balance gain to a light node's resolved color", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    const sceneState = makeSceneState({
      layers: [
        {
          compositionId: "comp-1",
          trackId: "track-1",
          clipId: "clip-1",
          node: lightNode("light-1"),
          zIndex: 0,
          localFrame: 3,
          opacity: 1,
        },
      ],
      colorGrading: { whiteBalanceTemperatureK: 3000, whiteBalanceTint: 0 },
    });

    renderer.renderFrame(sceneState, makeFrameContext());

    const light = renderer.getObject3DByNodeId("light-1") as THREE.Light;
    // The authored light color [1,1,1,1] is sRGB white, which is also linear
    // white (1 is a fixed point of the sRGB transfer function), so the
    // resolved color is exactly the white balance gain with nothing else
    // mixed in.
    const [expectedR, expectedG, expectedB] = computeWhiteBalanceGain(3000, 0);
    expect(light.color.r).toBeCloseTo(expectedR);
    expect(light.color.g).toBeCloseTo(expectedG);
    expect(light.color.b).toBeCloseTo(expectedB);
  });

  it("is deterministic: identical colorGrading produces identical toneMappingExposure and resolved light color across repeated calls", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    const sceneState = makeSceneState({
      layers: [
        {
          compositionId: "comp-1",
          trackId: "track-1",
          clipId: "clip-1",
          node: lightNode("light-1"),
          zIndex: 0,
          localFrame: 3,
          opacity: 1,
        },
      ],
      colorGrading: { exposureStops: 1.5, whiteBalanceTemperatureK: 4500, whiteBalanceTint: 0.3 },
    });

    renderer.renderFrame(sceneState, makeFrameContext(1));
    const firstExposure = webGpuRenderer.toneMappingExposure;
    const firstColor = (renderer.getObject3DByNodeId("light-1") as THREE.Light).color.clone();

    renderer.renderFrame(sceneState, makeFrameContext(2));
    const secondExposure = webGpuRenderer.toneMappingExposure;
    const secondColor = (renderer.getObject3DByNodeId("light-1") as THREE.Light).color.clone();

    expect(secondExposure).toBe(firstExposure);
    expect(secondColor.toArray()).toEqual(firstColor.toArray());
  });
});

describe("ThreeRenderer.renderFrame: image-based lighting environment (Phase 56)", () => {
  it("resolves envMapRef, prefilters it, and sets scene.environment", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const environmentRegistry = fakeEnvironmentRegistry(["studio"]);
    const renderer = new ThreeRenderer(deps, environmentRegistry);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState({ environment: { envMapRef: "studio" } }), makeFrameContext());

    expect(webGpuRenderer.createEnvironmentMap).toHaveBeenCalledTimes(1);
    expect(renderer.getScene().environment?.name).toBe("studio");
  });

  it("leaves scene.background null when showBackground is omitted, even though environment is set", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps, fakeEnvironmentRegistry(["studio"]));
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState({ environment: { envMapRef: "studio" } }), makeFrameContext());

    expect(renderer.getScene().environment).not.toBeNull();
    expect(renderer.getScene().background).toBeNull();
  });

  it("sets scene.background to the same prefiltered environment when showBackground is true", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps, fakeEnvironmentRegistry(["studio"]));
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ environment: { envMapRef: "studio", showBackground: true } }),
      makeFrameContext(),
    );

    const scene = renderer.getScene();
    expect(scene.background).toBe(scene.environment);
  });

  it("applies rotation and intensity from the composition's own environment config", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps, fakeEnvironmentRegistry(["studio"]));
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({
        environment: {
          envMapRef: "studio",
          rotation: Math.PI / 2,
          intensity: 2.5,
          showBackground: true,
          backgroundIntensity: 0.4,
        },
      }),
      makeFrameContext(),
    );

    const scene = renderer.getScene();
    expect(scene.environmentRotation.y).toBeCloseTo(Math.PI / 2);
    expect(scene.backgroundRotation.y).toBeCloseTo(Math.PI / 2);
    expect(scene.environmentIntensity).toBe(2.5);
    expect(scene.backgroundIntensity).toBe(0.4);
  });

  it("defaults rotation to 0, intensity to 1, and backgroundIntensity to 1 when omitted", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps, fakeEnvironmentRegistry(["studio"]));
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState({ environment: { envMapRef: "studio" } }), makeFrameContext());

    const scene = renderer.getScene();
    expect(scene.environmentRotation.y).toBe(0);
    expect(scene.environmentIntensity).toBe(1);
    expect(scene.backgroundIntensity).toBe(1);
  });

  it("does not re-prefilter on a later call with the same envMapRef (caching)", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps, fakeEnvironmentRegistry(["studio"]));
    await renderer.init(htmlCanvasLikeTarget, size);
    const sceneState = makeSceneState({ environment: { envMapRef: "studio" } });

    renderer.renderFrame(sceneState, makeFrameContext(1));
    renderer.renderFrame(sceneState, makeFrameContext(2));

    expect(webGpuRenderer.createEnvironmentMap).toHaveBeenCalledTimes(1);
  });

  it("updates rotation on a later call without re-prefiltering (rotation is a scene property, not baked into the cached texture)", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps, fakeEnvironmentRegistry(["studio"]));
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ environment: { envMapRef: "studio", rotation: 0 } }),
      makeFrameContext(1),
    );
    renderer.renderFrame(
      makeSceneState({ environment: { envMapRef: "studio", rotation: Math.PI } }),
      makeFrameContext(2),
    );

    expect(webGpuRenderer.createEnvironmentMap).toHaveBeenCalledTimes(1);
    expect(renderer.getScene().environmentRotation.y).toBeCloseTo(Math.PI);
  });

  it("re-prefilters and disposes the old cached texture when envMapRef changes", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps, fakeEnvironmentRegistry(["studio", "outdoor"]));
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState({ environment: { envMapRef: "studio" } }), makeFrameContext(1));
    const firstEnvironment = renderer.getScene().environment;
    const disposeSpy = vi.spyOn(firstEnvironment as THREE.Texture, "dispose");

    renderer.renderFrame(makeSceneState({ environment: { envMapRef: "outdoor" } }), makeFrameContext(2));

    expect(webGpuRenderer.createEnvironmentMap).toHaveBeenCalledTimes(2);
    expect(renderer.getScene().environment?.name).toBe("outdoor");
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("clears scene.environment/.background and disposes the cached texture when environment is later omitted", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps, fakeEnvironmentRegistry(["studio"]));
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ environment: { envMapRef: "studio", showBackground: true } }),
      makeFrameContext(1),
    );
    const disposeSpy = vi.spyOn(renderer.getScene().environment as THREE.Texture, "dispose");

    renderer.renderFrame(makeSceneState(), makeFrameContext(2));

    expect(renderer.getScene().environment).toBeNull();
    expect(renderer.getScene().background).toBeNull();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves scene.environment/.background null when no composition has ever set an environment", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps, fakeEnvironmentRegistry(["studio"]));
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState(), makeFrameContext());

    expect(renderer.getScene().environment).toBeNull();
    expect(renderer.getScene().background).toBeNull();
  });

  it("leaves scene.environment null when envMapRef does not resolve in the registry", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps, fakeEnvironmentRegistry([]));
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState({ environment: { envMapRef: "does-not-exist" } }), makeFrameContext());

    expect(renderer.getScene().environment).toBeNull();
  });

  it("adds a real GroundedSkybox mesh to the scene, positioned at y = height, when groundProjection is set", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps, fakeEnvironmentRegistry(["studio"]));
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ environment: { envMapRef: "studio", groundProjection: { height: 10, radius: 50 } } }),
      makeFrameContext(),
    );

    const skybox = renderer.getScene().children.find((child) => child instanceof GroundedSkybox);
    expect(skybox).toBeInstanceOf(GroundedSkybox);
    expect(skybox?.position.y).toBe(10);
  });

  it("removes the GroundedSkybox mesh once groundProjection is later omitted", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps, fakeEnvironmentRegistry(["studio"]));
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ environment: { envMapRef: "studio", groundProjection: { height: 5 } } }),
      makeFrameContext(1),
    );
    expect(renderer.getScene().children.some((child) => child instanceof GroundedSkybox)).toBe(true);

    renderer.renderFrame(makeSceneState({ environment: { envMapRef: "studio" } }), makeFrameContext(2));

    expect(renderer.getScene().children.some((child) => child instanceof GroundedSkybox)).toBe(false);
  });

  it("is deterministic: identical environment config produces identical scene.environment identity and rotation/intensity across repeated calls", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps, fakeEnvironmentRegistry(["studio"]));
    await renderer.init(htmlCanvasLikeTarget, size);
    const sceneState = makeSceneState({
      environment: { envMapRef: "studio", rotation: 1.1, intensity: 1.3 },
    });

    renderer.renderFrame(sceneState, makeFrameContext(1));
    const firstEnvironment = renderer.getScene().environment;
    const firstRotation = renderer.getScene().environmentRotation.y;
    const firstIntensity = renderer.getScene().environmentIntensity;

    renderer.renderFrame(sceneState, makeFrameContext(2));
    const secondEnvironment = renderer.getScene().environment;
    const secondRotation = renderer.getScene().environmentRotation.y;
    const secondIntensity = renderer.getScene().environmentIntensity;

    expect(secondEnvironment).toBe(firstEnvironment);
    expect(secondRotation).toBe(firstRotation);
    expect(secondIntensity).toBe(firstIntensity);
  });
});

describe("ThreeRenderer.renderFrame: scene fog (Phase 68)", () => {
  it("leaves scene.fog and scene.fogNode null when no composition has ever set fog", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState(), makeFrameContext());

    const scene = renderer.getScene() as THREE.Scene & { fogNode: unknown };
    expect(scene.fog).toBeNull();
    expect(scene.fogNode).toBeNull();
  });

  it("sets a real THREE.Fog for a 'linear' fog, with the resolved color, near, and far", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({
        fog: { type: "linear", color: [1, 1, 1, 1], near: 5, far: 100 },
        colorGrading: { whiteBalanceTemperatureK: 3000, whiteBalanceTint: 0 },
      }),
      makeFrameContext(),
    );

    const fog = renderer.getScene().fog as THREE.Fog;
    expect(fog).toBeInstanceOf(THREE.Fog);
    expect(fog.near).toBe(5);
    expect(fog.far).toBe(100);
    // The authored fog color [1,1,1,1] is sRGB white, which is also linear
    // white (1 is a fixed point of the sRGB transfer function), so the
    // resolved color is exactly the white balance gain with nothing else
    // mixed in - see the "color workflow" describe block's own identical use
    // of this fact for a light node's resolved color.
    const [expectedR, expectedG, expectedB] = computeWhiteBalanceGain(3000, 0);
    expect(fog.color.r).toBeCloseTo(expectedR);
    expect(fog.color.g).toBeCloseTo(expectedG);
    expect(fog.color.b).toBeCloseTo(expectedB);
  });

  it("sets a real THREE.FogExp2 for an 'exponential' fog, with the resolved density", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ fog: { type: "exponential", color: [1, 1, 1, 1], density: 0.05 } }),
      makeFrameContext(),
    );

    const fog = renderer.getScene().fog as THREE.FogExp2;
    expect(fog).toBeInstanceOf(THREE.FogExp2);
    expect(fog.density).toBe(0.05);
  });

  it("sets scene.fogNode (never scene.fog) for a 'height' fog on the WebGPU backend", async () => {
    const { deps } = createFakeDeps({ detectWebGpuSupport: () => true });
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ fog: { type: "height", color: [1, 1, 1, 1], density: 0.1, height: 5 } }),
      makeFrameContext(),
    );

    const scene = renderer.getScene() as THREE.Scene & { fogNode: unknown };
    expect(scene.fog).toBeNull();
    expect(scene.fogNode).not.toBeNull();
  });

  it("is a silent no-op for 'height' fog on the WebGL2 fallback backend (no classic equivalent exists)", async () => {
    const { deps } = createFakeDeps({ detectWebGpuSupport: () => false });
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ fog: { type: "height", color: [1, 1, 1, 1], density: 0.1, height: 5 } }),
      makeFrameContext(),
    );

    const scene = renderer.getScene() as THREE.Scene & { fogNode: unknown };
    expect(scene.fog).toBeNull();
    expect(scene.fogNode).toBeNull();
  });

  it("clears both scene.fog and scene.fogNode once fog is later omitted", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ fog: { type: "linear", color: [1, 1, 1, 1], near: 5, far: 100 } }),
      makeFrameContext(1),
    );
    expect(renderer.getScene().fog).not.toBeNull();

    renderer.renderFrame(makeSceneState(), makeFrameContext(2));

    const scene = renderer.getScene() as THREE.Scene & { fogNode: unknown };
    expect(scene.fog).toBeNull();
    expect(scene.fogNode).toBeNull();
  });
});

describe("ThreeRenderer: GLTF models (Phase 69)", () => {
  it("renders an empty placeholder for a model node when no modelRegistry was ever given a matching assetRef", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({
        layers: [
          {
            compositionId: "comp-1",
            trackId: "track-1",
            clipId: "clip-1",
            node: modelNode("model-1", "character.glb"),
            zIndex: 0,
            localFrame: 3,
            opacity: 1,
          },
        ],
      }),
      makeFrameContext(),
    );

    const object3D = renderer.getObject3DByNodeId("model-1");
    expect(object3D).toBeInstanceOf(THREE.Group);
    expect(object3D?.children.length).toBe(0);
  });

  it("threads a modelRegistry passed to the constructor all the way through to a real renderFrame call", async () => {
    const { deps } = createFakeDeps();
    const modelRegistry = createInMemoryModelRegistry();
    modelRegistry.register("character.glb", fakeLoadedModel("Body"));
    const renderer = new ThreeRenderer(deps, undefined, undefined, modelRegistry);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({
        layers: [
          {
            compositionId: "comp-1",
            trackId: "track-1",
            clipId: "clip-1",
            node: modelNode("model-1", "character.glb"),
            zIndex: 0,
            localFrame: 3,
            opacity: 1,
          },
        ],
      }),
      makeFrameContext(),
    );

    const object3D = renderer.getObject3DByNodeId("model-1");
    expect(object3D?.getObjectByName("Body")).toBeInstanceOf(THREE.Mesh);
  });

  it("gives two independently constructed renderers their own registered models, not a shared default", async () => {
    const { deps: depsA } = createFakeDeps();
    const registryA = createInMemoryModelRegistry();
    registryA.register("character.glb", fakeLoadedModel("Body"));
    const rendererA = new ThreeRenderer(depsA, undefined, undefined, registryA);
    await rendererA.init(htmlCanvasLikeTarget, size);

    const { deps: depsB } = createFakeDeps();
    const rendererB = new ThreeRenderer(depsB);
    await rendererB.init(htmlCanvasLikeTarget, size);

    const layers = [
      {
        compositionId: "comp-1",
        trackId: "track-1",
        clipId: "clip-1",
        node: modelNode("model-1", "character.glb"),
        zIndex: 0,
        localFrame: 3,
        opacity: 1,
      },
    ];
    rendererA.renderFrame(makeSceneState({ layers }), makeFrameContext());
    rendererB.renderFrame(makeSceneState({ layers }), makeFrameContext());

    expect(rendererA.getObject3DByNodeId("model-1")?.getObjectByName("Body")).toBeInstanceOf(THREE.Mesh);
    expect(rendererB.getObject3DByNodeId("model-1")?.children.length).toBe(0);
  });
});

describe("ThreeRenderer: text/satori render registries (Phase 71)", () => {
  it("threads a textRenderRegistry passed to the constructor all the way through to a real renderFrame call", async () => {
    const { deps } = createFakeDeps();
    const textRenderRegistry = createInMemoryTextRenderRegistry();
    textRenderRegistry.register(computeTextNodeRenderKey({ content: "Hi" }, 0), {
      data: FAKE_TEXT_RENDER_DATA,
      fontBytes: new Uint8Array(),
      fontContentHash: "fake-font",
    });
    const renderer = new ThreeRenderer(deps, undefined, undefined, undefined, textRenderRegistry);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({
        layers: [
          {
            compositionId: "comp-1",
            trackId: "track-1",
            clipId: "clip-1",
            node: textNode("text-1", "Hi"),
            zIndex: 0,
            localFrame: 0,
            opacity: 1,
          },
        ],
      }),
      makeFrameContext(0),
    );

    // Without a registered TextRenderEntry, a "text" node renders as an
    // empty group (see node-factory.ts's own buildTextObject doc) - real,
    // non-empty children here prove the constructor's own textRenderRegistry
    // genuinely reached the reconciler, not just that renderFrame ran.
    const object3D = renderer.getObject3DByNodeId("text-1");
    expect(object3D?.children.length).toBeGreaterThan(0);
  });

  it("renders an empty placeholder for a text node when no textRenderRegistry was ever given", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({
        layers: [
          {
            compositionId: "comp-1",
            trackId: "track-1",
            clipId: "clip-1",
            node: textNode("text-1", "Hi"),
            zIndex: 0,
            localFrame: 0,
            opacity: 1,
          },
        ],
      }),
      makeFrameContext(0),
    );

    expect(renderer.getObject3DByNodeId("text-1")?.children.length).toBe(0);
  });
});

describe("ThreeRenderer.renderFrame: cascaded shadow maps (Phase 57)", () => {
  it("attaches a real CSMShadowNode to the scene's first directional light on the WebGPU backend", async () => {
    const { deps } = createFakeDeps({ detectWebGpuSupport: () => true });
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({
        layers: [
          {
            compositionId: "comp-1",
            trackId: "track-1",
            clipId: "clip-1",
            node: lightNode("sun", { lightType: "directional" }),
            zIndex: 0,
            localFrame: 3,
            opacity: 1,
          },
        ],
        shadowQuality: { cascadedShadows: { cascades: 4, maxFar: 500 } },
      }),
      makeFrameContext(),
    );

    const light = renderer.getObject3DByNodeId("sun") as THREE.DirectionalLight;
    const shadowNode = (light.shadow as unknown as { shadowNode: unknown }).shadowNode;
    expect(shadowNode).toBeInstanceOf(CSMShadowNode);
    expect((shadowNode as CSMShadowNode).cascades).toBe(4);
    expect((shadowNode as CSMShadowNode).maxFar).toBe(500);
  });

  it("does not attach a CSMShadowNode on the WebGL2 fallback backend (cascaded shadows are WebGPU-only)", async () => {
    const { deps } = createFakeDeps({ detectWebGpuSupport: () => false });
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({
        layers: [
          {
            compositionId: "comp-1",
            trackId: "track-1",
            clipId: "clip-1",
            node: lightNode("sun", { lightType: "directional" }),
            zIndex: 0,
            localFrame: 3,
            opacity: 1,
          },
        ],
        shadowQuality: { cascadedShadows: { cascades: 3 } },
      }),
      makeFrameContext(),
    );

    const light = renderer.getObject3DByNodeId("sun") as THREE.DirectionalLight;
    expect((light.shadow as unknown as { shadowNode: unknown }).shadowNode).toBeUndefined();
  });

  it("does not throw and attaches nothing when there is no directional light in the scene", async () => {
    const { deps } = createFakeDeps({ detectWebGpuSupport: () => true });
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    expect(() =>
      renderer.renderFrame(
        makeSceneState({ shadowQuality: { cascadedShadows: { cascades: 3 } } }),
        makeFrameContext(),
      ),
    ).not.toThrow();
  });

  it("does not rebuild the CSMShadowNode on a later call with the same light and config (caching)", async () => {
    const { deps } = createFakeDeps({ detectWebGpuSupport: () => true });
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);
    const sceneState = makeSceneState({
      layers: [
        {
          compositionId: "comp-1",
          trackId: "track-1",
          clipId: "clip-1",
          node: lightNode("sun", { lightType: "directional" }),
          zIndex: 0,
          localFrame: 3,
          opacity: 1,
        },
      ],
      shadowQuality: { cascadedShadows: { cascades: 3 } },
    });

    renderer.renderFrame(sceneState, makeFrameContext(1));
    const light = renderer.getObject3DByNodeId("sun") as THREE.DirectionalLight;
    const firstShadowNode = (light.shadow as unknown as { shadowNode: unknown }).shadowNode;

    renderer.renderFrame(sceneState, makeFrameContext(2));
    const secondShadowNode = (light.shadow as unknown as { shadowNode: unknown }).shadowNode;

    expect(secondShadowNode).toBe(firstShadowNode);
  });

  it("rebuilds the CSMShadowNode when cascades changes", async () => {
    const { deps } = createFakeDeps({ detectWebGpuSupport: () => true });
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);
    const layers = [
      {
        compositionId: "comp-1",
        trackId: "track-1",
        clipId: "clip-1",
        node: lightNode("sun", { lightType: "directional" }),
        zIndex: 0,
        localFrame: 3,
        opacity: 1,
      },
    ];

    renderer.renderFrame(
      makeSceneState({ layers, shadowQuality: { cascadedShadows: { cascades: 3 } } }),
      makeFrameContext(1),
    );
    const light = renderer.getObject3DByNodeId("sun") as THREE.DirectionalLight;
    const firstShadowNode = (light.shadow as unknown as { shadowNode: unknown }).shadowNode;

    renderer.renderFrame(
      makeSceneState({ layers, shadowQuality: { cascadedShadows: { cascades: 4 } } }),
      makeFrameContext(2),
    );
    const secondShadowNode = (light.shadow as unknown as { shadowNode: CSMShadowNode }).shadowNode;

    expect(secondShadowNode).not.toBe(firstShadowNode);
    expect(secondShadowNode.cascades).toBe(4);
  });

  it("clears the CSMShadowNode once cascadedShadows is later omitted", async () => {
    const { deps } = createFakeDeps({ detectWebGpuSupport: () => true });
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);
    const layers = [
      {
        compositionId: "comp-1",
        trackId: "track-1",
        clipId: "clip-1",
        node: lightNode("sun", { lightType: "directional" }),
        zIndex: 0,
        localFrame: 3,
        opacity: 1,
      },
    ];

    renderer.renderFrame(
      makeSceneState({ layers, shadowQuality: { cascadedShadows: { cascades: 3 } } }),
      makeFrameContext(1),
    );
    renderer.renderFrame(makeSceneState({ layers }), makeFrameContext(2));

    const light = renderer.getObject3DByNodeId("sun") as THREE.DirectionalLight;
    expect((light.shadow as unknown as { shadowNode: unknown }).shadowNode).toBeNull();
  });
});

describe("ThreeRenderer.renderFrame: contact shadows (Phase 57)", () => {
  it("adds a contact-shadow decal mesh to the scene when contactShadows is set", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ shadowQuality: { contactShadows: { groundY: 0, opacity: 0.6, radius: 3 } } }),
      makeFrameContext(),
    );

    const decal = renderer
      .getScene()
      .children.find((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.CircleGeometry);
    expect(decal).toBeInstanceOf(THREE.Mesh);
  });

  it("removes the contact-shadow decal mesh once contactShadows is later omitted", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ shadowQuality: { contactShadows: { groundY: 0 } } }),
      makeFrameContext(1),
    );
    renderer.renderFrame(makeSceneState(), makeFrameContext(2));

    const decal = renderer
      .getScene()
      .children.find((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.CircleGeometry);
    expect(decal).toBeUndefined();
  });

  it("keeps the same decal mesh instance across calls with unchanged groundY/opacity/radius", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);
    const sceneState = makeSceneState({ shadowQuality: { contactShadows: { groundY: 0, opacity: 0.5 } } });

    renderer.renderFrame(sceneState, makeFrameContext(1));
    const first = renderer
      .getScene()
      .children.find((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.CircleGeometry);

    renderer.renderFrame(sceneState, makeFrameContext(2));
    const second = renderer
      .getScene()
      .children.find((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.CircleGeometry);

    expect(second).toBe(first);
  });

  it("rebuilds the decal mesh when opacity changes", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ shadowQuality: { contactShadows: { groundY: 0, opacity: 0.5 } } }),
      makeFrameContext(1),
    );
    const first = renderer
      .getScene()
      .children.find((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.CircleGeometry);

    renderer.renderFrame(
      makeSceneState({ shadowQuality: { contactShadows: { groundY: 0, opacity: 0.9 } } }),
      makeFrameContext(2),
    );
    const second = renderer
      .getScene()
      .children.find((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.CircleGeometry);

    expect(second).not.toBe(first);
  });
});

describe("ThreeRenderer.renderFrame: ambient occlusion (Phase 57)", () => {
  it("passes undefined ambientOcclusion to render() when shadowQuality is omitted", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState(), makeFrameContext());

    const [, , config] = webGpuRenderer.render.mock.calls[0] as [
      THREE.Scene,
      THREE.Camera,
      { ambientOcclusion: unknown },
    ];
    expect(config.ambientOcclusion).toBeUndefined();
  });

  it("passes a resolved ambient occlusion config to render() when ambientOcclusion is set", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ shadowQuality: { ambientOcclusion: { radius: 2, intensity: 0.7 } } }),
      makeFrameContext(),
    );

    const [, , config] = webGpuRenderer.render.mock.calls[0] as [
      THREE.Scene,
      THREE.Camera,
      { ambientOcclusion: { radius: number; intensity: number; resolutionScale: number; samples: number } },
    ];
    expect(config.ambientOcclusion.radius).toBe(2);
    expect(config.ambientOcclusion.intensity).toBe(0.7);
  });

  it("defaults radius and intensity to 1 when omitted", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState({ shadowQuality: { ambientOcclusion: {} } }), makeFrameContext());

    const [, , config] = webGpuRenderer.render.mock.calls[0] as [
      THREE.Scene,
      THREE.Camera,
      { ambientOcclusion: { radius: number; intensity: number } },
    ];
    expect(config.ambientOcclusion.radius).toBe(1);
    expect(config.ambientOcclusion.intensity).toBe(1);
  });

  it("resolves lower resolutionScale/samples at the 'preview' quality tier than at 'final'", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ shadowQuality: { tier: "preview", ambientOcclusion: {} } }),
      makeFrameContext(1),
    );
    const [, , previewConfig] = webGpuRenderer.render.mock.calls[0] as [
      THREE.Scene,
      THREE.Camera,
      { ambientOcclusion: { resolutionScale: number; samples: number } },
    ];

    renderer.renderFrame(
      makeSceneState({ shadowQuality: { tier: "final", ambientOcclusion: {} } }),
      makeFrameContext(2),
    );
    const [, , finalConfig] = webGpuRenderer.render.mock.calls[1] as [
      THREE.Scene,
      THREE.Camera,
      { ambientOcclusion: { resolutionScale: number; samples: number } },
    ];

    expect(previewConfig.ambientOcclusion.resolutionScale).toBeLessThan(finalConfig.ambientOcclusion.resolutionScale);
    expect(previewConfig.ambientOcclusion.samples).toBeLessThan(finalConfig.ambientOcclusion.samples);
  });

  it("defaults to the 'final' tier's own resolutionScale/samples when tier is omitted", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ shadowQuality: { tier: "final", ambientOcclusion: {} } }),
      makeFrameContext(1),
    );
    const [, , finalConfig] = webGpuRenderer.render.mock.calls[0] as [
      THREE.Scene,
      THREE.Camera,
      { ambientOcclusion: { resolutionScale: number; samples: number } },
    ];

    renderer.renderFrame(makeSceneState({ shadowQuality: { ambientOcclusion: {} } }), makeFrameContext(2));
    const [, , omittedTierConfig] = webGpuRenderer.render.mock.calls[1] as [
      THREE.Scene,
      THREE.Camera,
      { ambientOcclusion: { resolutionScale: number; samples: number } },
    ];

    expect(omittedTierConfig.ambientOcclusion).toEqual(finalConfig.ambientOcclusion);
  });

  it("is deterministic: identical shadowQuality resolves to an identical AO config across repeated calls", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);
    const sceneState = makeSceneState({
      shadowQuality: { tier: "preview", ambientOcclusion: { radius: 1.5, intensity: 0.6 } },
    });

    renderer.renderFrame(sceneState, makeFrameContext(1));
    const [, , first] = webGpuRenderer.render.mock.calls[0] as [
      THREE.Scene,
      THREE.Camera,
      { ambientOcclusion: unknown },
    ];

    renderer.renderFrame(sceneState, makeFrameContext(2));
    const [, , second] = webGpuRenderer.render.mock.calls[1] as [
      THREE.Scene,
      THREE.Camera,
      { ambientOcclusion: unknown },
    ];

    // Compares only ambientOcclusion, not the whole RenderPassConfig: frame
    // legitimately differs between makeFrameContext(1) and (2) (see
    // RenderPassConfig's own doc), so this asserts specifically that the
    // resolved AO config itself does not depend on which frame it was
    // resolved at, not that the two render() calls got byte-identical args.
    expect(second.ambientOcclusion).toEqual(first.ambientOcclusion);
  });
});

describe("ThreeRenderer.renderFrame: post-processing (Phase 58)", () => {
  it("passes undefined postProcessing to render() when the composition has none", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState(), makeFrameContext());

    const [, , config] = webGpuRenderer.render.mock.calls[0] as [
      THREE.Scene,
      THREE.Camera,
      { postProcessing: unknown },
    ];
    expect(config.postProcessing).toBeUndefined();
  });

  it("passes undefined postProcessing to render() when effects is an empty array (a no-op stack)", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState({ postProcessing: { effects: [] } }), makeFrameContext());

    const [, , config] = webGpuRenderer.render.mock.calls[0] as [
      THREE.Scene,
      THREE.Camera,
      { postProcessing: unknown },
    ];
    expect(config.postProcessing).toBeUndefined();
  });

  it("passes a resolved postProcessing config to render() when effects is non-empty", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState({ postProcessing: { tier: "preview", effects: [{ type: "sharpen", amount: 0.6 }] } }),
      makeFrameContext(),
    );

    const [, , config] = webGpuRenderer.render.mock.calls[0] as [
      THREE.Scene,
      THREE.Camera,
      { postProcessing: { tier: string; effects: unknown[] } },
    ];
    expect(config.postProcessing.tier).toBe("preview");
    expect(config.postProcessing.effects).toEqual([{ type: "sharpen", amount: 0.6 }]);
  });

  it("is deterministic: identical postProcessing resolves to an identical config across repeated calls", async () => {
    const { deps, webGpuRenderer } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);
    const sceneState = makeSceneState({ postProcessing: { effects: [{ type: "sharpen", amount: 0.4 }] } });

    renderer.renderFrame(sceneState, makeFrameContext(1));
    const [, , first] = webGpuRenderer.render.mock.calls[0] as [
      THREE.Scene,
      THREE.Camera,
      { postProcessing: unknown },
    ];

    renderer.renderFrame(sceneState, makeFrameContext(2));
    const [, , second] = webGpuRenderer.render.mock.calls[1] as [
      THREE.Scene,
      THREE.Camera,
      { postProcessing: unknown },
    ];

    // Compares only postProcessing, not the whole RenderPassConfig: frame
    // legitimately differs between makeFrameContext(1) and (2) (see
    // RenderPassConfig's own doc), so this asserts specifically that the
    // resolved postProcessing config itself does not depend on which frame
    // it was resolved at, not that the two render() calls got byte-identical
    // args.
    expect(second.postProcessing).toEqual(first.postProcessing);
  });
});

describe("ThreeRenderer: physics (Phase 66)", () => {
  /** A minimal fake standing in for a real `PhysicsBake`: records calls, touches no real Rapier/WASM. */
  function createFakePhysicsBakeInstance(transformsByFrame: Map<number, ReadonlyMap<string, PhysicsTransform>> = new Map()) {
    return {
      advanceTo: vi.fn((frame: number) => transformsByFrame.get(frame) ?? new Map()),
      dispose: vi.fn(),
    };
  }

  it("calls initPhysics during init()", async () => {
    const { deps } = createFakeDeps();
    const renderer = new ThreeRenderer(deps);

    await renderer.init(htmlCanvasLikeTarget, size);

    expect(deps.initPhysics).toHaveBeenCalledOnce();
  });

  it("applies the baked physics transform onto the corresponding dynamic-body mesh's own Object3D", async () => {
    const fakeBake = createFakePhysicsBakeInstance(
      new Map([[3, new Map([["mesh-1", { position: [7, 8, 9], rotation: [0, 0, 0] }]])]]),
    );
    const createPhysicsBake = vi.fn(() => fakeBake) as unknown as ThreeRendererDependencies["createPhysicsBake"];
    const { deps } = createFakeDeps({ createPhysicsBake });
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    const sceneState = makeSceneState({
      layers: [
        {
          compositionId: "comp-1",
          trackId: "track-1",
          clipId: "clip-1",
          node: meshNode("mesh-1", {
            rigidBody: { bodyType: "dynamic", collider: { shape: "sphere", radius: 1 } },
          }),
          zIndex: 0,
          localFrame: 3,
          opacity: 1,
        },
      ],
    });

    renderer.renderFrame(sceneState, makeFrameContext(3));

    const mesh = renderer.getObject3DByNodeId("mesh-1")!;
    expect([mesh.position.x, mesh.position.y, mesh.position.z]).toEqual([7, 8, 9]);
  });

  it("builds the physics bake once per (compositionId, seed) pair, reusing it across frames with the same pair", async () => {
    const fakeBake = createFakePhysicsBakeInstance();
    const createPhysicsBake = vi.fn(() => fakeBake) as unknown as ThreeRendererDependencies["createPhysicsBake"];
    const { deps } = createFakeDeps({ createPhysicsBake });
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState(), makeFrameContext(1));
    renderer.renderFrame(makeSceneState(), makeFrameContext(2));

    expect(createPhysicsBake).toHaveBeenCalledOnce();
    expect(fakeBake.advanceTo).toHaveBeenNthCalledWith(1, 1);
    expect(fakeBake.advanceTo).toHaveBeenNthCalledWith(2, 2);
  });

  it("rebuilds (disposing the old one) when compositionId changes", async () => {
    const firstBake = createFakePhysicsBakeInstance();
    const secondBake = createFakePhysicsBakeInstance();
    const createPhysicsBake = vi
      .fn()
      .mockReturnValueOnce(firstBake)
      .mockReturnValueOnce(secondBake) as unknown as ThreeRendererDependencies["createPhysicsBake"];
    const { deps } = createFakeDeps({ createPhysicsBake });
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(makeSceneState({ compositionId: "comp-1" }), makeFrameContext(1));
    renderer.renderFrame(makeSceneState({ compositionId: "comp-2" }), makeFrameContext(1));

    expect(createPhysicsBake).toHaveBeenCalledTimes(2);
    expect(firstBake.dispose).toHaveBeenCalledOnce();
  });

  it("rebuilds when seed changes, even with the same compositionId", async () => {
    const firstBake = createFakePhysicsBakeInstance();
    const secondBake = createFakePhysicsBakeInstance();
    const createPhysicsBake = vi
      .fn()
      .mockReturnValueOnce(firstBake)
      .mockReturnValueOnce(secondBake) as unknown as ThreeRendererDependencies["createPhysicsBake"];
    const { deps } = createFakeDeps({ createPhysicsBake });
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    renderer.renderFrame(
      makeSceneState(),
      createFrameContext({ frame: 1, fps: 30, durationInFrames: 90, seed: "seed-a" }),
    );
    renderer.renderFrame(
      makeSceneState(),
      createFrameContext({ frame: 1, fps: 30, durationInFrames: 90, seed: "seed-b" }),
    );

    expect(createPhysicsBake).toHaveBeenCalledTimes(2);
    expect(firstBake.dispose).toHaveBeenCalledOnce();
  });

  it("passes this composition's own physics/physicsConstraints and frame rate through to createPhysicsBake", async () => {
    const fakeBake = createFakePhysicsBakeInstance();
    const createPhysicsBake = vi.fn(() => fakeBake) as unknown as ThreeRendererDependencies["createPhysicsBake"];
    const { deps } = createFakeDeps({ createPhysicsBake });
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);

    const physics: CompositionPhysics = { gravity: [0, -20, 0], substeps: 4 };
    const physicsConstraints: PhysicsConstraintConfig[] = [
      {
        id: "joint-1",
        type: "fixed",
        bodyA: "a",
        bodyB: "b",
        anchorA: [0, 0, 0],
        anchorB: [0, 0, 0],
      },
    ];
    const sceneState = makeSceneState({ physics, physicsConstraints });

    renderer.renderFrame(sceneState, createFrameContext({ frame: 1, fps: 24, durationInFrames: 90, seed: "s" }));

    expect(createPhysicsBake).toHaveBeenCalledWith(
      sceneState.layers.map((layer) => layer.node),
      physics,
      physicsConstraints,
      24,
    );
  });

  it("dispose() disposes the physics bake", async () => {
    const fakeBake = createFakePhysicsBakeInstance();
    const createPhysicsBake = vi.fn(() => fakeBake) as unknown as ThreeRendererDependencies["createPhysicsBake"];
    const { deps } = createFakeDeps({ createPhysicsBake });
    const renderer = new ThreeRenderer(deps);
    await renderer.init(htmlCanvasLikeTarget, size);
    renderer.renderFrame(makeSceneState(), makeFrameContext());

    renderer.dispose();

    expect(fakeBake.dispose).toHaveBeenCalledOnce();
  });
});
