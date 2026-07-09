import type { CompositionPostProcessing, PostEffectConfig, RenderQualityTier } from "@cadra/core";
import * as THREE from "three";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { LUTPass } from "three/addons/postprocessing/LUTPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import type { Pass } from "three/addons/postprocessing/Pass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SSAARenderPass } from "three/addons/postprocessing/SSAARenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { FilmShader } from "three/addons/shaders/FilmShader.js";
import { RGBShiftShader } from "three/addons/shaders/RGBShiftShader.js";
import { VignetteShader } from "three/addons/shaders/VignetteShader.js";
import { bloom as createBloomNode } from "three/addons/tsl/display/BloomNode.js";
import { chromaticAberration as createChromaticAberrationNode } from "three/addons/tsl/display/ChromaticAberrationNode.js";
import { dof as createDofNode } from "three/addons/tsl/display/DepthOfFieldNode.js";
import { godrays as createGodRaysNode } from "three/addons/tsl/display/GodraysNode.js";
import { ao as createGtaoNode } from "three/addons/tsl/display/GTAONode.js";
import { lut3D as createLut3DNode } from "three/addons/tsl/display/Lut3DNode.js";
import { motionBlur as createMotionBlurNode } from "three/addons/tsl/display/MotionBlur.js";
import { ssaaPass } from "three/addons/tsl/display/SSAAPassNode.js";
import {
  clamp,
  convertToTexture,
  float,
  fract,
  int,
  mix,
  mrt,
  normalView,
  output,
  pass,
  rand,
  texture,
  textureSize,
  toneMappingExposure,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  velocity,
} from "three/tsl";
import { RenderPipeline, type WebGPURenderer } from "three/webgpu";

import { ColorGradeShader, updateColorGradeUniforms } from "./color-grade.js";
import { computeFilmGrainSeed } from "./film-grain.js";
import { computeMotionBlurVelocityScale } from "./motion-blur.js";
import { computeSharpenKernelWeights, SharpenShader, updateSharpenUniforms } from "./sharpen.js";
import { resolveSampleCountForTier, resolveSampleLevel } from "./temporal-accumulation.js";
import type { AnyTslNode } from "./tsl-node.js";

/**
 * Ambient occlusion tuning resolved from `AmbientOcclusionConfig` plus the
 * composition's own quality tier, consumed by `buildWebGl2Pipeline`/
 * `buildWebGpuPipeline` below. Moved here from `three-renderer.ts` in
 * Phase 58 (previously private to that file's own `withAmbientOcclusionSupport`/
 * `withWebGpuAmbientOcclusionSupport`): both AO and the generic
 * post-processing stack this phase adds now share one composer/pipeline
 * (see `RenderPassConfig`'s own doc for why they cannot stay on two
 * independent ones), so both need to live where that shared composer is
 * built.
 */
export interface AmbientOcclusionRenderConfig {
  radius: number;
  intensity: number;
  /** WebGL2 `GTAOPass` only: scales its own internal render-target resolution, independent of the main scene's resolution. Lower at the `"preview"` quality tier for speed. */
  resolutionScale: number;
  /** WebGPU `GTAONode` only: sample count per pixel. Lower at the `"preview"` quality tier for speed. */
  samples: number;
}

/** Fully resolved, render-ready post-processing config for one `renderFrame` call, produced by `resolvePostProcessing`. */
export interface PostProcessingRenderConfig {
  /** Trades render cost against fidelity. Not read by any effect Phase 58/59 ship (none has a tier-sensitive knob yet); does drive `sampleCount`'s own tier-capping (see `resolveSampleCountForTier`). */
  tier: RenderQualityTier;
  effects: PostEffectConfig[];
  /** Resolved accumulation sample count (see `resolveSampleCountForTier`), or `undefined` for no accumulation at all - a single, un-jittered sample, byte-identical to the pre-Phase-61 render path. */
  sampleCount?: number;
}

/**
 * Everything a `ThreeRendererLike.render` call might need beyond `scene`/
 * `camera`. `ambientOcclusion`/`postProcessing` must reach the very same
 * composer/pipeline construction (see `buildWebGl2Pipeline`/
 * `buildWebGpuPipeline`): ambient occlusion darkens the scene's own
 * linear-HDR color before tone mapping, exactly where a `postProcessing`
 * effect's own `"preTonemap"` stage runs, so splitting them across two
 * independently-`RenderPass`-ing composers would either silently drop one or
 * double-render the scene. `frame` is deliberately excluded from
 * `withPostProcessingSupport`/`withWebGpuPostProcessingSupport`'s own cache
 * key (see `renderPassConfigKey`): it changes every call by construction,
 * and only ever drives a handful of already-built passes' own per-frame
 * uniforms (currently: film grain's seed) via each built pipeline's own
 * `updateFrame`, never a full composer/pipeline rebuild. `resolveLut`
 * resolves a `LutEffectConfig.lutRef` to its own real `THREE.Data3DTexture`
 * (see `LutRegistry` in `../lut/lut-registry.ts`): resolution itself can
 * involve real file I/O (a real `.cube` file), so it always happens ahead of
 * time in `ThreeRenderer`, never synchronously inside pipeline construction;
 * this is purely the already-resolved lookup function.
 */
export interface RenderPassConfig {
  ambientOcclusion?: AmbientOcclusionRenderConfig;
  postProcessing?: PostProcessingRenderConfig;
  frame: number;
  resolveLut?: (ref: string) => THREE.Data3DTexture | undefined;
}

/**
 * A built composer/pipeline (`handle`) plus `updateFrame`: re-applies this
 * frame's own frame-dependent effect parameters (currently: film grain's
 * seed, from `computeFilmGrainSeed`) onto whichever already-built passes/
 * nodes need them. Called every render, whether or not `handle` was just
 * freshly built this call - mirrors `GTAOPass.updateGtaoMaterial` being
 * called unconditionally every frame in Phase 57's own AO wrapper, for the
 * same reason: cheap per-frame uniform updates should never force a full,
 * expensive pipeline rebuild.
 */
export interface BuiltPipeline<Handle> {
  handle: Handle;
  updateFrame: (frame: number) => void;
}

/**
 * Resolves a `Composition`'s own `postProcessing` into a
 * `PostProcessingRenderConfig`, or `undefined` for a no-op stack (mirrors
 * `Composition.postProcessing`'s own doc: omitted, or both `effects: []` and
 * no meaningful `sampleCount`, must render byte-identical to no
 * post-processing pipeline at all). `sampleCount` alone, with an empty
 * `effects`, is not a no-op: accumulation is valuable purely for
 * anti-aliasing, independent of whether any other effect is configured.
 */
export function resolvePostProcessing(
  postProcessing: CompositionPostProcessing | undefined,
): PostProcessingRenderConfig | undefined {
  if (postProcessing === undefined) {
    return undefined;
  }

  const authoredSampleCount = postProcessing.sampleCount;
  if (postProcessing.effects.length === 0 && (authoredSampleCount === undefined || authoredSampleCount <= 1)) {
    return undefined;
  }

  const tier = postProcessing.tier ?? "final";
  return {
    tier,
    effects: postProcessing.effects,
    ...(authoredSampleCount !== undefined &&
      authoredSampleCount > 1 && { sampleCount: resolveSampleCountForTier(authoredSampleCount, tier) }),
  };
}

/**
 * True for a `PostEffectConfig` whose own pass must run before tone mapping,
 * on linear scene-referred HDR data (an inherent property of the effect
 * type, not authorable - see `PostEffectConfig`'s own doc for why). `bloom`
 * and `depthOfField` need that HDR headroom to extract/blur bright
 * highlights correctly; every other effect is a display-referred lens/sensor
 * artifact applied to the final image an audience actually sees.
 */
function isPreTonemapEffect(effect: PostEffectConfig): boolean {
  switch (effect.type) {
    case "bloom":
    case "depthOfField":
    case "motionBlur":
    case "godRays":
      return true;
    case "sharpen":
    case "chromaticAberration":
    case "vignette":
    case "filmGrain":
    case "lensDistortion":
    case "colorGrade":
    case "lut":
      return false;
  }
}

/** Partitions `effects` into its pre-tonemap and post-tonemap halves, each keeping its own relative order (see `CompositionPostProcessing.effects`'s own doc). */
function partitionEffectsByStage(effects: readonly PostEffectConfig[]): {
  preTonemap: PostEffectConfig[];
  postTonemap: PostEffectConfig[];
} {
  return {
    preTonemap: effects.filter(isPreTonemapEffect),
    postTonemap: effects.filter((effect) => !isPreTonemapEffect(effect)),
  };
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
 * replacement. Moved here from `three-renderer.ts` in Phase 58, alongside
 * the `AmbientOcclusionRenderConfig` it serves.
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

/** Constructs a `GTAOPass` with a deterministic denoise texture and this frame's own radius/intensity, shared by `buildWebGl2Pipeline` (the AO-only path moved here from `three-renderer.ts`, and the combined AO-plus-post-processing path). */
function buildGtaoPass(
  scene: THREE.Scene,
  camera: THREE.Camera,
  width: number,
  height: number,
  config: AmbientOcclusionRenderConfig,
): GTAOPass {
  const gtaoPass = new GTAOPass(scene, camera, width, height);
  gtaoPass.pdNoiseTexture.dispose();
  gtaoPass.pdNoiseTexture = createDeterministicGtaoDenoiseTexture();
  const pdMaterial = (gtaoPass as unknown as { pdMaterial: { uniforms: { tNoise: { value: THREE.Texture } } } })
    .pdMaterial;
  pdMaterial.uniforms.tNoise.value = gtaoPass.pdNoiseTexture;
  gtaoPass.updateGtaoMaterial({ radius: config.radius, scale: config.intensity });
  return gtaoPass;
}

/**
 * A hand-written lens distortion shader: warps `tDiffuse` radially from the
 * frame's own center by `amount` (barrel for positive, pincushion for
 * negative). Not bundled by three.js under any name, unlike bloom/depth of
 * field/chromatic aberration/vignette/film grain, all of which reuse a real,
 * tested three.js pass or node instead of hand-written math (see
 * `buildWebGl2EffectPass`/`applyWebGpuEffect`).
 */
const LensDistortionShader = {
  name: "LensDistortionShader",
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    amount: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float amount;
    varying vec2 vUv;

    void main() {
      vec2 centered = vUv - vec2(0.5);
      float r2 = dot(centered, centered);
      vec2 distortedUv = vec2(0.5) + centered * (1.0 + amount * r2);
      gl_FragColor = texture2D(tDiffuse, distortedUv);
    }
  `,
};

/**
 * Builds one `Pass` for `effect`, sized to the composer's own current pixel
 * dimensions, or `undefined` for an effect with no WebGL2 implementation
 * (currently: `motionBlur`, WebGPU-backend only - see
 * `MotionBlurEffectConfig`'s own doc for why). `scene`/`camera` are needed by
 * `depthOfField` (`BokehPass` renders its own internal depth pass from
 * them); `registerFrameUpdate` is called, at most once, by any effect whose
 * own uniforms depend on the current frame (currently: `filmGrain`'s seed,
 * from `computeFilmGrainSeed`) - see `BuiltPipeline.updateFrame`'s own doc
 * for why this is a callback rather than a full rebuild.
 */
function buildWebGl2EffectPass(
  effect: PostEffectConfig,
  scene: THREE.Scene,
  camera: THREE.Camera,
  width: number,
  height: number,
  registerFrameUpdate: (update: (frame: number) => void) => void,
  resolveLut: (ref: string) => THREE.Data3DTexture | undefined,
): Pass | undefined {
  switch (effect.type) {
    case "sharpen": {
      const shaderPass = new ShaderPass(SharpenShader);
      updateSharpenUniforms(shaderPass.material, effect.amount ?? 0.5, width, height);
      return shaderPass;
    }
    case "bloom": {
      const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        effect.intensity ?? 1,
        effect.radius ?? 0.4,
        effect.threshold ?? 0.85,
      );
      return bloomPass;
    }
    case "depthOfField": {
      return new BokehPass(scene, camera, {
        focus: effect.focusDistance ?? 10,
        aperture: effect.aperture ?? 0.025,
        maxblur: effect.maxBlur ?? 1,
      });
    }
    case "chromaticAberration": {
      const shaderPass = new ShaderPass(RGBShiftShader);
      const uniforms = shaderPass.material.uniforms as typeof RGBShiftShader.uniforms;
      uniforms.amount.value = (effect.intensity ?? 0.5) * 0.01;
      uniforms.angle.value = 0;
      return shaderPass;
    }
    case "vignette": {
      const shaderPass = new ShaderPass(VignetteShader);
      const uniforms = shaderPass.material.uniforms as typeof VignetteShader.uniforms;
      uniforms.darkness.value = effect.darkness ?? 1;
      uniforms.offset.value = effect.offset ?? 1;
      return shaderPass;
    }
    case "filmGrain": {
      const shaderPass = new ShaderPass(FilmShader);
      const uniforms = shaderPass.material.uniforms as typeof FilmShader.uniforms;
      uniforms.intensity.value = effect.intensity ?? 0.35;
      uniforms.grayscale.value = false;
      registerFrameUpdate((frame) => {
        uniforms.time.value = computeFilmGrainSeed(frame);
      });
      return shaderPass;
    }
    case "lensDistortion": {
      const shaderPass = new ShaderPass(LensDistortionShader);
      const uniforms = shaderPass.material.uniforms as typeof LensDistortionShader.uniforms;
      uniforms.amount.value = effect.amount ?? 0;
      return shaderPass;
    }
    case "motionBlur": {
      return undefined;
    }
    case "godRays": {
      return undefined;
    }
    case "colorGrade": {
      const shaderPass = new ShaderPass(ColorGradeShader);
      updateColorGradeUniforms(
        shaderPass.material,
        effect.lift ?? [0, 0, 0],
        effect.gamma ?? [1, 1, 1],
        effect.gain ?? [1, 1, 1],
        effect.saturation ?? 1,
        effect.contrast ?? 1,
      );
      return shaderPass;
    }
    case "lut": {
      const lutTexture = resolveLut(effect.lutRef);
      if (lutTexture === undefined) {
        return undefined;
      }
      const lutPass = new LUTPass({ lut: lutTexture, intensity: effect.intensity ?? 1 });
      return lutPass;
    }
  }
}

/**
 * Builds the one shared `EffectComposer` chain for the WebGL2 backend:
 * `RenderPass` (linear HDR; `EffectComposer`'s own default internal buffers
 * are already `HalfFloatType`, per this project's installed
 * `three@0.185.1` source), or `SSAARenderPass` in its exact place when
 * `postProcessing.sampleCount` calls for accumulation (a real, deterministic
 * drop-in replacement: same `(scene, camera)` constructor, same "produces
 * one linear-HDR frame in the composer's buffers" contract, re-rendering the
 * scene `2^sampleLevel` times through a fixed, non-random jitter-vector
 * table - verified directly against this project's installed
 * `three@0.185.1` source - and averaging) -> `GTAOPass` if
 * `ambientOcclusion` is set -> pre-tonemap effect passes -> `OutputPass`
 * (applies `renderer.toneMapping` and `renderer.outputColorSpace` together,
 * reading them fresh every `render()` call per `OutputPass`'s own source) ->
 * post-tonemap effect passes. `EffectComposer` tracks which of its own
 * passes is last and renders only that one to screen automatically
 * (verified directly against this project's installed `three@0.185.1`
 * source, `isLastEnabledPass`/`addPass`), so nothing here ever sets
 * `renderToScreen` itself.
 */
export function buildWebGl2Pipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  width: number,
  height: number,
  config: RenderPassConfig,
): BuiltPipeline<EffectComposer> {
  const composer = new EffectComposer(renderer);
  const sampleCount = config.postProcessing?.sampleCount;
  if (sampleCount !== undefined) {
    const ssaaRenderPass = new SSAARenderPass(scene, camera);
    ssaaRenderPass.sampleLevel = resolveSampleLevel(sampleCount);
    composer.addPass(ssaaRenderPass);
  } else {
    composer.addPass(new RenderPass(scene, camera));
  }

  if (config.ambientOcclusion !== undefined) {
    const ao = config.ambientOcclusion;
    const aoWidth = Math.max(1, Math.round(width * ao.resolutionScale));
    const aoHeight = Math.max(1, Math.round(height * ao.resolutionScale));
    composer.addPass(buildGtaoPass(scene, camera, aoWidth, aoHeight, ao));
  }

  const frameUpdates: Array<(frame: number) => void> = [];
  const registerFrameUpdate = (update: (frame: number) => void): void => {
    frameUpdates.push(update);
  };
  const resolveLut = config.resolveLut ?? ((): undefined => undefined);

  const { preTonemap, postTonemap } = partitionEffectsByStage(config.postProcessing?.effects ?? []);
  for (const effect of preTonemap) {
    const effectPass = buildWebGl2EffectPass(effect, scene, camera, width, height, registerFrameUpdate, resolveLut);
    if (effectPass !== undefined) {
      composer.addPass(effectPass);
    }
  }

  composer.addPass(new OutputPass());

  for (const effect of postTonemap) {
    const effectPass = buildWebGl2EffectPass(effect, scene, camera, width, height, registerFrameUpdate, resolveLut);
    if (effectPass !== undefined) {
      composer.addPass(effectPass);
    }
  }

  return {
    handle: composer,
    updateFrame(frame: number): void {
      for (const update of frameUpdates) {
        update(frame);
      }
    },
  };
}

/**
 * The WebGPU/TSL equivalent of `buildWebGl2Pipeline`: builds one linear-HDR
 * node graph from a single `pass(scene, camera)`, applies AO (if configured)
 * and every pre-tonemap effect while still in linear working color space,
 * then tone maps and converts to `renderer.outputColorSpace` explicitly via
 * the same `toneMapping`/`workingToColorSpace` chained node methods
 * `RenderOutputNode`'s own `setup()` uses internally (verified directly
 * against this project's installed `three@0.185.1` source), and finally
 * applies every post-tonemap effect - deliberately mirroring
 * `buildWebGl2Pipeline`'s own pre/post-`OutputPass` split so a given
 * `PostEffectConfig` operates on the same kind of data (pre-tonemap: linear
 * HDR; post-tonemap: display-referred) on both backends.
 */
export function buildWebGpuPipeline(
  renderer: WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  config: RenderPassConfig,
): BuiltPipeline<RenderPipeline> {
  const effects = config.postProcessing?.effects ?? [];
  const hasMotionBlur = effects.some((effect) => effect.type === "motionBlur");
  const sampleCount = config.postProcessing?.sampleCount;

  // ssaaPass is a real, drop-in PassNode subclass (see buildWebGl2Pipeline's
  // own doc for the identical WebGL2-side swap and why it is safe): every
  // .setMRT()/.getTextureNode()/.getViewZNode() call below keeps working
  // unchanged, it just re-renders through a fixed, deterministic jitter
  // pattern 2^sampleLevel times and averages, instead of once.
  const scenePass: AnyTslNode = sampleCount !== undefined ? ssaaPass(scene, camera) : pass(scene, camera);
  if (sampleCount !== undefined) {
    scenePass.sampleLevel = resolveSampleLevel(sampleCount);
  }

  if (config.ambientOcclusion !== undefined && hasMotionBlur) {
    scenePass.setMRT(mrt({ output, normal: normalView, velocity }));
  } else if (config.ambientOcclusion !== undefined) {
    scenePass.setMRT(mrt({ output, normal: normalView }));
  } else if (hasMotionBlur) {
    scenePass.setMRT(mrt({ output, velocity }));
  }

  let node: AnyTslNode = scenePass.getTextureNode("output");

  if (config.ambientOcclusion !== undefined) {
    const ao = config.ambientOcclusion;
    const scenePassNormal = scenePass.getTextureNode("normal");
    const scenePassDepth = scenePass.getTextureNode("depth");
    const aoNode = createGtaoNode(scenePassDepth, scenePassNormal, camera);
    aoNode.radius.value = ao.radius;
    aoNode.scale.value = ao.intensity;
    aoNode.samples.value = ao.samples;
    const aoOutput = aoNode.getTextureNode();
    node = node.mul(vec4(vec3(aoOutput.r), 1));
  }

  const frameUpdates: Array<(frame: number) => void> = [];
  const registerFrameUpdate = (update: (frame: number) => void): void => {
    frameUpdates.push(update);
  };
  const resolveLut = config.resolveLut ?? ((): undefined => undefined);

  const { preTonemap, postTonemap } = partitionEffectsByStage(effects);

  for (const effect of preTonemap) {
    node = applyWebGpuEffect(node, effect, scenePass, camera, scene, registerFrameUpdate, resolveLut);
  }

  // Mirrors RenderOutputNode's own setup() guard (verified directly against
  // this project's installed three@0.185.1 source): skip a NoToneMapping/
  // NoColorSpace conversion entirely rather than calling .toneMapping()/
  // .workingToColorSpace() with it, since ToneMappingNode's own switch has no
  // NoToneMapping case and would otherwise hit its "Unsupported Tone Mapping
  // configuration" error branch.
  if (renderer.toneMapping !== THREE.NoToneMapping) {
    node = node.toneMapping(renderer.toneMapping, toneMappingExposure);
  }
  if (renderer.outputColorSpace !== THREE.NoColorSpace) {
    node = node.workingToColorSpace(renderer.outputColorSpace);
  }

  for (const effect of postTonemap) {
    node = applyWebGpuEffect(node, effect, scenePass, camera, scene, registerFrameUpdate, resolveLut);
  }

  const renderPipeline = new RenderPipeline(renderer);
  // Set before assigning outputNode, matching RenderOutputNode's own
  // documented usage example: this function already applied tone mapping
  // and color space conversion manually above, so RenderPipeline's own
  // automatic outputColorTransform step must be turned off, or the two
  // would compose and double-apply both.
  renderPipeline.outputColorTransform = false;
  renderPipeline.outputNode = node;

  return {
    handle: renderPipeline,
    updateFrame(frame: number): void {
      for (const update of frameUpdates) {
        update(frame);
      }
    },
  };
}

/**
 * Applies one `PostEffectConfig` to `colorTexture`, returning the new node.
 * Typed via `AnyTslNode` (see that type's own doc): every real TSL node
 * this touches - a scene-pass texture, a `.mul()`/`.sample()` result, ... -
 * is the same proxy-wrapped object at runtime regardless of which narrow,
 * mutually incompatible declared subtype `@types/three@0.185.0` happens to
 * assign it. `scenePass` is needed by `depthOfField` (for its own
 * `getViewZNode()`); `camera` is needed by `depthOfField`'s near/far
 * implied by that same view-space depth; `scene` is needed by `godRays` to
 * resolve `GodRaysEffectConfig.lightNodeId` back to the reconciled
 * `THREE.Light` via `getObjectByName` (mirrors this codebase's existing
 * `object3D.name = node.id` convention, used unchanged here rather than
 * inventing a second lookup mechanism); `registerFrameUpdate` is called, at
 * most once, by any effect whose own uniforms depend on the current frame
 * (currently: `filmGrain`'s seed) - see `BuiltPipeline.updateFrame`'s own
 * doc for why.
 */
function applyWebGpuEffect(
  colorTexture: AnyTslNode,
  effect: PostEffectConfig,
  scenePass: AnyTslNode,
  camera: THREE.Camera,
  scene: THREE.Scene,
  registerFrameUpdate: (update: (frame: number) => void) => void,
  resolveLut: (ref: string) => THREE.Data3DTexture | undefined,
): AnyTslNode {
  switch (effect.type) {
    case "sharpen": {
      // colorTexture is only guaranteed sampleable-at-an-arbitrary-UV when it
      // is the very first thing reading the raw scene pass (a genuine
      // TextureNode). Once anything upstream - tone mapping, color space
      // conversion, or an earlier effect in this same stage - has run, it is
      // a plain computed value node with no .sample() of its own at all
      // (confirmed as a real bug via this project's own real-browser e2e
      // test, `render-composition-headless-server.e2e.test.ts`'s
      // post-processing case: "colorTexture.sample is not a function").
      // convertToTexture (the same helper DepthOfFieldNode's own factory
      // uses for its own input) is a no-op when colorTexture is already a
      // real texture node, and otherwise bakes it into one via an internal
      // render-to-texture pass - see this project's installed
      // three@0.185.1 source, RTTNode.js.
      const sampleable = convertToTexture(colorTexture);
      const { centerWeight, neighborWeight } = computeSharpenKernelWeights(effect.amount ?? 0.5);
      const size: AnyTslNode = textureSize(sampleable, int(0));
      const texel = vec2(1, 1).div(size);
      const center = sampleable.sample(uv());
      const top = sampleable.sample(uv().add(vec2(0, texel.y)));
      const bottom = sampleable.sample(uv().sub(vec2(0, texel.y)));
      const left = sampleable.sample(uv().sub(vec2(texel.x, 0)));
      const right = sampleable.sample(uv().add(vec2(texel.x, 0)));
      const neighborSum = top.add(bottom).add(left).add(right);
      return center.mul(float(centerWeight)).sub(neighborSum.mul(float(neighborWeight)));
    }
    case "bloom": {
      const bloomNode = createBloomNode(
        colorTexture,
        effect.intensity ?? 1,
        effect.radius ?? 0.4,
        effect.threshold ?? 0.85,
      );
      return colorTexture.add(bloomNode);
    }
    case "depthOfField": {
      const viewZNode: AnyTslNode = scenePass.getViewZNode();
      return createDofNode(
        colorTexture,
        viewZNode,
        effect.focusDistance ?? 10,
        (effect.aperture ?? 0.025) * 40,
        effect.maxBlur ?? 1,
      );
    }
    case "chromaticAberration": {
      // `center` must be passed explicitly: three.js's own ChromaticAberrationNode
      // (three/addons/tsl/display/ChromaticAberrationNode.js) documents its
      // default (`center = null`) as "uses screen center (0.5, 0.5)", but
      // `ShaderNodeObject`/`nodeObject` never actually substitutes a real
      // vec2 node for a literal `null` - it passes `null` straight through
      // into the compiled shader's `uv.sub(center)`, which produces a fully
      // degenerate (solid black) output. Verified directly: this addon call
      // with only two arguments renders solid black through both this
      // package's drivers; passing `vec2(0.5, 0.5)` explicitly here (the
      // same screen-center convention already used by this file's own
      // "vignette"/"lensDistortion" cases) works correctly.
      return createChromaticAberrationNode(colorTexture, float((effect.intensity ?? 0.5) * 0.01), vec2(0.5, 0.5));
    }
    case "vignette": {
      const darkness = effect.darkness ?? 1;
      const offset = effect.offset ?? 1;
      const centered = uv().sub(vec2(0.5, 0.5)).mul(float(offset));
      const falloff = centered.dot(centered);
      const target = vec3(1, 1, 1).sub(vec3(darkness, darkness, darkness));
      return vec4(mix(colorTexture.rgb, target, falloff.clamp(0, 1)), colorTexture.a);
    }
    case "filmGrain": {
      const seed = uniform(0);
      registerFrameUpdate((frame) => {
        seed.value = computeFilmGrainSeed(frame);
      });
      const noise = rand(fract(uv().add(seed)));
      const grained = colorTexture.rgb.add(colorTexture.rgb.mul(clamp(noise.add(0.1), 0, 1)));
      const intensity = float(effect.intensity ?? 0.35);
      return vec4(mix(colorTexture.rgb, grained, intensity), colorTexture.a);
    }
    case "lensDistortion": {
      // See the "sharpen" case's own comment for why colorTexture needs
      // convertToTexture before any .sample() call at a non-default UV.
      const sampleable = convertToTexture(colorTexture);
      const amount = effect.amount ?? 0;
      const centered = uv().sub(vec2(0.5, 0.5));
      const r2 = centered.dot(centered);
      const distortedUv = vec2(0.5, 0.5).add(centered.mul(float(1).add(r2.mul(float(amount)))));
      return sampleable.sample(distortedUv);
    }
    case "motionBlur": {
      // velocity is Three.js's own per-object motion vector (see
      // VelocityNode in this project's installed three@0.185.1 source): an
      // NDC-space (-1 to 1) delta between this frame's and the previous
      // frame's clip-space position, covering the whole frame interval
      // (implicitly a 360-degree shutter). Scaled here to UV space (0 to 1,
      // hence the extra 0.5) and to shutterAngle's own fraction of that
      // interval - motionBlur's own sampling below adds this directly to a
      // uv() coordinate.
      const velocityTexture: AnyTslNode = scenePass.getTextureNode("velocity");
      const scaledVelocity = velocityTexture.mul(float(computeMotionBlurVelocityScale(effect.shutterAngle ?? 180)));
      return createMotionBlurNode(convertToTexture(colorTexture), scaledVelocity, int(effect.samples ?? 16));
    }
    case "godRays": {
      // Silent no-op (returns colorTexture unchanged) for a missing,
      // wrong-type, or non-shadow-casting light: see GodRaysEffectConfig's
      // own doc comment for why this is deliberate rather than a thrown
      // error - a scene author renaming or removing a light shouldn't break
      // the whole render. GodraysNode itself requires a real shadow map
      // (light.shadow.map), which Three.js only populates for
      // castShadow: true lights, so that check is not optional here.
      const light = scene.getObjectByName(effect.lightNodeId);
      if (!(light instanceof THREE.DirectionalLight || light instanceof THREE.PointLight)) {
        return colorTexture;
      }
      if (!light.castShadow) {
        return colorTexture;
      }
      const depthTexture: AnyTslNode = scenePass.getTextureNode("depth");
      const godRaysNode = createGodRaysNode(depthTexture, camera, light);
      godRaysNode.raymarchSteps.value = effect.raymarchSteps ?? 60;
      godRaysNode.density.value = effect.density ?? 0.7;
      godRaysNode.maxDensity.value = effect.maxDensity ?? 0.5;
      godRaysNode.distanceAttenuation.value = effect.distanceAttenuation ?? 2;
      return colorTexture.add(godRaysNode.getTextureNode());
    }
    case "colorGrade": {
      // Reproduces applyColorGrade's exact formula (see that function's own
      // doc for why both backends share one source of truth for the actual
      // math). No convertToTexture needed: only .rgb/.a property access
      // below, never .sample() (see the "lensDistortion" case's own comment
      // for why that distinction matters).
      const [liftR, liftG, liftB] = effect.lift ?? [0, 0, 0];
      const [gammaR, gammaG, gammaB] = effect.gamma ?? [1, 1, 1];
      const [gainR, gainG, gainB] = effect.gain ?? [1, 1, 1];
      const lift = vec3(liftR, liftG, liftB);
      const gamma = vec3(gammaR, gammaG, gammaB);
      const gain = vec3(gainR, gainG, gainB);
      const lifted = colorTexture.rgb.mul(float(1).sub(lift)).add(lift);
      const gained = lifted.mul(gain);
      const graded = gained.max(0).pow(float(1).div(gamma));
      const luma = graded.dot(vec3(0.2126, 0.7152, 0.0722));
      const saturated = vec3(luma).add(graded.sub(vec3(luma)).mul(float(effect.saturation ?? 1)));
      const contrasted = saturated.sub(0.5).mul(float(effect.contrast ?? 1)).add(0.5);
      return vec4(contrasted, colorTexture.a);
    }
    case "lut": {
      const lutTexture = resolveLut(effect.lutRef);
      if (lutTexture === undefined) {
        return colorTexture;
      }
      const lutSize = lutTexture.image.width;
      const lutTextureNode = texture(lutTexture);
      return createLut3DNode(colorTexture, lutTextureNode, lutSize, float(effect.intensity ?? 1));
    }
  }
}
