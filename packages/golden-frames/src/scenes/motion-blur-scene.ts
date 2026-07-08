import { Camera, type Composition, Light, Shape } from "@cadra/core";

import type { GoldenScene } from "./golden-scene.js";
import { buildSingleTrackProject } from "./shared.js";

const FPS = 10;
const DURATION_IN_FRAMES = 5;
const WIDTH = 256;
const HEIGHT = 256;
/** The frame this scene renders: mid-sweep, comfortably after the box's own first on-screen frame (see `buildProject`'s own doc for why that matters). */
const TARGET_FRAME = 1;

/**
 * A box sweeping across five frames, staying on-screen for the whole sweep
 * (unlike an earlier draft of this scene, which swept from far off-screen
 * left to far off-screen right): Three.js's own per-object motion-vector
 * tracking (`VelocityNode`, what `motionBlur` reads) seeds a *newly
 * first-drawn* object's own "previous transform" to its current one, i.e.
 * zero velocity, so an object whose first real on-screen draw lands on the
 * very frame this scene targets would render with no blur at all no matter
 * how fast it is actually moving - verified directly while building this
 * scene. Keeping the box on-screen (and this harness's own render driver
 * walking every frame from `0` up to the target in order; see
 * `render-raster-scene.ts`/`render-browser-scene.ts`) ensures the box has
 * already been drawn, moving, at least once before the frame this scene
 * actually captures.
 *
 * `motionBlur` at a high shutter angle so any wiring regression in
 * `buildWebGpuPipeline`'s own velocity-MRT setup is maximally visible as a
 * missing or wrong-direction streak, mirroring `buildProjectWithMotionBlur`
 * (`@cadra/encode`'s own e2e suite, which exercises this exact effect
 * through a real browser).
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
  // "browser", not "nativeGpuHeadless": see GoldenSceneDriver's own doc for
  // the real, verified gap this works around (motionBlur produces zero
  // pixel difference through createNativeGpuHeadlessRenderer, unlike a
  // real browser's own WebGPU implementation).
  driver: "browser",
  buildProject,
  compositionId: "comp-motion-blur",
  frame: TARGET_FRAME,
  width: WIDTH,
  height: HEIGHT,
  seed: "golden-motion-blur",
};
