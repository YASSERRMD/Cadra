import { Camera, Light, Shape } from "@cadra/core";

import type { GoldenScene } from "./golden-scene.js";
import { buildSingleTrackProject } from "./shared.js";

/**
 * Regression coverage for the hardcoded-square `camera.aspect` bug (fixed
 * on `fix/renderer-aspect-and-headless-text`): every other curated scene in
 * this package renders at an exactly-square resolution (256x256 or
 * 160x160), so a frustum that silently ignored a non-square composition's
 * own width/height could never have shown up as a pixel diff here - see
 * `packages/renderer/src/three-renderer.test.ts`'s own unit coverage of
 * `camera.aspect` tracking composition size, which this package
 * complements with a real rendered-pixels check.
 *
 * A sphere is the payload specifically because it has no straight edges: a
 * wrong (e.g. hardcoded-1) aspect ratio stretches it into a visibly
 * lopsided ellipse - egg-shaped in a 16:9/21:9 frame, tomato-shaped in
 * 9:16 - while a correct aspect ratio keeps it a circle in screen space
 * regardless of the frame's own width:height ratio. A grid backdrop plane
 * gives a second, independent visual cue: its own squares should stay
 * square on screen too.
 */
const FPS = 10;
const DURATION_IN_FRAMES = 1;

interface AspectRatioSceneConfig {
  name: string;
  width: number;
  height: number;
}

function buildProject(config: AspectRatioSceneConfig) {
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const backdrop = Shape({
    id: "backdrop",
    geometryRef: "box",
    transform: { position: [0, 0, -3], rotation: [0, 0, 0], scale: [20, 20, 0.1] },
    material: { baseColor: [0.05, 0.05, 0.06, 1], roughness: 1, metalness: 0 },
  });
  const sphere = Shape({
    id: "hero-sphere",
    geometryRef: "sphere",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1.4, 1.4, 1.4] },
    material: { baseColor: [0.85, 0.2, 0.2, 1], roughness: 0.4, metalness: 0 },
    castShadow: true,
    receiveShadow: true,
  });
  const ambientLight = Light({ id: "light-ambient", lightType: "ambient", intensity: 1.2 });
  const directionalLight = Light({
    id: "light-directional",
    transform: { position: [2, 3, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
    lightType: "directional",
    intensity: 1.5,
  });

  return buildSingleTrackProject({
    projectId: `p-${config.name}`,
    compositionId: `comp-${config.name}`,
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: config.width,
    height: config.height,
    nodes: [camera, backdrop, sphere, ambientLight, directionalLight],
    activeCameraNodeId: "camera-1",
  });
}

function buildAspectRatioScene(config: AspectRatioSceneConfig): GoldenScene {
  return {
    name: config.name,
    driver: "nativeGpuHeadless",
    buildProject: () => buildProject(config),
    compositionId: `comp-${config.name}`,
    frame: 0,
    width: config.width,
    height: config.height,
    seed: `golden-${config.name}`,
  };
}

/** 16:9, e.g. a standard widescreen deliverable. */
export const aspectRatio16x9Scene: GoldenScene = buildAspectRatioScene({
  name: "aspect-ratio-16x9",
  width: 320,
  height: 180,
});

/** 9:16, e.g. a vertical/Reels/TikTok deliverable - the exact orientation the original bug's own real-world report (a non-square composition) came from. */
export const aspectRatio9x16Scene: GoldenScene = buildAspectRatioScene({
  name: "aspect-ratio-9x16",
  width: 180,
  height: 320,
});

/** 21:9, an ultra-wide deliverable - the most extreme ratio in this pack, so the largest possible stretch if this regresses. */
export const aspectRatio21x9Scene: GoldenScene = buildAspectRatioScene({
  name: "aspect-ratio-21x9",
  width: 420,
  height: 180,
});
