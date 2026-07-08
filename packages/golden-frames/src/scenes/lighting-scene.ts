import { Camera, Light, Shape } from "@cadra/core";

import type { GoldenScene } from "./golden-scene.js";
import { buildSingleTrackProject } from "./shared.js";

const FPS = 10;
const DURATION_IN_FRAMES = 1;
const WIDTH = 256;
const HEIGHT = 256;

/**
 * One matte sphere lit by all four positional/directional light types this
 * codebase supports at once: a dim ambient fill (so unlit areas read as
 * dark gray, not pure black), a warm point light to camera-left, a cool
 * spot light from above, and a violet directional rim/back light. Each
 * light's beam direction comes from Three.js's own "aims at its own
 * `target`, which defaults to world origin" behavior (see
 * `buildProject`'s own doc in `@cadra/encode`'s e2e suite): since the
 * sphere sits at the world origin, every light's own `transform.position`
 * alone is enough to aim it at the sphere, with no explicit target field
 * needed (`LightNode` has none).
 */
function buildProject() {
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const sphere = Shape({
    id: "sphere-1",
    geometryRef: "sphere",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1.8, 1.8, 1.8] },
    material: { baseColor: [0.7, 0.7, 0.7, 1], metalness: 0, roughness: 0.6 },
  });
  const ambientLight = Light({ id: "light-ambient", lightType: "ambient", intensity: 0.25 });
  const pointLight = Light({
    id: "light-point",
    lightType: "point",
    transform: { position: [-3, 0.5, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
    color: [1, 0.65, 0.35, 1],
    intensity: 18,
    decay: 2,
  });
  const spotLight = Light({
    id: "light-spot",
    lightType: "spot",
    transform: { position: [1, 4, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    color: [0.4, 0.7, 1, 1],
    intensity: 40,
    angle: Math.PI / 7,
    penumbra: 0.4,
    decay: 2,
  });
  const directionalLight = Light({
    id: "light-directional",
    lightType: "directional",
    transform: { position: [0, 1, -4], rotation: [0, 0, 0], scale: [1, 1, 1] },
    color: [0.6, 0.4, 1, 1],
    intensity: 1.5,
  });

  return buildSingleTrackProject({
    projectId: "p-lighting",
    compositionId: "comp-lighting",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: WIDTH,
    height: HEIGHT,
    nodes: [camera, sphere, ambientLight, pointLight, spotLight, directionalLight],
    activeCameraNodeId: "camera-1",
  });
}

export const lightingScene: GoldenScene = {
  name: "lighting",
  driver: "nativeGpuHeadless",
  buildProject,
  compositionId: "comp-lighting",
  frame: 0,
  width: WIDTH,
  height: HEIGHT,
  seed: "golden-lighting",
};
