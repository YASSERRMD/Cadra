import { Camera, type Composition, Light, Shape } from "@cadra/core";

import type { GoldenScene } from "./golden-scene.js";
import { buildSingleTrackProject } from "./shared.js";

const FPS = 10;
const DURATION_IN_FRAMES = 1;
const WIDTH = 256;
const HEIGHT = 256;

/**
 * A lit, emissive-accented box (bright enough to bloom) run through every
 * post-tonemap and pre-tonemap effect `buildProjectWithPostProcessing`
 * (`@cadra/encode`'s own e2e suite) already proved compose correctly
 * through a real browser: `bloom`, `sharpen`, `chromaticAberration`,
 * `vignette`, `filmGrain`, `lensDistortion`, `colorGrade`, and `lut`
 * (referencing `"warm"`, one of `createDefaultLutRegistry`'s built-in
 * procedural LUTs, so no registry setup is needed here), plus ambient
 * occlusion. `depthOfField` is deliberately left out: a golden frame with
 * only one flat, centered subject has no depth variation for it to
 * meaningfully act on, and its blur kernel is exactly the kind of
 * wide-spread effect most likely to amplify small cross-GPU floating-point
 * differences past this harness's tight tolerance for no visual benefit.
 *
 * `driver: "nativeGpuHeadless"`, the default for a plain raster scene like
 * this one - but getting there took three separate fixes, all found while
 * investigating this exact scene, worth recording since a future regression
 * in any one of them would silently reintroduce a broken reference image:
 *
 * 1. `@cadra/renderer`'s `createNativeGpuHeadlessRenderer` never actually
 *    ran its own post-processing pipeline at all - every effect, not just
 *    one, silently no-op'd. Fixed by `applyProductionWebGpuBehavior` (see
 *    that function's own doc).
 * 2. Once the pipeline genuinely ran, `chromaticAberration` alone rendered
 *    solid black through *both* drivers, browser included - three.js's own
 *    `ChromaticAberrationNode` (three/addons/tsl/display/
 *    ChromaticAberrationNode.js) documents a `center: null` default as
 *    "uses screen center (0.5, 0.5)" but never actually implements that
 *    substitution. Fixed in `post-processing-pipeline.ts`'s own
 *    `"chromaticAberration"` case by passing `vec2(0.5, 0.5)` explicitly.
 * 3. `lut` alone then rendered solid black through `nativeGpuHeadless`
 *    specifically (every other effect here, and ambient occlusion, already
 *    rendered correctly in isolation) - a genuine WGSL texture-dimension
 *    mismatch (`textureSample(texture_3d<f32>, sampler, vec2<f32>)`) that
 *    real Chromium tolerates as a non-fatal warning but the experimental
 *    native-Dawn `webgpu` npm package rejects outright. Root cause: this
 *    file's own call site built the LUT's texture node with three/tsl's
 *    generic `texture()` helper, which never auto-detects a
 *    `THREE.Data3DTexture` and always emits a 2D-shaped UV; three.js's own
 *    dedicated `texture3D()` helper (`Texture3DNode`) exists specifically
 *    for this and correctly emits a vec3 coordinate. Fixed in
 *    `post-processing-pipeline.ts`'s own `"lut"` case.
 *
 * Kept every one of these effects in this scene's own list (rather than
 * trimming back to a "safe" subset) specifically so a regression in any of
 * the three fixes above shows up as a real, checked reference-image diff;
 * `render-raster-scene.e2e.test.ts`'s and `render-browser-scene.e2e.test.ts`'s
 * own `countNonBlackPixels` assertions guard the same regressions
 * independently of any one reference image's own tolerance, and across both
 * drivers (this scene's real-render coverage now lives in
 * `render-raster-scene.e2e.test.ts` alongside every other native-driver
 * scene; `render-browser-scene.e2e.test.ts` additionally exercises it
 * through the browser driver too, as a cross-driver regression guard for
 * exactly the kind of driver-specific divergence all three bugs above
 * turned out to be).
 */
function buildProject() {
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 4.5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const box = Shape({
    id: "box-1",
    geometryRef: "box",
    transform: { position: [0, 0, 0], rotation: [0.3, 0.5, 0], scale: [1.6, 1.6, 1.6] },
    material: {
      baseColor: [0.2, 0.25, 0.9, 1],
      metalness: 0.2,
      roughness: 0.4,
      emissive: [0.9, 0.5, 0.1, 1],
      emissiveIntensity: 1.5,
    },
    castShadow: true,
    receiveShadow: true,
  });
  const ambientLight = Light({ id: "light-ambient", lightType: "ambient", intensity: 1 });
  const directionalLight = Light({
    id: "light-directional",
    transform: { position: [2, 3, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
    lightType: "directional",
    intensity: 2,
    castShadow: true,
  });

  const project = buildSingleTrackProject({
    projectId: "p-post-processing",
    compositionId: "comp-post-processing",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: WIDTH,
    height: HEIGHT,
    nodes: [camera, box, ambientLight, directionalLight],
    activeCameraNodeId: "camera-1",
  });

  const composition = project.compositions[0];
  if (composition === undefined) {
    throw new Error("buildSingleTrackProject always returns a project with exactly one composition.");
  }

  const withPostProcessing: Composition = {
    ...composition,
    shadowQuality: { ambientOcclusion: { radius: 1, intensity: 0.5 } },
    postProcessing: {
      effects: [
        { type: "bloom", threshold: 0.6, intensity: 0.8, radius: 0.4 },
        { type: "sharpen", amount: 0.4 },
        { type: "chromaticAberration", intensity: 0.4 },
        { type: "vignette", darkness: 0.5, offset: 1 },
        { type: "filmGrain", intensity: 0.3 },
        { type: "lensDistortion", amount: 0.05 },
        {
          type: "colorGrade",
          lift: [0.01, 0, -0.01],
          gamma: [1, 1.05, 0.95],
          gain: [1.05, 1, 0.98],
          saturation: 1.1,
          contrast: 1.05,
        },
        { type: "lut", lutRef: "warm", intensity: 0.7 },
      ],
    },
  };

  return { ...project, compositions: [withPostProcessing] };
}

export const postProcessingScene: GoldenScene = {
  name: "post-processing",
  driver: "nativeGpuHeadless",
  buildProject,
  compositionId: "comp-post-processing",
  frame: 0,
  width: WIDTH,
  height: HEIGHT,
  seed: "golden-post-processing",
};
