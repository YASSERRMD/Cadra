import { Camera, Light, Shape } from "@cadra/core";

import type { GoldenScene } from "./golden-scene.js";
import { buildSingleTrackProject } from "./shared.js";

const FPS = 10;
const DURATION_IN_FRAMES = 1;
const WIDTH = 256;
const HEIGHT = 256;

const METALNESS_COLUMNS = [0, 0.5, 1];
const ROUGHNESS_ROWS = [0.1, 0.5, 0.9];
const GRID_SPACING = 1.6;

/**
 * A 3x3 grid of spheres spanning `MeshMaterialConfig`'s own two headline PBR
 * knobs: `metalness` across columns (`0` dielectric to `1` fully metallic),
 * `roughness` across rows (`0.1` near-mirror to `0.9` matte), all sharing
 * the same warm `baseColor` so only the PBR response itself varies between
 * spheres. Lit with the same ambient-plus-directional recipe
 * `buildProject`'s own doc in `@cadra/encode`'s e2e suite established as
 * reliably visible against a black background.
 */
function buildProject() {
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 7], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const ambientLight = Light({ id: "light-ambient", lightType: "ambient", intensity: 1.2 });
  const directionalLight = Light({
    id: "light-directional",
    transform: { position: [3, 4, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
    lightType: "directional",
    intensity: 2,
  });

  const spheres = METALNESS_COLUMNS.flatMap((metalness, columnIndex) =>
    ROUGHNESS_ROWS.map((roughness, rowIndex) => {
      const x = (columnIndex - 1) * GRID_SPACING;
      const y = (1 - rowIndex) * GRID_SPACING;
      return Shape({
        id: `sphere-${columnIndex}-${rowIndex}`,
        geometryRef: "sphere",
        transform: { position: [x, y, 0], rotation: [0, 0, 0], scale: [1.3, 1.3, 1.3] },
        material: {
          baseColor: [0.75, 0.45, 0.2, 1],
          metalness,
          roughness,
        },
      });
    }),
  );

  return buildSingleTrackProject({
    projectId: "p-materials",
    compositionId: "comp-materials",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: WIDTH,
    height: HEIGHT,
    nodes: [camera, ambientLight, directionalLight, ...spheres],
    activeCameraNodeId: "camera-1",
  });
}

export const materialsScene: GoldenScene = {
  name: "materials",
  driver: "nativeGpuHeadless",
  buildProject,
  compositionId: "comp-materials",
  frame: 0,
  width: WIDTH,
  height: HEIGHT,
  seed: "golden-materials",
};
