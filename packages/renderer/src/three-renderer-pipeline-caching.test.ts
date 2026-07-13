import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import type {
  buildWebGl2Pipeline,
  buildWebGpuPipeline,
  BuiltPipeline,
  RenderPassConfig,
} from "./post-processing/post-processing-pipeline.js";
import { applyProductionWebGl2Behavior, applyProductionWebGpuBehavior } from "./three-renderer.js";

type RenderMethod = (scene: THREE.Scene, camera: THREE.Camera, config?: RenderPassConfig) => void;

/**
 * A minimal stand-in for both `THREE.WebGLRenderer` and `three/webgpu`'s
 * `WebGPURenderer`: only the surface `applyColorWorkflowDefaults`/
 * `withEnvironmentMapSupport`/`withPostProcessingSupport`/
 * `withWebGpuPostProcessingSupport` actually touch. Real `buildWebGl2Pipeline`/
 * `buildWebGpuPipeline` are swapped out via the `buildPipeline` param both
 * `applyProductionWebGl2Behavior`/`applyProductionWebGpuBehavior` accept
 * (mirroring `ThreeRendererDependencies`'s own injectable-everything
 * philosophy), so no real GPU/canvas is ever needed here.
 */
interface FakeThreeRenderer {
  outputColorSpace: THREE.ColorSpace;
  toneMapping: THREE.ToneMapping;
  shadowMap: { enabled: boolean; type: THREE.ShadowMapType };
  render: RenderMethod;
  dispose: () => void;
  getSize: (target: THREE.Vector2) => THREE.Vector2;
  getDrawingBufferSize: (target: THREE.Vector2) => THREE.Vector2;
}

function createFakeThreeRenderer(): FakeThreeRenderer {
  return {
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.NoToneMapping,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap },
    render: vi.fn(),
    dispose: vi.fn(),
    getSize: vi.fn((target: THREE.Vector2) => target.set(1920, 1080)),
    getDrawingBufferSize: vi.fn((target: THREE.Vector2) => target.set(1920, 1080)),
  };
}

function createFakePmremGenerator(): {
  fromEquirectangular(texture: THREE.Texture): { texture: THREE.Texture };
  dispose(): void;
} {
  return {
    fromEquirectangular: vi.fn((texture: THREE.Texture) => ({ texture })),
    dispose: vi.fn(),
  };
}

/** A fake `BuiltPipeline` handle that tracks whether `dispose()` was ever called while its own `render()` was still on the call stack. */
interface TrackedFakeHandle {
  render(): void;
  dispose(): void;
  wasDisposedDuringOwnRender(): boolean;
}

/**
 * Reproduces the one behavior that actually exercises the reentrancy guard
 * under test: a real `buildWebGl2Pipeline`/`buildWebGpuPipeline` call's own
 * returned `handle.render()` drives three.js's own internal machinery (a
 * `RenderPass`/`SSAARenderPass`, or a TSL `PassNode`), which calls back into
 * the *same* renderer's own `.render(scene, camera)` mid-render - with no
 * third `config` argument at all, since vanilla three.js has no notion of
 * `RenderPassConfig`. A fake that just counted calls would never trigger
 * this nested call and would miss the bug entirely: without the guard, that
 * nested call disposes this very `handle` (via the wrapped render's "no
 * postProcessing configured" branch) *while `render()` is still executing*,
 * which is exactly what `wasDisposedDuringOwnRender()` catches.
 */
function fakeBuildPipeline(
  renderer: FakeThreeRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): BuiltPipeline<TrackedFakeHandle> {
  let disposed = false;
  let disposedDuringOwnRender = false;
  const handle: TrackedFakeHandle = {
    render(): void {
      renderer.render(scene, camera);
      if (disposed) {
        disposedDuringOwnRender = true;
      }
    },
    dispose(): void {
      disposed = true;
    },
    wasDisposedDuringOwnRender: () => disposedDuringOwnRender,
  };
  return { handle, updateFrame: vi.fn() };
}

const POST_PROCESSING_CONFIG: RenderPassConfig = {
  postProcessing: { tier: "final", effects: [{ type: "sharpen", amount: 0.5 }] },
  frame: 0,
};

describe.each([
  {
    backend: "WebGL2",
    apply: (renderer: FakeThreeRenderer, buildPipeline: unknown) =>
      applyProductionWebGl2Behavior(
        renderer as unknown as THREE.WebGLRenderer,
        createFakePmremGenerator(),
        buildPipeline as typeof buildWebGl2Pipeline,
      ),
  },
  {
    backend: "WebGPU",
    apply: (renderer: FakeThreeRenderer, buildPipeline: unknown) =>
      applyProductionWebGpuBehavior(
        renderer as unknown as Parameters<typeof applyProductionWebGpuBehavior>[0],
        createFakePmremGenerator(),
        buildPipeline as typeof buildWebGpuPipeline,
      ),
  },
])("$backend post-processing pipeline: reentrant render() no longer disposes mid-use", ({ apply }) => {
  it("never disposes a pipeline while its own render() call is still executing, across several frames", () => {
    const createdHandles: TrackedFakeHandle[] = [];
    const buildPipeline = vi.fn((r: FakeThreeRenderer, scene: THREE.Scene, camera: THREE.Camera) => {
      const built = fakeBuildPipeline(r, scene, camera);
      createdHandles.push(built.handle);
      return built;
    });

    const renderer = createFakeThreeRenderer();
    apply(renderer, buildPipeline);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();

    renderer.render(scene, camera, { ...POST_PROCESSING_CONFIG, frame: 0 });
    renderer.render(scene, camera, { ...POST_PROCESSING_CONFIG, frame: 1 });
    renderer.render(scene, camera, { ...POST_PROCESSING_CONFIG, frame: 2 });

    expect(createdHandles).toHaveLength(3);
    for (const handle of createdHandles) {
      expect(handle.wasDisposedDuringOwnRender()).toBe(false);
    }
  });

  it("builds a fresh pipeline every render call (not cached across frames - see three-renderer.ts's own doc for why)", () => {
    const buildPipeline = vi.fn((r: FakeThreeRenderer, scene: THREE.Scene, camera: THREE.Camera) =>
      fakeBuildPipeline(r, scene, camera),
    );

    const renderer = createFakeThreeRenderer();
    apply(renderer, buildPipeline);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();

    renderer.render(scene, camera, { ...POST_PROCESSING_CONFIG, frame: 0 });
    renderer.render(scene, camera, { ...POST_PROCESSING_CONFIG, frame: 1 });
    renderer.render(scene, camera, { ...POST_PROCESSING_CONFIG, frame: 2 });

    expect(buildPipeline).toHaveBeenCalledTimes(3);
  });

  it("still performs a real draw every frame via the guarded nested call", () => {
    const buildPipeline = vi.fn((r: FakeThreeRenderer, scene: THREE.Scene, camera: THREE.Camera) =>
      fakeBuildPipeline(r, scene, camera),
    );

    const renderer = createFakeThreeRenderer();
    const originalRender = renderer.render;
    apply(renderer, buildPipeline);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();

    renderer.render(scene, camera, { ...POST_PROCESSING_CONFIG, frame: 0 });
    renderer.render(scene, camera, { ...POST_PROCESSING_CONFIG, frame: 1 });
    renderer.render(scene, camera, { ...POST_PROCESSING_CONFIG, frame: 2 });

    expect(originalRender).toHaveBeenCalledTimes(3);
  });

  it("disposes the previous frame's pipeline before building the next one, not after", () => {
    const disposeOrder: string[] = [];
    let callIndex = 0;
    const buildPipeline = vi.fn((r: FakeThreeRenderer, scene: THREE.Scene, camera: THREE.Camera) => {
      const index = callIndex;
      callIndex += 1;
      const built = fakeBuildPipeline(r, scene, camera);
      const originalDispose = built.handle.dispose.bind(built.handle);
      built.handle.dispose = () => {
        disposeOrder.push(`dispose-${index}`);
        originalDispose();
      };
      return built;
    });

    const renderer = createFakeThreeRenderer();
    apply(renderer, buildPipeline);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();

    disposeOrder.push("build-0");
    renderer.render(scene, camera, { ...POST_PROCESSING_CONFIG, frame: 0 });
    disposeOrder.push("build-1");
    renderer.render(scene, camera, { ...POST_PROCESSING_CONFIG, frame: 1 });

    expect(disposeOrder).toEqual(["build-0", "build-1", "dispose-0"]);
  });
});
