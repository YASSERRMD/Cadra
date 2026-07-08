import { Camera, type Composition, Light, Shape } from "@cadra/core";

import type { GoldenScene } from "./golden-scene.js";
import { buildSingleTrackProject } from "./shared.js";

const FPS = 10;
const DURATION_IN_FRAMES = 1;
const WIDTH = 160;
const HEIGHT = 160;

/**
 * A simple lit sphere-and-box pair rendered with `renderMode: "pathTraced"`
 * (Phase 63/65), covering this harness's path-traced render mode end to
 * end via `render-browser-scene.ts`'s own Playwright bridge (path tracing
 * needs a real `THREE.WebGLRenderer`; see that module's doc for why this
 * cannot run through the native-GPU-headless path the other scenes use).
 *
 * `samples: 48, bounces: 4`: well above `buildProjectWithPathTracing`'s own
 * "just prove the pipeline runs" `samples: 2` (`@cadra/encode`'s e2e
 * suite), since a golden-frame reference needs a visually stable,
 * low-noise image for a tight perceptual tolerance to be meaningful, but
 * still far below `resolveSampleBudgetForTier`'s 256-sample "final" tier,
 * keeping this scene's render time reasonable at this resolution. The
 * path-traced accumulation itself is seeded deterministically (this
 * scene's own `seed`), so the same machine reproduces the same noise
 * pattern; only cross-machine/cross-GPU floating-point differences are
 * expected to move individual pixels, exactly what this harness's tight
 * tolerance (not exact byte match) exists to absorb.
 */
function buildProject() {
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0.5, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const sphere = Shape({
    id: "sphere-1",
    geometryRef: "sphere",
    transform: { position: [-1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material: { baseColor: [0.8, 0.8, 0.85, 1], metalness: 1, roughness: 0.15 },
  });
  const box = Shape({
    id: "box-1",
    geometryRef: "box",
    transform: { position: [1.2, -0.2, 0], rotation: [0, 0.4, 0], scale: [1.1, 1.1, 1.1] },
    material: { baseColor: [0.85, 0.2, 0.2, 1], metalness: 0, roughness: 0.5 },
  });
  const ambientLight = Light({ id: "light-ambient", lightType: "ambient", intensity: 0.6 });
  const directionalLight = Light({
    id: "light-directional",
    transform: { position: [2, 4, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    lightType: "directional",
    intensity: 2.5,
  });

  const project = buildSingleTrackProject({
    projectId: "p-path-traced",
    compositionId: "comp-path-traced",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: WIDTH,
    height: HEIGHT,
    nodes: [camera, sphere, box, ambientLight, directionalLight],
    activeCameraNodeId: "camera-1",
  });

  const composition = project.compositions[0];
  if (composition === undefined) {
    throw new Error("buildSingleTrackProject always returns a project with exactly one composition.");
  }

  const withPathTracing: Composition = {
    ...composition,
    renderMode: "pathTraced",
    pathTracing: { samples: 48, bounces: 4 },
  };

  return { ...project, compositions: [withPathTracing] };
}

export const pathTracedScene: GoldenScene = {
  name: "path-traced",
  driver: "browser",
  buildProject,
  compositionId: "comp-path-traced",
  frame: 0,
  width: WIDTH,
  height: HEIGHT,
  seed: "golden-path-traced",
};
