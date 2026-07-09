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
 * `driver: "browser"`, not `"nativeGpuHeadless"`: verified directly while
 * root-causing a separate, previously-undiscovered gap (`@cadra/renderer`'s
 * `createNativeGpuHeadlessRenderer` never actually ran its own post-processing
 * pipeline at all before that fix - see `applyProductionWebGpuBehavior`'s own
 * doc) that once the pipeline genuinely runs, this scene's own `lut` effect
 * still renders solid black through the experimental `webgpu` npm package's
 * native Dawn binding specifically (bisected, post-fix: every other effect
 * here, and ambient occlusion, renders correctly in isolation through that
 * same native path; only `lut`'s own 3D-texture sampling does not) - a real
 * headless-Chromium page renders every one of these effects, `lut` included,
 * correctly. This is tracked as its own separate, narrower follow-up (a
 * native-Dawn/TSL `Lut3DNode` texture-sampler compatibility gap), not fixed
 * here.
 *
 * That same bisection also caught a second, unrelated, driver-*independent*
 * bug along the way: `chromaticAberration` alone rendered solid black
 * through *both* drivers, including a real browser - not a native-Dawn
 * quirk at all, but three.js's own `ChromaticAberrationNode` (three/addons/
 * tsl/display/ChromaticAberrationNode.js) silently degenerating when its
 * `center` argument is left at its documented-but-unimplemented `null`
 * default. This one *is* fixed, at the source: see
 * `post-processing-pipeline.ts`'s own `"chromaticAberration"` case, which
 * now passes an explicit `vec2(0.5, 0.5)`. Left in this scene's own effect
 * list specifically so a regression here (either in Cadra's own call site or
 * a future three.js upgrade reintroducing the same default) shows up as a
 * real, checked reference-image diff instead of silently no-op'ing again;
 * `render-browser-scene.e2e.test.ts`'s own `countNonBlackPixels` assertions
 * guard the same regression independently of any one reference image's own
 * tolerance.
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
  driver: "browser",
  buildProject,
  compositionId: "comp-post-processing",
  frame: 0,
  width: WIDTH,
  height: HEIGHT,
  seed: "golden-post-processing",
};
