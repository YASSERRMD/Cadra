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
 * **Known gap, not yet fixed (tracked separately, out of this phase's own
 * scope):** verified directly while building this harness, with a real
 * pixel-level A/B comparison (this same scene rendered with `motionBlur`
 * left in vs. stripped out) via *both* `createNativeGpuHeadlessRenderer`
 * and a real headless-Chromium page, that `motionBlur` currently produces
 * *zero* pixel difference either way. The wiring this scene exercises
 * (`isPreTonemapEffect`/`buildWebGpuPipeline`'s velocity-MRT setup in
 * `@cadra/renderer`, `computeMotionBlurVelocityScale`) all checks out
 * structurally; no existing test anywhere in this codebase (including
 * `buildProjectWithMotionBlur` in `@cadra/encode`'s own e2e suite) actually
 * asserts a visible blur streak - every one only asserts the render
 * completes and produces validly-shaped output, which is exactly why this
 * gap went unnoticed until this harness's own rigorous same-scene
 * with/without comparison. Root-causing this needs deeper runtime
 * instrumentation of Three.js's own WebGPU node-update scheduling
 * (`VelocityNode`'s `update`/`updateAfter` hooks), out of scope for this
 * harness itself to fix.
 *
 * This scene is kept in the curated set anyway (as `driver:
 * "nativeGpuHeadless"`, the simpler/faster of the two drivers, since
 * neither shows the effect): it still renders a real, deterministic frame
 * worth protecting from *further* regression (a crash, a blank frame, or
 * `postProcessing` silently getting dropped entirely), and its own
 * reference will need to be regenerated the moment this known gap is
 * actually fixed.
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
  driver: "nativeGpuHeadless",
  buildProject,
  compositionId: "comp-motion-blur",
  frame: TARGET_FRAME,
  width: WIDTH,
  height: HEIGHT,
  seed: "golden-motion-blur",
};
