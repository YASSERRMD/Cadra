import {
  type CascadedShadowConfig,
  type CompositionEnvironment,
  type CompositionShadowQuality,
  computeWhiteBalanceGain,
  type ContactShadowConfig,
  type FrameContext,
  resolveExposureMultiplier,
  type SceneNode,
  type SceneState,
} from "@cadra/core";
import * as THREE from "three";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import { RectAreaLightTexturesLib } from "three/addons/lights/RectAreaLightTexturesLib.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { GroundedSkybox } from "three/addons/objects/GroundedSkybox.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ao as createGtaoNode } from "three/addons/tsl/display/GTAONode.js";
import { mrt, normalView, output, pass, vec3, vec4 } from "three/tsl";
import * as ThreeWebGPUInternals from "three/webgpu";
import {
  PMREMGenerator as WebGPUPMREMGenerator,
  RenderPipeline,
  WebGPURenderer,
  type WebGPURendererParameters,
} from "three/webgpu";

import { detectWebGpuSupport, type WebGpuDetector } from "./capability-detection.js";
import {
  createDefaultEnvironmentRegistry,
  type EnvironmentRegistry,
} from "./environment/environment-registry.js";
import { createReconciler, type Reconciler } from "./reconciler/reconciler.js";
import type {
  Renderer,
  RendererBackend,
  RendererCapabilities,
  RenderSize,
  RenderTarget,
} from "./renderer.js";
import { createContactShadowMesh } from "./shadows/contact-shadow.js";

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
  /**
   * Draws `scene` through `camera`. `ambientOcclusion`, when present,
   * routes the draw through this backend's own post-processing pipeline
   * (`EffectComposer`+`GTAOPass` for WebGL2, a TSL `RenderPipeline`+`GTAONode`
   * for WebGPU - see `withAmbientOcclusionSupport`'s own two implementations)
   * instead of a bare `renderer.render(scene, camera)` call; omitted, this
   * renders exactly as it did before Phase 57.
   */
  render: (scene: THREE.Scene, camera: THREE.Camera, ambientOcclusion?: AmbientOcclusionRenderConfig) => void;
  dispose: () => void;
  capabilities?: { maxTextureSize?: number };
  /** Set fresh every `renderFrame` call, from the composition's own resolved `colorGrading.exposureStops` - see `resolveExposureMultiplier`. */
  toneMappingExposure: number;
  /**
   * Prefilters a raw equirectangular texture (see `EnvironmentRegistry`)
   * into a PMREM environment map (a mipmap chain pre-blurred per roughness
   * level) usable as `scene.environment`/`scene.background`, via this
   * backend's own `PMREMGenerator`. Each backend has a structurally
   * different `PMREMGenerator` (classic `THREE.PMREMGenerator` needs a
   * `WebGLRenderer`; `three/webgpu`'s own needs its own `Renderer` base
   * type), so this method exists specifically so `ThreeRenderer.renderFrame`
   * never needs to know which one is actually in play - exactly the same
   * reason `toneMappingExposure` is a plain property here rather than a
   * `renderer instanceof WebGPURenderer` check at every call site.
   */
  createEnvironmentMap: (equirectangular: THREE.Texture) => THREE.Texture;
}

/**
 * Ambient occlusion tuning resolved from `AmbientOcclusionConfig` plus the
 * composition's own quality tier, passed to `ThreeRendererLike.render`.
 * `resolutionScale`/`samples` are each meaningful to only one backend's own
 * natural quality knob (see `withAmbientOcclusionSupport`'s two
 * implementations for why they differ), so both are always resolved
 * regardless of which backend is actually active - the inactive one's own
 * field is simply unused.
 */
interface AmbientOcclusionRenderConfig {
  radius: number;
  intensity: number;
  /** WebGL2 `GTAOPass` only: scales its own internal render-target resolution, independent of the main scene's resolution. Lower at the `"preview"` quality tier for speed. */
  resolutionScale: number;
  /** WebGPU `GTAONode` only: sample count per pixel. Lower at the `"preview"` quality tier for speed. */
  samples: number;
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

/**
 * Applies this renderer's own linear-color-workflow output settings,
 * identically regardless of backend: `outputColorSpace` is already
 * `THREE.SRGBColorSpace` by default in this Three.js version, set here
 * explicitly anyway (self-documenting, and robust against a future Three.js
 * version ever changing that default); `toneMapping` defaults to
 * `THREE.NoToneMapping`, which is the one setting this renderer actually
 * needs to change - without ACES filmic tone mapping, a scene's own bright
 * highlights clip harshly at 1.0 instead of rolling off smoothly, the root
 * of the "flat, washed-out" look this phase exists to fix.
 * `toneMappingExposure` is left at its own default (`1`, a no-op) here:
 * `renderFrame` sets it fresh every call, from the composition's own
 * resolved `colorGrading`.
 *
 * `shadowMap.enabled`/`.type` are Phase 55's own addition: without them, a
 * `LightNode`/`MeshNode`'s own `castShadow`/`receiveShadow` flags (see
 * `node-factory.ts`) have literally nothing to draw into, a silent no-op
 * rather than a visible shadow. `PCFSoftShadowMap` (Three.js's own built-in
 * percentage-closer-filtered soft shadow type) matches this phase's "soft
 * shadows" task without needing the cascaded/contact/SSAO machinery Phase 57
 * owns.
 */
function applyColorWorkflowDefaults(renderer: THREE.WebGLRenderer | WebGPURenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

/** Guards `ensureWebGl2AreaLightSupport`/`ensureWebGpuAreaLightSupport` so each backend's own one-time area-light setup runs at most once per process. */
let webGl2AreaLightSupportReady = false;
let webGpuAreaLightSupportReady = false;

/**
 * Enables `RectAreaLight` support for the classic `WebGLRenderer` backend.
 * Required, not optional: `RectAreaLight`'s own `@types/three` doc states
 * plainly that without this call, an area light produces no visible light at
 * all on this backend. Populates module-level static state inside Three.js
 * itself (not anything per-renderer-instance), so this only ever needs to
 * run once per process, however many `ThreeRenderer`s get constructed.
 */
function ensureWebGl2AreaLightSupport(): void {
  if (webGl2AreaLightSupportReady) {
    return;
  }
  webGl2AreaLightSupportReady = true;
  RectAreaLightUniformsLib.init();
}

/**
 * The `three/webgpu`-backend equivalent of `ensureWebGl2AreaLightSupport`
 * above, mirroring its own doc for why this is required and safe to call
 * once per process. `three/webgpu`'s own type declarations (`@types/three`
 * 0.185.0, verified directly against this project's installed version) do
 * not surface `RectAreaLightNode` as a named export, even though the
 * runtime bundle genuinely exports it (verified directly against
 * `three`'s own built `build/three.webgpu.js`, which contains it in its own
 * top-level export list) and `RectAreaLight`'s own doc names exactly this
 * call as WebGPURenderer's required setup step. This narrow, structurally
 * typed cast reaches only the one static method needed to close that
 * declaration gap; the optional-chained call is a defensive no-op (not a
 * throw) if a future Three.js version ever removes or renames this
 * undocumented-in-types export.
 */
function ensureWebGpuAreaLightSupport(): void {
  if (webGpuAreaLightSupportReady) {
    return;
  }
  webGpuAreaLightSupportReady = true;
  const webGpuInternals = ThreeWebGPUInternals as unknown as {
    RectAreaLightNode?: { setLTC(ltc: unknown): void };
  };
  webGpuInternals.RectAreaLightNode?.setLTC(RectAreaLightTexturesLib.init());
}

/**
 * Wraps `renderer` with a `createEnvironmentMap` implementation backed by
 * `pmremGenerator`, and augments `dispose` to also free the generator's own
 * GPU resources - `PMREMGenerator.dispose()` is a real, required cleanup
 * step (see its own `@types/three` doc), not covered by the underlying
 * renderer's own `dispose()` at all, since the generator is a separate
 * object this module constructs alongside the renderer, not owned by it.
 */
function withEnvironmentMapSupport(
  renderer: THREE.WebGLRenderer | WebGPURenderer,
  pmremGenerator: { fromEquirectangular(texture: THREE.Texture): { texture: THREE.Texture }; dispose(): void },
): ThreeRendererLike {
  const originalDispose = renderer.dispose.bind(renderer);
  return Object.assign(renderer, {
    createEnvironmentMap(equirectangular: THREE.Texture): THREE.Texture {
      return pmremGenerator.fromEquirectangular(equirectangular).texture;
    },
    dispose(): void {
      pmremGenerator.dispose();
      originalDispose();
    },
  });
}

/**
 * A deterministic replacement for `GTAOPass`'s own `pdNoiseTexture` (its
 * secondary Poisson-denoise stage's decorrelation texture): the pass's own
 * `_generateNoise()` seeds a `SimplexNoise` instance with no explicit
 * random-number source, which reads `Math.random()` 256 times inside
 * `SimplexNoise`'s own constructor to build its permutation table (verified
 * directly against this project's installed `three@0.185.1` source) - so a
 * fresh `GTAOPass` gets a different, unseeded texture every process run,
 * violating this codebase's own frame-determinism requirement. `GTAOPass`'s
 * *primary* AO sampling (`gtaoNoiseTexture`, a magic-square pattern) is
 * already fully deterministic and untouched by this function; only the
 * secondary denoise stage needs a fix. This mirrors
 * `environment-registry.ts`'s own "pure function of pixel index, no
 * `Math.random()`" texture-generation pattern, matching `_generateNoise()`'s
 * own exact 64x64 RGBA8 `RepeatWrapping` format so it drops in as a direct
 * replacement.
 */
function createDeterministicGtaoDenoiseTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) {
      const index = (i * size + j) * 4;
      data[index] = hashToByte(i, j, 0);
      data[index + 1] = hashToByte(i + size, j, 1);
      data[index + 2] = hashToByte(i, j + size, 2);
      data[index + 3] = hashToByte(i + size, j + size, 3);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** A pure, deterministic pseudo-random byte in `[0, 255]` from integer coordinates, the standard shader "hash from sine" trick - decorrelated enough for denoise sampling, with no external RNG or `Math.random()` at all. */
function hashToByte(x: number, y: number, channel: number): number {
  const value = Math.sin(x * 12.9898 + y * 78.233 + channel * 37.719) * 43758.5453;
  return Math.round((value - Math.floor(value)) * 255);
}

/**
 * Wraps `threeRendererLike`'s own `render` to route through a cached
 * `EffectComposer` (`RenderPass` -> `GTAOPass` -> `OutputPass`) whenever
 * `ambientOcclusion` is present, rebuilt only when the scene, camera, or
 * `resolutionScale` actually changes across calls - mirroring
 * `ThreeRenderer`'s own `cachedEnvironment` cache-on-identity-change
 * pattern. `OutputPass` is required, not optional: any offscreen
 * `WebGLRenderTarget` (which `EffectComposer`'s own intermediate buffers
 * are) makes `WebGLRenderer` silently skip both tone mapping and output
 * color-space conversion (verified directly against this project's
 * installed `three@0.185.1` source, `WebGLPrograms.js`/`WebGLRenderer.js`),
 * which would otherwise silently undo `applyColorWorkflowDefaults`'s own
 * ACES/sRGB output the moment AO is enabled.
 */
function withAmbientOcclusionSupport(
  renderer: THREE.WebGLRenderer,
  threeRendererLike: ThreeRendererLike,
): ThreeRendererLike {
  // Captured before the `Object.assign` below reassigns `threeRendererLike`'s
  // own `.render`/`.dispose` - `threeRendererLike` and (per
  // `withEnvironmentMapSupport`'s own `Object.assign(renderer, {...})`,
  // which mutates and returns the very same object) `renderer` are
  // frequently the very same object, so a method body that instead read
  // `renderer.render(...)`/`threeRendererLike.dispose()` live at call time
  // would read *itself* (verified as a real bug in both methods: each
  // infinite-recursed in this project's own real browser e2e tests,
  // `Maximum call stack size exceeded`).
  const originalRender = renderer.render.bind(renderer);
  const originalDispose = threeRendererLike.dispose.bind(threeRendererLike);
  let composer: EffectComposer | undefined;
  let gtaoPass: GTAOPass | undefined;
  let cachedScene: THREE.Scene | undefined;
  let cachedCamera: THREE.Camera | undefined;
  let cachedResolutionScale: number | undefined;

  function disposeComposer(): void {
    composer?.dispose();
    composer = undefined;
    gtaoPass = undefined;
  }

  return Object.assign(threeRendererLike, {
    render(scene: THREE.Scene, camera: THREE.Camera, ambientOcclusion?: AmbientOcclusionRenderConfig): void {
      if (ambientOcclusion === undefined) {
        disposeComposer();
        originalRender(scene, camera);
        return;
      }

      if (
        composer === undefined ||
        cachedScene !== scene ||
        cachedCamera !== camera ||
        cachedResolutionScale !== ambientOcclusion.resolutionScale
      ) {
        disposeComposer();
        const size = renderer.getSize(new THREE.Vector2());
        const width = Math.max(1, Math.round(size.x * ambientOcclusion.resolutionScale));
        const height = Math.max(1, Math.round(size.y * ambientOcclusion.resolutionScale));
        const newComposer = new EffectComposer(renderer);
        newComposer.addPass(new RenderPass(scene, camera));
        const newGtaoPass = new GTAOPass(scene, camera, width, height);
        newGtaoPass.pdNoiseTexture.dispose();
        newGtaoPass.pdNoiseTexture = createDeterministicGtaoDenoiseTexture();
        const pdMaterial = (newGtaoPass as unknown as { pdMaterial: { uniforms: { tNoise: { value: THREE.Texture } } } })
          .pdMaterial;
        pdMaterial.uniforms.tNoise.value = newGtaoPass.pdNoiseTexture;
        newComposer.addPass(newGtaoPass);
        newComposer.addPass(new OutputPass());
        composer = newComposer;
        gtaoPass = newGtaoPass;
        cachedScene = scene;
        cachedCamera = camera;
        cachedResolutionScale = ambientOcclusion.resolutionScale;
      }

      gtaoPass?.updateGtaoMaterial({ radius: ambientOcclusion.radius, scale: ambientOcclusion.intensity });
      composer.render();
    },
    dispose(): void {
      disposeComposer();
      originalDispose();
    },
  });
}

/**
 * The WebGPU-backend equivalent of `withAmbientOcclusionSupport` above,
 * mirroring its own doc for why AO routes through a cached, rebuilt-on-change
 * pipeline. Uses a TSL `RenderPipeline` (the current, non-deprecated name for
 * what `three/webgpu` briefly called `PostProcessing` before r183; using
 * `PostProcessing` here would fire a runtime `console.warn` on every
 * construction, verified directly against this project's installed
 * `three@0.185.1` source) plus `GTAONode`, per that node's own documented
 * usage pattern: a single MRT `pass(scene, camera)` producing color/normal/
 * depth texture nodes, fed into `ao(...)`, composited back over the scene
 * color. `RenderPipeline.outputColorTransform` defaults to `true`, which
 * already applies tone mapping/color-space conversion automatically (unlike
 * the WebGL2/`EffectComposer` path above, this backend needs no `OutputPass`
 * equivalent at all).
 */
function withWebGpuAmbientOcclusionSupport(
  renderer: WebGPURenderer,
  threeRendererLike: ThreeRendererLike,
): ThreeRendererLike {
  // See `withAmbientOcclusionSupport`'s own identical comment: must capture
  // the original `render`/`dispose` before `Object.assign` below reassigns
  // them, or the wrapped methods recurse into themselves.
  const originalRender = renderer.render.bind(renderer);
  const originalDispose = threeRendererLike.dispose.bind(threeRendererLike);
  let renderPipeline: RenderPipeline | undefined;
  let aoNode: ReturnType<typeof createGtaoNode> | undefined;
  let cachedScene: THREE.Scene | undefined;
  let cachedCamera: THREE.Camera | undefined;

  function disposePipeline(): void {
    renderPipeline?.dispose();
    renderPipeline = undefined;
    aoNode = undefined;
  }

  return Object.assign(threeRendererLike, {
    render(scene: THREE.Scene, camera: THREE.Camera, ambientOcclusion?: AmbientOcclusionRenderConfig): void {
      if (ambientOcclusion === undefined) {
        disposePipeline();
        originalRender(scene, camera);
        return;
      }

      if (renderPipeline === undefined || cachedScene !== scene || cachedCamera !== camera) {
        disposePipeline();
        const scenePass = pass(scene, camera);
        scenePass.setMRT(mrt({ output, normal: normalView }));
        const scenePassColor = scenePass.getTextureNode("output");
        const scenePassNormal = scenePass.getTextureNode("normal");
        const scenePassDepth = scenePass.getTextureNode("depth");
        const newAoNode = createGtaoNode(scenePassDepth, scenePassNormal, camera);
        const aoOutput = newAoNode.getTextureNode();
        const newPipeline = new RenderPipeline(renderer);
        newPipeline.outputNode = scenePassColor.mul(vec4(vec3(aoOutput.r), 1));
        renderPipeline = newPipeline;
        aoNode = newAoNode;
        cachedScene = scene;
        cachedCamera = camera;
      }

      if (aoNode !== undefined) {
        aoNode.radius.value = ambientOcclusion.radius;
        aoNode.scale.value = ambientOcclusion.intensity;
        aoNode.samples.value = ambientOcclusion.samples;
      }
      renderPipeline?.render();
    },
    dispose(): void {
      disposePipeline();
      originalDispose();
    },
  });
}

/** The real WebGPU constructor path: `three/webgpu`'s `WebGPURenderer`, canvas passed via `canvas`. */
function createRealWebGpuRenderer(target: RenderTarget, _size: RenderSize): ThreeRendererLike {
  ensureWebGpuAreaLightSupport();
  const parameters: WebGPURendererParameters = { canvas: target };
  const renderer = new WebGPURenderer(parameters);
  applyColorWorkflowDefaults(renderer);
  const withEnvironment = withEnvironmentMapSupport(renderer, new WebGPUPMREMGenerator(renderer));
  return withWebGpuAmbientOcclusionSupport(renderer, withEnvironment);
}

/** The real WebGL2 fallback path: the classic `THREE.WebGLRenderer`, also driven off `canvas`. */
function createRealWebGl2Renderer(target: RenderTarget, _size: RenderSize): ThreeRendererLike {
  ensureWebGl2AreaLightSupport();
  const renderer = new THREE.WebGLRenderer({ canvas: target });
  applyColorWorkflowDefaults(renderer);
  const withEnvironment = withEnvironmentMapSupport(renderer, new THREE.PMREMGenerator(renderer));
  return withAmbientOcclusionSupport(renderer, withEnvironment);
}

/** The dependency set a `Renderer` uses when no overrides are supplied, i.e. real Three.js. */
export const defaultThreeRendererDependencies: ThreeRendererDependencies = {
  detectWebGpuSupport,
  createWebGpuRenderer: createRealWebGpuRenderer,
  createWebGl2Renderer: createRealWebGl2Renderer,
};

/**
 * Stable id for the synthetic wrapper root `SceneNode` `renderFrame` builds
 * around a `SceneState`'s layers every call. Never collides with an authored
 * node id in practice (authored ids come from `createIdGenerator`/user
 * authoring, never this literal), and staying constant across calls is what
 * lets the reconciler recognize it as "the same node" frame to frame, so its
 * `Object3D` identity (and therefore everything parented under it) is
 * preserved rather than torn down and rebuilt.
 */
const SCENE_STATE_ROOT_ID = "__cadra_scene_state_root__";

/**
 * Wraps `sceneState.layers` in a single synthetic `group` `SceneNode` so one
 * `reconciler.reconcile` call handles every layer at once, in the same
 * stacking order `SceneState.layers` already defines. Identity transform and
 * always visible: this node exists purely for grouping, contributing no
 * visual effect of its own.
 */
function buildSceneStateRoot(sceneState: SceneState): SceneNode {
  return {
    id: SCENE_STATE_ROOT_ID,
    kind: "group",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    children: sceneState.layers.map((layer) => layer.node),
  };
}

/**
 * Applies `opacity` to every mesh material in `subtree`, mutating in place.
 * Skipped entirely for `opacity === 1` (the overwhelmingly common case, no
 * active transition): nothing to change, and every material stays exactly
 * the shared/pooled instance the mesh registry handed out.
 *
 * For `opacity !== 1`, each mesh's material is cloned before mutation rather
 * than mutated in place. This matters because `GeometryRegistry`/
 * `MaterialRegistry` deliberately pool one shared `THREE.Material` instance
 * across every node referencing the same `materialRef` (see
 * `reconciler/registries.ts` and the "shared registry resources are never
 * disposed" tests in `reconciler.test.ts`): setting `.opacity`/`.transparent`
 * directly on that shared instance would leak onto every *other* node using
 * the same `materialRef`, including ones with no active transition of their
 * own, which is exactly the corruption this clone avoids. The clone is cheap
 * and never accumulates: `applyNodeProperties` unconditionally reassigns
 * `mesh.material` back to the registry's shared instance on every
 * `reconcile()` call (see `node-factory.ts`), so each `renderFrame` starts
 * from a clean shared reference and this function's clone is simply garbage
 * after that next reconcile, not a growing leak.
 */
function applyLayerOpacity(subtree: THREE.Object3D, opacity: number): void {
  if (opacity === 1) {
    return;
  }

  subtree.traverse((object3D) => {
    if (!(object3D instanceof THREE.Mesh)) {
      return;
    }
    const materials = Array.isArray(object3D.material) ? object3D.material : [object3D.material];
    object3D.material = Array.isArray(object3D.material)
      ? materials.map((material) => cloneWithOpacity(material, opacity))
      : cloneWithOpacity(materials[0] as THREE.Material, opacity);
  });
}

/** Clones `material`, then sets `transparent`/`opacity` on the clone only. */
function cloneWithOpacity(material: THREE.Material, opacity: number): THREE.Material {
  const clone = material.clone();
  clone.transparent = true;
  clone.opacity = opacity;
  return clone;
}

/**
 * Searches `root` for a reconciled `Object3D` tagged (via `.name`, set by
 * `createThreeObject` in `node-factory.ts`) with `cameraNodeId`. Returns
 * `undefined` if `cameraNodeId` is `undefined` or no matching camera is
 * found in the current tree, leaving the caller to fall back to the
 * renderer's own default camera.
 */
function findActiveCamera(
  root: THREE.Object3D,
  cameraNodeId: string | undefined,
): THREE.Camera | undefined {
  if (cameraNodeId === undefined) {
    return undefined;
  }

  let found: THREE.Camera | undefined;
  root.traverse((object3D) => {
    if (found === undefined && object3D.name === cameraNodeId && object3D instanceof THREE.Camera) {
      found = object3D;
    }
  });
  return found;
}

/**
 * `Renderer` implementation backed by Three.js. Never exported directly:
 * the public surface is the `Renderer` interface plus `createRenderer`, so
 * construction always goes through the factory and this class name (and
 * every Three.js type it touches) stays an implementation detail.
 */
export class ThreeRenderer implements Renderer {
  private readonly deps: ThreeRendererDependencies;
  private readonly environmentRegistry: EnvironmentRegistry;
  private threeRenderer: ThreeRendererLike | undefined;
  private resolvedBackend: RendererBackend | undefined;
  private wasFallback = false;
  /**
   * The `RenderTarget` most recently passed to `init()`. Tracked purely so
   * `getDomElement` (below) can hand back the canvas a caller outside this
   * package (namely `attachTransformGizmo`, in `./gizmo/`) needs for pointer
   * event binding: `Renderer.init`'s own signature never returns it, and
   * `PreviewHandle` (`@cadra/player`) does not expose the canvas it
   * constructs either, so this is the one place that ever sees it.
   */
  private domTarget: RenderTarget | undefined;

  /**
   * One `Reconciler` for this renderer's entire lifetime, constructed once
   * and reused across every `renderFrame` call (exactly like `threeRenderer`/
   * `resolvedBackend` above): the reconciler's own incremental-update
   * guarantees (stable `Object3D` identity for an unchanged node id) only
   * hold if it is the same instance diffing against its own prior output
   * frame to frame, not a fresh one built per call.
   */
  private readonly reconciler: Reconciler = createReconciler();
  /** The one persistent Three.js scene every reconciled wrapper root is attached under. */
  private readonly scene = new THREE.Scene();
  /**
   * Fallback camera used whenever `sceneState.activeCameraNodeId` is unset or
   * does not resolve to a camera in the current reconciled tree: keeps the
   * renderer usable for scenes authored with no camera node yet, matching
   * the placeholder's original always-available default camera.
   */
  private readonly defaultCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  /**
   * The camera actually used by the most recent `renderFrame` call (either a
   * reconciled scene camera or `defaultCamera`), tracked purely for
   * `getActiveCamera` (below) to hand back a live, current `THREE.Camera` to
   * `attachTransformGizmo` without that caller needing to re-derive
   * `findActiveCamera`'s own resolution logic itself. `undefined` until the
   * first `renderFrame` call.
   */
  private lastUsedCamera: THREE.Camera | undefined;

  /**
   * The currently-applied image-based lighting environment: which
   * `envMapRef` it was prefiltered from, and the prefiltered (PMREM) result
   * itself. `undefined` when no `SceneState.environment` has been applied
   * yet, or the most recent one resolved to nothing. Re-prefiltering is
   * real GPU work (a render pass per roughness mip level), so this is
   * cached and only recomputed when `envMapRef` actually changes across
   * `renderFrame` calls - `rotation`/`intensity`/`showBackground` are pure
   * `THREE.Scene` properties applied fresh every call (see `applyEnvironment`
   * below) and never invalidate this cache on their own.
   */
  private cachedEnvironment: { ref: string; prefiltered: THREE.Texture } | undefined;
  /**
   * The grounded-skybox mesh currently added to `this.scene`, when
   * `SceneState.environment.groundProjection` is set. `undefined` when no
   * ground projection is active. Tracked so a later `renderFrame` call can
   * remove/replace it (its geometry is fixed at construction time, so a
   * changed `height`/`radius` needs a fresh instance, not a mutation).
   */
  private groundedSkybox: GroundedSkybox | undefined;
  /**
   * The cascaded shadow map currently attached to a directional light, when
   * `SceneState.shadowQuality.cascadedShadows` is set and the active
   * backend is WebGPU. `undefined` when no CSM is active. Cached and only
   * rebuilt when the target light instance or cascade/maxFar config
   * actually changes, since constructing a `CSMShadowNode` allocates its
   * own per-cascade shadow map light set.
   */
  private cachedCsm:
    | { light: THREE.DirectionalLight; node: CSMShadowNode; cascades: number; maxFar: number }
    | undefined;
  /**
   * The contact-shadow decal mesh currently added to `this.scene`, when
   * `SceneState.shadowQuality.contactShadows` is set. `undefined` when none
   * is active. Rebuilt (not mutated) whenever `groundY`/`opacity`/`radius`
   * changes, mirroring `groundedSkybox`'s own "fixed at construction time"
   * pattern.
   */
  private contactShadowMesh: THREE.Mesh | undefined;

  constructor(
    deps: ThreeRendererDependencies = defaultThreeRendererDependencies,
    environmentRegistry: EnvironmentRegistry = createDefaultEnvironmentRegistry(),
  ) {
    this.deps = deps;
    this.environmentRegistry = environmentRegistry;
    this.defaultCamera.position.set(0, 0, 5);
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
    this.domTarget = target;
  }

  renderFrame(sceneState: SceneState, frameContext: FrameContext): void {
    const renderer = this.requireInitialized();

    const colorGrading = sceneState.colorGrading;
    renderer.toneMappingExposure = resolveExposureMultiplier(colorGrading?.exposureStops ?? 0);
    const whiteBalanceGain = computeWhiteBalanceGain(
      colorGrading?.whiteBalanceTemperatureK ?? 6500,
      colorGrading?.whiteBalanceTint ?? 0,
    );

    this.applyEnvironment(renderer, sceneState.environment);
    this.applyContactShadow(sceneState.shadowQuality?.contactShadows);

    const wrapperRoot = buildSceneStateRoot(sceneState);
    const reconciled = this.reconciler.reconcile(wrapperRoot, frameContext.frame, whiteBalanceGain);
    if (reconciled === null) {
      // `buildSceneStateRoot` always returns a non-null SceneNode, so
      // `reconcile` never actually returns null here; this satisfies the
      // Reconciler interface's nullable return type without a non-null
      // assertion.
      return;
    }

    this.applyCascadedShadows(reconciled, sceneState.shadowQuality?.cascadedShadows, this.requireBackend());

    if (reconciled.parent !== this.scene) {
      // Only true on the very first call (or if the reconciler ever handed
      // back a different root instance): the reconciler preserves Object3D
      // identity for an unchanged id/kind across calls, so in steady state
      // this add() is a no-op re-parent onto the same parent it is already
      // under.
      this.scene.add(reconciled);
    }

    // wrapperRoot.children is sceneState.layers.map(layer => layer.node), in
    // the same order, so reconciled.children[i] is the layer at index i:
    // the reconciler preserves child order (see reconciler.ts's reorderAll).
    sceneState.layers.forEach((layer, index) => {
      const layerObject3D = reconciled.children[index];
      if (layerObject3D !== undefined) {
        applyLayerOpacity(layerObject3D, layer.opacity);
      }
    });

    const camera =
      findActiveCamera(reconciled, sceneState.activeCameraNodeId) ?? this.defaultCamera;
    this.lastUsedCamera = camera;
    renderer.render(this.scene, camera, this.resolveAmbientOcclusion(sceneState.shadowQuality));
  }

  /**
   * Applies (or clears) `environment` onto `this.scene`: resolves
   * `envMapRef` against `this.environmentRegistry`, prefilters it (cached;
   * see `cachedEnvironment`'s own doc), and sets `scene.environment`/
   * `.background` plus rotation/intensity every call. `environment ===
   * undefined` clears everything and disposes the cached prefiltered
   * texture - a composition with no `environment` renders exactly as it did
   * before Phase 56.
   */
  private applyEnvironment(renderer: ThreeRendererLike, environment: CompositionEnvironment | undefined): void {
    if (environment === undefined) {
      this.clearCachedEnvironment();
      this.removeGroundedSkybox();
      return;
    }

    if (this.cachedEnvironment?.ref !== environment.envMapRef) {
      const equirectangular = this.environmentRegistry.resolve(environment.envMapRef);
      this.cachedEnvironment?.prefiltered.dispose();
      this.cachedEnvironment =
        equirectangular !== undefined
          ? { ref: environment.envMapRef, prefiltered: renderer.createEnvironmentMap(equirectangular) }
          : undefined;
    }

    const prefiltered = this.cachedEnvironment?.prefiltered ?? null;
    this.scene.environment = prefiltered;
    this.scene.background = environment.showBackground ? prefiltered : null;
    this.scene.environmentRotation.set(0, environment.rotation ?? 0, 0);
    this.scene.backgroundRotation.set(0, environment.rotation ?? 0, 0);
    this.scene.environmentIntensity = environment.intensity ?? 1;
    this.scene.backgroundIntensity = environment.backgroundIntensity ?? 1;

    this.applyGroundedSkybox(environment.groundProjection, prefiltered);
  }

  /** Disposes and clears `this.cachedEnvironment`, and blanks `scene.environment`/`.background`. Safe to call when there is nothing cached (a no-op). */
  private clearCachedEnvironment(): void {
    if (this.cachedEnvironment === undefined) {
      return;
    }
    this.cachedEnvironment.prefiltered.dispose();
    this.cachedEnvironment = undefined;
    this.scene.environment = null;
    this.scene.background = null;
  }

  /**
   * Adds, replaces, or removes `this.groundedSkybox` to match `projection`.
   * A `GroundedSkybox`'s own geometry is fixed at construction time (see its
   * own constructor signature), so a changed `height`/`radius` needs a fresh
   * instance rather than a mutation - this always rebuilds when `projection`
   * is present, which is cheap relative to the PMREM prefiltering that
   * already happened to produce `prefiltered`. Positioned at `y =
   * projection.height`, `GroundedSkybox`'s own documented convention for
   * making its projected ground plane land at world Y `0` (see
   * `EnvironmentGroundProjection.height`'s own doc).
   */
  private applyGroundedSkybox(
    projection: CompositionEnvironment["groundProjection"],
    prefiltered: THREE.Texture | null,
  ): void {
    if (projection === undefined || prefiltered === null) {
      this.removeGroundedSkybox();
      return;
    }

    this.removeGroundedSkybox();
    this.groundedSkybox = new GroundedSkybox(prefiltered, projection.height, projection.radius ?? 100);
    this.groundedSkybox.position.y = projection.height;
    this.scene.add(this.groundedSkybox);
  }

  /** Removes and disposes `this.groundedSkybox`, if one is currently added. Safe to call when there is none (a no-op). */
  private removeGroundedSkybox(): void {
    if (this.groundedSkybox === undefined) {
      return;
    }
    this.scene.remove(this.groundedSkybox);
    this.groundedSkybox.geometry.dispose();
    this.groundedSkybox.material.dispose();
    this.groundedSkybox = undefined;
  }

  /**
   * Applies (or clears) cascaded shadow maps for the first directional
   * light found in `reconciled` (mirroring `findActiveCamera`'s own
   * "search the reconciled tree by traversal" pattern), when
   * `cascadedShadows` is set and `backend` is `"webgpu"`. WebGPU-only, per
   * `CascadedShadowConfig`'s own doc: on the WebGL2 fallback (or when
   * `cascadedShadows` is omitted), this always clears/no-ops, leaving
   * directional lights with the ordinary, non-cascaded soft shadow Phase 55
   * already provides.
   */
  private applyCascadedShadows(
    reconciled: THREE.Object3D,
    cascadedShadows: CascadedShadowConfig | undefined,
    backend: RendererBackend,
  ): void {
    if (cascadedShadows === undefined || backend !== "webgpu") {
      this.clearCascadedShadows();
      return;
    }

    let directionalLight: THREE.DirectionalLight | undefined;
    reconciled.traverse((object3D) => {
      if (directionalLight === undefined && object3D instanceof THREE.DirectionalLight) {
        directionalLight = object3D;
      }
    });
    if (directionalLight === undefined) {
      this.clearCascadedShadows();
      return;
    }

    const cascades = cascadedShadows.cascades ?? 4;
    const maxFar = cascadedShadows.maxFar ?? 100000;
    if (
      this.cachedCsm === undefined ||
      this.cachedCsm.light !== directionalLight ||
      this.cachedCsm.cascades !== cascades ||
      this.cachedCsm.maxFar !== maxFar
    ) {
      this.clearCascadedShadows();
      const node = new CSMShadowNode(directionalLight, { cascades, maxFar });
      // `LightShadow.shadowNode` is not declared in `@types/three@0.185.0`
      // even though `three/webgpu`'s own `AnalyticLightNode` reads it at
      // runtime to override its own default shadow node (verified directly
      // against this project's installed `three@0.185.1` source,
      // `AnalyticLightNode.js`'s own `this.light.shadow.shadowNode` read) -
      // the same class of declaration gap as Phase 55's `RectAreaLightNode`.
      // This narrow, structurally typed cast reaches only that one field.
      (directionalLight.shadow as unknown as { shadowNode: CSMShadowNode | null }).shadowNode = node;
      this.cachedCsm = { light: directionalLight, node, cascades, maxFar };
    }
  }

  /** Clears any previously-applied CSM shadow node, disposing it and detaching it from whichever light it was attached to. Safe to call when there is none (a no-op). */
  private clearCascadedShadows(): void {
    if (this.cachedCsm === undefined) {
      return;
    }
    (this.cachedCsm.light.shadow as unknown as { shadowNode: CSMShadowNode | null }).shadowNode = null;
    this.cachedCsm.node.dispose();
    this.cachedCsm = undefined;
  }

  /**
   * Adds, replaces, or removes `this.contactShadowMesh` to match
   * `contactShadows`: a soft, ground-projected decal that reads as "this
   * scene's own content touches the ground," independent of either
   * backend's own post-processing pipeline (see `createContactShadowMesh`'s
   * own doc for why this is a plain mesh, not a depth-aware technique).
   * Rebuilt (not mutated) whenever `groundY`/`opacity`/`radius` changes,
   * mirroring `applyGroundedSkybox`'s own "fixed at construction time"
   * pattern.
   */
  private applyContactShadow(contactShadows: ContactShadowConfig | undefined): void {
    if (contactShadows === undefined) {
      this.removeContactShadowMesh();
      return;
    }

    const groundY = contactShadows.groundY;
    const opacity = contactShadows.opacity ?? 0.5;
    const radius = contactShadows.radius ?? 2;
    const current = this.contactShadowMesh;
    const currentMaterial = current?.material as THREE.MeshBasicMaterial | undefined;
    const currentGeometry = current?.geometry as THREE.CircleGeometry | undefined;
    const unchanged =
      current !== undefined &&
      current.position.y === groundY &&
      currentMaterial?.opacity === opacity &&
      currentGeometry?.parameters.radius === radius;
    if (unchanged) {
      return;
    }

    this.removeContactShadowMesh();
    this.contactShadowMesh = createContactShadowMesh(groundY, opacity, radius);
    this.scene.add(this.contactShadowMesh);
  }

  /** Removes and disposes `this.contactShadowMesh`, if one is currently added. Safe to call when there is none (a no-op). The shared decal texture itself is never disposed here: it is a module-level singleton pooled across every contact-shadow mesh, exactly like `node-factory.ts`'s own pooled placeholder resources. */
  private removeContactShadowMesh(): void {
    if (this.contactShadowMesh === undefined) {
      return;
    }
    this.scene.remove(this.contactShadowMesh);
    this.contactShadowMesh.geometry.dispose();
    (this.contactShadowMesh.material as THREE.Material).dispose();
    this.contactShadowMesh = undefined;
  }

  /**
   * Resolves `shadowQuality.ambientOcclusion` (when present) into an
   * `AmbientOcclusionRenderConfig`, applying quality-tier defaults for
   * whichever backend-specific field (`resolutionScale`/`samples`) is only
   * ever read by one backend's own AO implementation - see
   * `AmbientOcclusionRenderConfig`'s own doc for why.
   */
  private resolveAmbientOcclusion(
    shadowQuality: CompositionShadowQuality | undefined,
  ): AmbientOcclusionRenderConfig | undefined {
    const ambientOcclusion = shadowQuality?.ambientOcclusion;
    if (ambientOcclusion === undefined) {
      return undefined;
    }
    const isPreview = (shadowQuality?.tier ?? "final") === "preview";
    return {
      radius: ambientOcclusion.radius ?? 1,
      intensity: ambientOcclusion.intensity ?? 1,
      resolutionScale: isPreview ? 0.5 : 1,
      samples: isPreview ? 8 : 16,
    };
  }

  resize(size: RenderSize): void {
    const renderer = this.requireInitialized();
    // `updateStyle: false`: touching `.style` would throw on an
    // OffscreenCanvas-shaped target, which has no such property.
    renderer.setSize(size.width, size.height, false);
  }

  dispose(): void {
    this.clearCachedEnvironment();
    this.removeGroundedSkybox();
    this.clearCascadedShadows();
    this.removeContactShadowMesh();
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

  /**
   * Narrow accessors added for Phase 40's viewport gizmo integration (see
   * `../gizmo/attach-transform-gizmo.ts`). Deliberately kept off the public
   * `Renderer` interface (`renderer.ts` is untouched): every other consumer
   * of `Renderer` is unaffected, and only code inside this package (which
   * already imports `ThreeRenderer` directly, e.g. `attachTransformGizmo`'s
   * `instanceof` check) can reach these at all. Each returns a real Three.js
   * type, matching this class's own established exemption (see the doc
   * comment above `ThreeRendererLike`) from the "no Three.js on anything
   * `Renderer`-shaped" rule the rest of this package's public surface
   * follows.
   */

  /**
   * Looks up the live, reconciled `THREE.Object3D` tagged with `nodeId` (via
   * `createThreeObject` in `./reconciler/node-factory.ts`, which sets
   * `Object3D.name = node.id` for every node kind, not just cameras).
   * Returns `undefined` if no such object exists in the current scene graph
   * (e.g. `nodeId` was never reconciled, or belongs to a document this
   * renderer has not yet rendered a frame for).
   */
  getObject3DByNodeId(nodeId: string): THREE.Object3D | undefined {
    return this.scene.getObjectByName(nodeId) ?? undefined;
  }

  /**
   * The camera actually used to draw the most recently rendered frame (a
   * reconciled scene camera, or this renderer's own `defaultCamera` fallback
   * if the scene has none active). `undefined` before the first
   * `renderFrame` call.
   */
  getActiveCamera(): THREE.Camera | undefined {
    return this.lastUsedCamera;
  }

  /** The one persistent Three.js scene every reconciled node is attached under, for a gizmo helper object to be added alongside. */
  getScene(): THREE.Scene {
    return this.scene;
  }

  /**
   * The canvas-like target most recently passed to `init()`, for
   * `TransformControls`'s own pointer event binding (its constructor takes
   * an `HTMLElement`). `undefined` before `init()` resolves.
   *
   * Typed as the same `RenderTarget` union `init()` itself accepts (which
   * includes a bare `OffscreenCanvas`, not an `HTMLElement`): a caller
   * needing a real `HTMLElement` specifically (as `attachTransformGizmo`
   * does) is responsible for narrowing it, since an `OffscreenCanvas` has no
   * DOM presence to bind pointer events to at all.
   */
  getDomTarget(): RenderTarget | undefined {
    return this.domTarget;
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
