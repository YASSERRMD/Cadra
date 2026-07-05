import type { FrameContext } from "@cadra/core";
import * as THREE from "three";
import { WebGPURenderer, type WebGPURendererParameters } from "three/webgpu";

import { detectWebGpuSupport, type WebGpuDetector } from "./capability-detection.js";
import type {
  RenderableScene,
  Renderer,
  RendererBackend,
  RendererCapabilities,
  RenderSize,
  RenderTarget,
} from "./renderer.js";

/**
 * The subset of `THREE.WebGPURenderer` / `THREE.WebGLRenderer` this module
 * actually drives. Both classes satisfy this structurally even though they
 * share no common base exported from `three` itself, which is what makes it
 * possible to swap between them (and to substitute a test spy for either)
 * behind a single internal type.
 *
 * Deliberately not exported: this is the one place a Three.js-shaped type is
 * allowed to exist, and it must never appear on `Renderer` or anything else
 * this package exports.
 */
interface ThreeRendererLike {
  init?: () => Promise<unknown>;
  setSize: (width: number, height: number, updateStyle?: boolean) => void;
  render: (scene: THREE.Scene, camera: THREE.Camera) => void;
  dispose: () => void;
  capabilities?: { maxTextureSize?: number };
}

/** Constructs the underlying Three.js renderer for a given backend and target. */
export type ThreeRendererFactory = (target: RenderTarget, size: RenderSize) => ThreeRendererLike;

/**
 * Everything about how a `Renderer` reaches into Three.js is injectable, so
 * unit tests can substitute fakes and never touch a real GPU: the WebGPU
 * availability check, and the constructors for both backends.
 */
export interface ThreeRendererDependencies {
  detectWebGpuSupport: WebGpuDetector;
  createWebGpuRenderer: ThreeRendererFactory;
  createWebGl2Renderer: ThreeRendererFactory;
}

/** The real WebGPU constructor path: `three/webgpu`'s `WebGPURenderer`, canvas passed via `canvas`. */
function createRealWebGpuRenderer(target: RenderTarget, _size: RenderSize): ThreeRendererLike {
  const parameters: WebGPURendererParameters = { canvas: target };
  return new WebGPURenderer(parameters);
}

/** The real WebGL2 fallback path: the classic `THREE.WebGLRenderer`, also driven off `canvas`. */
function createRealWebGl2Renderer(target: RenderTarget, _size: RenderSize): ThreeRendererLike {
  return new THREE.WebGLRenderer({ canvas: target });
}

/** The dependency set a `Renderer` uses when no overrides are supplied, i.e. real Three.js. */
export const defaultThreeRendererDependencies: ThreeRendererDependencies = {
  detectWebGpuSupport,
  createWebGpuRenderer: createRealWebGpuRenderer,
  createWebGl2Renderer: createRealWebGl2Renderer,
};

/** Builds the tiny internal Three.js scene for one `RenderableScene`, fresh every call. */
function buildScene(sceneState: RenderableScene): { scene: THREE.Scene; camera: THREE.Camera } {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(
    sceneState.background[0],
    sceneState.background[1],
    sceneState.background[2],
  );

  for (const primitive of sceneState.primitives) {
    const geometry =
      primitive.shape === "sphere"
        ? new THREE.SphereGeometry(1, 16, 12)
        : new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(primitive.color[0], primitive.color[1], primitive.color[2]),
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(primitive.position[0], primitive.position[1], primitive.position[2]);
    scene.add(mesh);
  }

  // A fixed default camera: framing scene content is a Phase 6 reconciler
  // concern (cameras will come from the real scene graph's CameraNode), not
  // this placeholder's.
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 0, 5);

  return { scene, camera };
}

/**
 * `Renderer` implementation backed by Three.js. Never exported directly:
 * the public surface is the `Renderer` interface plus `createRenderer`, so
 * construction always goes through the factory and this class name (and
 * every Three.js type it touches) stays an implementation detail.
 */
export class ThreeRenderer implements Renderer {
  private readonly deps: ThreeRendererDependencies;
  private threeRenderer: ThreeRendererLike | undefined;
  private resolvedBackend: RendererBackend | undefined;
  private wasFallback = false;

  constructor(deps: ThreeRendererDependencies = defaultThreeRendererDependencies) {
    this.deps = deps;
  }

  async init(target: RenderTarget, size: RenderSize): Promise<void> {
    const webGpuAvailable = this.deps.detectWebGpuSupport();

    if (webGpuAvailable) {
      const candidate = this.deps.createWebGpuRenderer(target, size);
      await candidate.init?.();
      this.threeRenderer = candidate;
      this.resolvedBackend = "webgpu";
      this.wasFallback = false;
    } else {
      this.threeRenderer = this.deps.createWebGl2Renderer(target, size);
      this.resolvedBackend = "webgl2";
      this.wasFallback = true;
    }

    this.threeRenderer.setSize(size.width, size.height, false);
  }

  renderFrame(sceneState: RenderableScene, _frameContext: FrameContext): void {
    const renderer = this.requireInitialized();
    const { scene, camera } = buildScene(sceneState);
    renderer.render(scene, camera);
  }

  resize(size: RenderSize): void {
    const renderer = this.requireInitialized();
    // `updateStyle: false`: touching `.style` would throw on an
    // OffscreenCanvas-shaped target, which has no such property.
    renderer.setSize(size.width, size.height, false);
  }

  dispose(): void {
    this.requireInitialized().dispose();
  }

  get backend(): RendererBackend {
    return this.requireBackend();
  }

  get capabilities(): RendererCapabilities {
    const renderer = this.requireInitialized();
    return {
      backend: this.requireBackend(),
      isFallback: this.wasFallback,
      maxTextureSize: renderer.capabilities?.maxTextureSize,
    };
  }

  private requireInitialized(): ThreeRendererLike {
    if (!this.threeRenderer) {
      throw new RendererNotInitializedError();
    }
    return this.threeRenderer;
  }

  private requireBackend(): RendererBackend {
    if (!this.resolvedBackend) {
      throw new RendererNotInitializedError();
    }
    return this.resolvedBackend;
  }
}

/** Thrown when a `Renderer` method other than `init` is called before `init` resolves. */
export class RendererNotInitializedError extends Error {
  constructor() {
    super("Renderer used before init() resolved.");
    this.name = "RendererNotInitializedError";
  }
}
