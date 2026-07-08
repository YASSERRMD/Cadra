import type { CompositionPostProcessing, PostEffectConfig, RenderQualityTier } from "@cadra/core";
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { ao as createGtaoNode } from "three/addons/tsl/display/GTAONode.js";
import { float, int, mrt, normalView, output, pass, textureSize, toneMappingExposure, uv, vec2, vec3, vec4 } from "three/tsl";
import { RenderPipeline, type WebGPURenderer } from "three/webgpu";

import { computeSharpenKernelWeights, SharpenShader, updateSharpenUniforms } from "./sharpen.js";
import type { AnyTslNode } from "./tsl-node.js";

/**
 * Ambient occlusion tuning resolved from `AmbientOcclusionConfig` plus the
 * composition's own quality tier, consumed by `buildWebGl2Pipeline`/
 * `buildWebGpuOutputNode` below. Moved here from `three-renderer.ts` in
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
  /** Trades render cost against fidelity. Not read by any effect Phase 58 itself ships (`sharpen` has no tier-sensitive knob); threaded through now so Phase 59 onward's more expensive effects (bloom, depth of field) can read it without another round of plumbing. */
  tier: RenderQualityTier;
  effects: PostEffectConfig[];
}

/**
 * Everything a `ThreeRendererLike.render` call might need beyond `scene`/
 * `camera`. Both fields must reach the very same composer/pipeline
 * construction (see `buildWebGl2Pipeline`/`buildWebGpuOutputNode`): ambient
 * occlusion darkens the scene's own linear-HDR color before tone mapping,
 * exactly where a `postProcessing` effect's own `"preTonemap"` stage runs, so
 * splitting them across two independently-`RenderPass`-ing composers would
 * either silently drop one or double-render the scene.
 */
export interface RenderPassConfig {
  ambientOcclusion?: AmbientOcclusionRenderConfig;
  postProcessing?: PostProcessingRenderConfig;
}

/**
 * Resolves a `Composition`'s own `postProcessing` into a
 * `PostProcessingRenderConfig`, or `undefined` for a no-op stack (mirrors
 * `Composition.postProcessing`'s own doc: omitted, or `effects: []`, must
 * render byte-identical to no post-processing pipeline at all).
 */
export function resolvePostProcessing(
  postProcessing: CompositionPostProcessing | undefined,
): PostProcessingRenderConfig | undefined {
  if (postProcessing === undefined || postProcessing.effects.length === 0) {
    return undefined;
  }
  return { tier: postProcessing.tier ?? "final", effects: postProcessing.effects };
}

/**
 * True for a `PostEffectConfig` whose own pass must run before tone mapping,
 * on linear scene-referred HDR data (an inherent property of the effect
 * type, not authorable - see `PostEffectConfig`'s own doc for why). `sharpen`
 * is the one variant Phase 58 ships, and is a display-referred (post-tonemap)
 * effect: it sharpens the final image an audience actually sees, the same
 * stage a photo editor's own "clarity"/"sharpen" slider operates at.
 */
function isPreTonemapEffect(effect: PostEffectConfig): boolean {
  switch (effect.type) {
    case "sharpen":
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

/** Builds one `ShaderPass` for `effect`, sized to the composer's own current pixel dimensions. The one branch Phase 58 ships (`"sharpen"`); Phase 59 onward adds one case per new effect. */
function buildWebGl2EffectPass(effect: PostEffectConfig, width: number, height: number): ShaderPass {
  switch (effect.type) {
    case "sharpen": {
      const shaderPass = new ShaderPass(SharpenShader);
      updateSharpenUniforms(shaderPass.material, effect.amount ?? 0.5, width, height);
      return shaderPass;
    }
  }
}

/**
 * Builds the one shared `EffectComposer` chain for the WebGL2 backend:
 * `RenderPass` (linear HDR; `EffectComposer`'s own default internal buffers
 * are already `HalfFloatType`, per this project's installed
 * `three@0.185.1` source) -> `GTAOPass` if `ambientOcclusion` is set ->
 * pre-tonemap effect passes -> `OutputPass` (applies `renderer.toneMapping`
 * and `renderer.outputColorSpace` together, reading them fresh every
 * `render()` call per `OutputPass`'s own source) -> post-tonemap effect
 * passes. `EffectComposer` tracks which of its own passes is last and
 * renders only that one to screen automatically (verified directly against
 * this project's installed `three@0.185.1` source,
 * `isLastEnabledPass`/`addPass`), so nothing here ever sets `renderToScreen`
 * itself.
 */
export function buildWebGl2Pipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  width: number,
  height: number,
  config: RenderPassConfig,
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  if (config.ambientOcclusion !== undefined) {
    const ao = config.ambientOcclusion;
    const aoWidth = Math.max(1, Math.round(width * ao.resolutionScale));
    const aoHeight = Math.max(1, Math.round(height * ao.resolutionScale));
    composer.addPass(buildGtaoPass(scene, camera, aoWidth, aoHeight, ao));
  }

  const { preTonemap, postTonemap } = partitionEffectsByStage(config.postProcessing?.effects ?? []);
  for (const effect of preTonemap) {
    composer.addPass(buildWebGl2EffectPass(effect, width, height));
  }

  composer.addPass(new OutputPass());

  for (const effect of postTonemap) {
    composer.addPass(buildWebGl2EffectPass(effect, width, height));
  }

  return composer;
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
 * HDR; post-tonemap: display-referred) on both backends. The caller is
 * responsible for setting `RenderPipeline.outputColorTransform = false`
 * before assigning the returned node to `outputNode`: this function already
 * did that conversion manually, and the pipeline's own default automatic
 * conversion would otherwise double-apply it.
 */
export function buildWebGpuPipeline(
  renderer: WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  config: RenderPassConfig,
): RenderPipeline {
  const scenePass = pass(scene, camera);
  if (config.ambientOcclusion !== undefined) {
    scenePass.setMRT(mrt({ output, normal: normalView }));
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

  const { preTonemap, postTonemap } = partitionEffectsByStage(config.postProcessing?.effects ?? []);

  for (const effect of preTonemap) {
    node = applyWebGpuEffect(node, effect);
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
    node = applyWebGpuEffect(node, effect);
  }

  const renderPipeline = new RenderPipeline(renderer);
  // Set before assigning outputNode, matching RenderOutputNode's own
  // documented usage example: this function already applied tone mapping
  // and color space conversion manually above, so RenderPipeline's own
  // automatic outputColorTransform step must be turned off, or the two
  // would compose and double-apply both.
  renderPipeline.outputColorTransform = false;
  renderPipeline.outputNode = node;
  return renderPipeline;
}

/**
 * Applies one `PostEffectConfig` to `colorTexture`, returning the new node.
 * Typed via `AnyTslNode` (see that type's own doc): every real TSL node
 * this touches - a scene-pass texture, a `.mul()`/`.sample()` result, ... -
 * is the same proxy-wrapped object at runtime regardless of which narrow,
 * mutually incompatible declared subtype `@types/three@0.185.0` happens to
 * assign it.
 */
function applyWebGpuEffect(colorTexture: AnyTslNode, effect: PostEffectConfig): AnyTslNode {
  switch (effect.type) {
    case "sharpen": {
      const { centerWeight, neighborWeight } = computeSharpenKernelWeights(effect.amount ?? 0.5);
      const size: AnyTslNode = textureSize(colorTexture, int(0));
      const texel = vec2(1, 1).div(size);
      const center = colorTexture.sample(uv());
      const top = colorTexture.sample(uv().add(vec2(0, texel.y)));
      const bottom = colorTexture.sample(uv().sub(vec2(0, texel.y)));
      const left = colorTexture.sample(uv().sub(vec2(texel.x, 0)));
      const right = colorTexture.sample(uv().add(vec2(texel.x, 0)));
      const neighborSum = top.add(bottom).add(left).add(right);
      return center.mul(float(centerWeight)).sub(neighborSum.mul(float(neighborWeight)));
    }
  }
}
