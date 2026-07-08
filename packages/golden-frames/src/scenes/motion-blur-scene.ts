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
 * **Root-caused and fixed.** An earlier version of this doc reported that a
 * real pixel-level A/B comparison (this same scene rendered with
 * `motionBlur` left in vs. stripped out) showed *zero* difference through
 * both this harness's drivers. That comparison was re-run with more direct
 * instrumentation (visualizing the raw velocity MRT buffer, then a
 * hardcoded, non-velocity UV offset on an unrelated effect as a control) and
 * the "through both drivers" half of that claim does not hold:
 *
 * - The velocity MRT buffer itself is genuinely non-zero for this scene's
 *   moving box (`VelocityNode`'s per-object previous/current world-matrix
 *   tracking works correctly): confirmed by rendering `scaledVelocity`
 *   directly as the pipeline's own output.
 * - Through `driver: "browser"` (a real headless-Chromium page), the exact
 *   same unmodified `@cadra/renderer` pipeline code produces a real,
 *   substantial difference between this scene rendered with `motionBlur`
 *   left in vs. stripped out - a genuine blur streak, not a rounding-level
 *   difference. `motionBlur` was never broken in `@cadra/renderer` itself.
 * - Through `driver: "nativeGpuHeadless"` (`createNativeGpuHeadlessRenderer`,
 *   an experimental, opt-in, no-browser research spike - see that
 *   function's own doc in `@cadra/headless`), a `.sample()` call at *any*
 *   arbitrary UV offset - not just a velocity-derived one; a hardcoded,
 *   effect-unrelated offset on `sharpen`'s own sampling reproduces it
 *   identically - silently samples as if no offset were given at all. This
 *   is a limitation of that experimental renderer (or the native `webgpu`
 *   package's Dawn binding underneath it), not of this scene, `motionBlur`,
 *   or any other effect's own TSL logic.
 *
 * This scene now uses `driver: "browser"` (see `GoldenSceneDriver`'s own
 * doc), the driver proven to actually exercise `motionBlur` correctly; its
 * real-render coverage and blur-streak verification live in
 * `render-browser-scene.e2e.test.ts` alongside the path-traced scene's own.
 * The deeper `nativeGpuHeadless` arbitrary-UV-sampling limitation is tracked
 * separately (it may silently affect how much `post-processing-scene.ts`'s
 * own `nativeGpuHeadless`-driven effects are really proven to do, beyond
 * "renders something non-blank") - not blocking this fix, since that scene
 * was never relied on as its effects' own correctness proof in the first
 * place (see its own doc comment).
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
