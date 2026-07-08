// @vitest-environment jsdom
import {
  createFrameContext,
  createIdentityTransform,
  type MeshNode,
  type SceneState,
} from "@cadra/core";
import type * as THREE from "three";
import type { TransformControls } from "three/addons/controls/TransformControls.js";
import { describe, expect, it, vi } from "vitest";

import type { Renderer, RendererCapabilities, RenderSize, RenderTarget } from "../renderer.js";
import type { ThreeRendererDependencies, ThreeRendererFactory } from "../three-renderer.js";
import { ThreeRenderer } from "../three-renderer.js";
import { attachTransformGizmo } from "./attach-transform-gizmo.js";

/** A minimal fake standing in for a real Three.js renderer instance, matching `three-renderer.test.ts`'s own fake exactly: records calls, touches no GPU. */
function createFakeThreeRenderer() {
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

/** Builds a `ThreeRendererDependencies` set from fakes; WebGPU always reports "available". */
function createFakeDeps(): ThreeRendererDependencies {
  return {
    detectWebGpuSupport: () => true,
    createWebGpuRenderer: vi.fn(() => createFakeThreeRenderer()) as ThreeRendererFactory,
    createWebGl2Renderer: vi.fn(() => createFakeThreeRenderer()) as ThreeRendererFactory,
    initPhysics: vi.fn().mockResolvedValue(undefined),
    createPhysicsBake: vi.fn(() => ({
      advanceTo: vi.fn(() => new Map()),
      dispose: vi.fn(),
    })) as unknown as ThreeRendererDependencies["createPhysicsBake"],
  };
}

const size: RenderSize = { width: 640, height: 480 };

/** A single mesh `SceneNode`, at a known, easily-asserted transform. */
function meshNode(id: string): MeshNode {
  return {
    id,
    kind: "mesh",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    geometryRef: "box",
    materialRef: "default",
  };
}

function makeSceneState(nodeId: string): SceneState {
  return {
    compositionId: "comp-1",
    frame: 0,
    width: 640,
    height: 480,
    layers: [
      {
        compositionId: "comp-1",
        trackId: "track-1",
        clipId: "clip-1",
        node: meshNode(nodeId),
        zIndex: 0,
        localFrame: 0,
        opacity: 1,
      },
    ],
  };
}

const frameContext = createFrameContext({ frame: 0, fps: 30, durationInFrames: 90, seed: "s" });

/** Constructs and initializes a real `ThreeRenderer` (fake Three.js internals, real reconciler/scene) against a real jsdom `<canvas>`, then renders one frame containing `nodeId` so it is reconciled and a camera is resolved. */
async function createReadyThreeRenderer(nodeId: string): Promise<ThreeRenderer> {
  const renderer = new ThreeRenderer(createFakeDeps());
  const canvas = document.createElement("canvas");
  await renderer.init(canvas as unknown as RenderTarget, size);
  renderer.renderFrame(makeSceneState(nodeId), frameContext);
  return renderer;
}

/** A fake `Renderer` satisfying the public interface structurally but never `instanceof ThreeRenderer`, matching `Viewport.test.tsx`'s own fake. */
function createFakeRenderer(): Renderer {
  return {
    init: vi.fn(async (_target: RenderTarget, _size: RenderSize) => undefined),
    renderFrame: vi.fn(() => undefined),
    resize: vi.fn((_size: RenderSize) => undefined),
    dispose: vi.fn(() => undefined),
    backend: "webgl2",
    capabilities: {
      backend: "webgl2",
      isFallback: true,
      maxTextureSize: 4096,
    } as RendererCapabilities,
  };
}

describe("attachTransformGizmo: graceful no-op cases", () => {
  it("returns undefined when given a Renderer that is not a real ThreeRenderer", () => {
    const result = attachTransformGizmo({
      renderer: createFakeRenderer(),
      nodeId: "mesh-1",
      onTransformChange: vi.fn(),
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when nodeId does not resolve to any reconciled Object3D", async () => {
    const renderer = await createReadyThreeRenderer("mesh-1");

    const result = attachTransformGizmo({
      renderer,
      nodeId: "does-not-exist",
      onTransformChange: vi.fn(),
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when no frame has been rendered yet (no active camera resolved)", async () => {
    const renderer = new ThreeRenderer(createFakeDeps());
    const canvas = document.createElement("canvas");
    await renderer.init(canvas as unknown as RenderTarget, size);
    // Deliberately no renderFrame() call: getActiveCamera() has nothing yet.

    const result = attachTransformGizmo({
      renderer,
      nodeId: "mesh-1",
      onTransformChange: vi.fn(),
    });

    expect(result).toBeUndefined();
  });
});

describe("attachTransformGizmo: real attachment", () => {
  it("attaches a real TransformControls helper to the renderer's scene", async () => {
    const renderer = await createReadyThreeRenderer("mesh-1");

    const gizmo = attachTransformGizmo({
      renderer,
      nodeId: "mesh-1",
      onTransformChange: vi.fn(),
    });

    expect(gizmo).toBeDefined();
    const scene = renderer.getScene();
    // TransformControls.getHelper() is a TransformControlsRoot, tagged
    // isTransformControlsRoot: true; finding it in the scene's own children
    // proves attachTransformGizmo really constructed and added a live gizmo,
    // not merely returned a truthy stub.
    const helper = scene.children.find(
      (child) =>
        (child as unknown as { isTransformControlsRoot?: boolean }).isTransformControlsRoot,
    );
    expect(helper).toBeDefined();
  });

  it("dispose() removes the helper from the scene", async () => {
    const renderer = await createReadyThreeRenderer("mesh-1");
    const childCountBeforeAttach = renderer.getScene().children.length;

    const gizmo = attachTransformGizmo({
      renderer,
      nodeId: "mesh-1",
      onTransformChange: vi.fn(),
    });
    expect(renderer.getScene().children.length).toBe(childCountBeforeAttach + 1);

    gizmo?.dispose();

    expect(renderer.getScene().children.length).toBe(childCountBeforeAttach);
  });

  it("setMode() changes the underlying TransformControls mode without re-attaching", async () => {
    const renderer = await createReadyThreeRenderer("mesh-1");
    const gizmo = attachTransformGizmo({
      renderer,
      nodeId: "mesh-1",
      onTransformChange: vi.fn(),
      mode: "translate",
    });

    const controls = findTransformControls(renderer);
    expect(controls.getMode()).toBe("translate");

    gizmo?.setMode("rotate");

    expect(controls.getMode()).toBe("rotate");
  });
});

/** Finds the real `TransformControls` instance `attachTransformGizmo` constructed, via the helper object's own public `controls` back-reference (`TransformControlsRoot.controls`). */
function findTransformControls(renderer: ThreeRenderer): TransformControls {
  const helper = renderer
    .getScene()
    .children.find(
      (child) =>
        (child as unknown as { isTransformControlsRoot?: boolean }).isTransformControlsRoot,
    ) as unknown as { controls: TransformControls } | undefined;
  if (helper === undefined) {
    throw new Error("findTransformControls: no TransformControlsRoot found in the scene.");
  }
  return helper.controls;
}

describe("attachTransformGizmo: commits on drag release only", () => {
  it("calls onTransformChange exactly once, with the object's final transform, when dragging-changed fires false (not on true, and not on every intermediate change)", async () => {
    const renderer = await createReadyThreeRenderer("mesh-1");
    const onTransformChange = vi.fn();

    attachTransformGizmo({ renderer, nodeId: "mesh-1", onTransformChange });

    const controls = findTransformControls(renderer);
    const object3D = renderer.getObject3DByNodeId("mesh-1");
    expect(object3D).toBeDefined();

    // Simulate a real TransformControls drag: it fires "dragging-changed"
    // (value: true) on drag start, mutates the attached Object3D's
    // position/rotation/scale continuously while dragging (simulated here by
    // directly mutating the same Object3D reference, exactly what a real
    // pointer drag would end up doing to it), then fires "dragging-changed"
    // (value: false) once on release.
    controls.dispatchEvent({ type: "dragging-changed", value: true });
    expect(onTransformChange).not.toHaveBeenCalled();

    object3D?.position.set(1, 2, 3);
    object3D?.rotation.set(0.1, 0.2, 0.3);
    object3D?.scale.set(2, 2, 2);
    // Intermediate drag frames in a real gesture do not themselves fire
    // dragging-changed again (only the boolean transition does), so there is
    // nothing further to dispatch here before the release below.

    controls.dispatchEvent({ type: "dragging-changed", value: false });

    expect(onTransformChange).toHaveBeenCalledTimes(1);
    expect(onTransformChange).toHaveBeenCalledWith({
      position: [1, 2, 3],
      rotation: [expect.closeTo(0.1, 5), expect.closeTo(0.2, 5), expect.closeTo(0.3, 5)],
      scale: [2, 2, 2],
    });
  });

  it("does not call onTransformChange after dispose()", async () => {
    const renderer = await createReadyThreeRenderer("mesh-1");
    const onTransformChange = vi.fn();

    const gizmo = attachTransformGizmo({ renderer, nodeId: "mesh-1", onTransformChange });
    const controls = findTransformControls(renderer);

    gizmo?.dispose();
    controls.dispatchEvent({ type: "dragging-changed", value: false });

    expect(onTransformChange).not.toHaveBeenCalled();
  });
});
