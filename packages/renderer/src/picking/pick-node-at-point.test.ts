// @vitest-environment jsdom
import {
  createFrameContext,
  createIdentityTransform,
  type MeshNode,
  type SceneState,
} from "@cadra/core";
import type * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import { attachTransformGizmo } from "../gizmo/attach-transform-gizmo.js";
import type { Renderer, RendererCapabilities, RenderSize, RenderTarget } from "../renderer.js";
import type { ThreeRendererDependencies, ThreeRendererFactory } from "../three-renderer.js";
import { ThreeRenderer } from "../three-renderer.js";
import { pickNodeAtPoint } from "./pick-node-at-point.js";

/** A minimal fake standing in for a real Three.js renderer instance, matching `three-renderer.test.ts`'s own fake exactly. */
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

/** A single mesh `SceneNode` at the world origin (the identity transform's own position), directly in the camera's line of sight for the default camera below. */
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

/**
 * Constructs a real `ThreeRenderer` (fake Three.js internals) and renders one
 * frame containing a mesh at the world origin. `ThreeRenderer`'s own
 * `defaultCamera` sits at `(0, 0, 5)` looking toward the origin (see
 * `three-renderer.ts`), so a ray cast straight through NDC `(0, 0)` (dead
 * center of the view) genuinely intersects this mesh's real geometry: this
 * is real Three.js raycast math running against a real camera/mesh, not a
 * mocked "did hit" boolean.
 */
async function createReadyThreeRenderer(nodeId: string): Promise<ThreeRenderer> {
  const renderer = new ThreeRenderer(createFakeDeps());
  const canvas = document.createElement("canvas");
  await renderer.init(canvas as unknown as RenderTarget, size);
  renderer.renderFrame(makeSceneState(nodeId), frameContext);
  return renderer;
}

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

describe("pickNodeAtPoint: graceful no-op cases", () => {
  it("returns undefined when given a Renderer that is not a real ThreeRenderer", () => {
    const result = pickNodeAtPoint({ renderer: createFakeRenderer(), point: { x: 0, y: 0 } });

    expect(result).toBeUndefined();
  });

  it("returns undefined when no frame has been rendered yet (no active camera resolved)", async () => {
    const renderer = new ThreeRenderer(createFakeDeps());
    const canvas = document.createElement("canvas");
    await renderer.init(canvas as unknown as RenderTarget, size);

    const result = pickNodeAtPoint({ renderer, point: { x: 0, y: 0 } });

    expect(result).toBeUndefined();
  });

  it("returns undefined when the ray hits nothing (pointing off into empty space)", async () => {
    const renderer = await createReadyThreeRenderer("mesh-1");

    // Far corner of NDC space: the mesh sits dead center, so this misses it entirely.
    const result = pickNodeAtPoint({ renderer, point: { x: 0.99, y: 0.99 } });

    expect(result).toBeUndefined();
  });
});

describe("pickNodeAtPoint: real raycast hits", () => {
  it("returns the SceneNode id of a mesh genuinely hit by the ray", async () => {
    const renderer = await createReadyThreeRenderer("mesh-1");

    const result = pickNodeAtPoint({ renderer, point: { x: 0, y: 0 } });

    expect(result).toBe("mesh-1");
  });

  it("returns undefined (not a gizmo handle name) when a TransformControls gizmo is attached and its helper sits in the scene, clicking the actual mesh still resolves to the mesh's own id", async () => {
    const renderer = await createReadyThreeRenderer("mesh-1");
    // Attaching a gizmo adds TransformControlsRoot as a sibling scene child;
    // this proves pickNodeAtPoint's own exclusion of it does not accidentally
    // also exclude the real mesh it sits beside.
    const gizmo = attachTransformGizmo({
      renderer,
      nodeId: "mesh-1",
      onTransformChange: vi.fn(),
    });
    expect(gizmo).toBeDefined();

    const result = pickNodeAtPoint({ renderer, point: { x: 0, y: 0 } });

    expect(result).toBe("mesh-1");
  });

  it("never resolves to the synthetic scene-state wrapper root id", async () => {
    const renderer = await createReadyThreeRenderer("mesh-1");

    const result = pickNodeAtPoint({ renderer, point: { x: 0, y: 0 } });

    expect(result).not.toBe("__cadra_scene_state_root__");
  });
});
