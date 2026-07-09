import { Camera, type Composition, Light, Shape } from "@cadra/core";

import type { GoldenScene } from "./golden-scene.js";
import { buildSingleTrackProject } from "./shared.js";

const FPS = 10;
const DURATION_IN_FRAMES = 5;
const WIDTH = 256;
const HEIGHT = 256;
/** The frame this scene renders: mid-sweep, comfortably after the box's own first on-screen frame. */
const TARGET_FRAME = 1;

/**
 * A box sweeping across five frames, staying on-screen for the whole sweep,
 * with `motionBlur` configured at a high shutter angle.
 *
 * **Root-caused and fixed, twice over.** An earlier version of this doc
 * reported that a real pixel-level A/B comparison (this same scene rendered
 * with `motionBlur` left in vs. stripped out) showed *zero* difference
 * through both this harness's drivers, and diagnosed the `"nativeGpuHeadless"`
 * half of that as "a `.sample()` call at any arbitrary UV offset silently
 * samples as if no offset were given at all." That diagnosis was itself
 * imprecise: the real defect (see `applyProductionWebGpuBehavior` in
 * `@cadra/renderer`) was that `createNativeGpuHeadlessRenderer` never wired
 * its own WebGPU renderer up to run the post-processing pipeline *at all* -
 * every effect, not just ones sampling at an offset UV, silently no-op'd.
 * Once that was fixed, `motionBlur` (and every other post-processing effect
 * this harness exercises except `lut` - see `post-processing-scene.ts`'s
 * own doc) renders correctly through `"nativeGpuHeadless"` too, verified via
 * the exact same A/B comparison this doc originally used: a real,
 * substantial difference (comparable in magnitude to the `"browser"` driver's
 * own), not a rounding-level one.
 *
 * This scene stays on `driver: "browser"` regardless - already proven
 * reliable, and switching back would only add churn for a speed gain this
 * scene does not need - with its real-render coverage and blur-streak
 * verification in `render-browser-scene.e2e.test.ts` alongside the
 * path-traced scene's own.
 */
function buildProject() {
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const movingBox = Shape({
    id: "box-1",
    geometryRef: "box",
    transform: {
      position: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: [-2.5, 0, 0] },
          { frame: DURATION_IN_FRAMES - 1, value: [2.5, 0, 0] },
        ],
      },
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    material: { baseColor: [0.9, 0.3, 0.3, 1], metalness: 0, roughness: 0.6 },
  });
  const ambientLight = Light({ id: "light-ambient", lightType: "ambient", intensity: 1.5 });
  const directionalLight = Light({
    id: "light-directional",
    transform: { position: [2, 3, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
    lightType: "directional",
    intensity: 1.5,
  });

  const project = buildSingleTrackProject({
    projectId: "p-motion-blur",
    compositionId: "comp-motion-blur",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: WIDTH,
    height: HEIGHT,
    nodes: [camera, movingBox, ambientLight, directionalLight],
    activeCameraNodeId: "camera-1",
  });

  const composition = project.compositions[0];
  if (composition === undefined) {
    throw new Error("buildSingleTrackProject always returns a project with exactly one composition.");
  }

  const withMotionBlur: Composition = {
    ...composition,
    postProcessing: { effects: [{ type: "motionBlur", shutterAngle: 360, samples: 8 }] },
  };

  return { ...project, compositions: [withMotionBlur] };
}

export const motionBlurScene: GoldenScene = {
  name: "motion-blur",
  driver: "browser",
  buildProject,
  compositionId: "comp-motion-blur",
  frame: TARGET_FRAME,
  width: WIDTH,
  height: HEIGHT,
  seed: "golden-motion-blur",
};
