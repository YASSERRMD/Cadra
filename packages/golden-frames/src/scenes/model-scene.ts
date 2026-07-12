import { Camera, Light, Model } from "@cadra/core";

import type { GoldenScene } from "./golden-scene.js";
import { buildSingleTrackProject } from "./shared.js";

const FPS = 10;
const DURATION_IN_FRAMES = 1;
const WIDTH = 256;
const HEIGHT = 256;
const MODEL_ASSET_REF = "golden-model://test-box";

/**
 * A single real GLB model (`test-fixtures/models/test-box.glb` - a unit
 * box with a `MeshStandardMaterial`, generated via three.js's own
 * `GLTFExporter`, mirroring the exact real-GLB construction
 * `@cadra/renderer`'s own `gltf-loader.test.ts` proves `createDefaultParseGltf`
 * correctly parses), lit with the same ambient-plus-directional recipe
 * every other curated scene in this package uses, rotated off-axis so more
 * than one face is visible - proving `ModelNode`'s own reconciler path
 * (clone, cast/receive shadow, scale) renders a real loaded GLTF, not the
 * empty-group placeholder every `"model"` node fell back to before
 * `buildModelRegistryForProject`/`render-raster-scene.ts`'s own
 * `buildModelRenderRegistry` existed.
 */
function buildProject() {
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const ambientLight = Light({ id: "light-ambient", lightType: "ambient", intensity: 1.2 });
  const directionalLight = Light({
    id: "light-directional",
    transform: { position: [3, 4, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
    lightType: "directional",
    intensity: 2,
  });
  const model = Model({
    id: "model-1",
    assetRef: MODEL_ASSET_REF,
    transform: { position: [0, 0, 0], rotation: [-0.4, 0.6, 0], scale: [1.6, 1.6, 1.6] },
  });

  return buildSingleTrackProject({
    projectId: "p-model",
    compositionId: "comp-model",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: WIDTH,
    height: HEIGHT,
    nodes: [camera, ambientLight, directionalLight, model],
    activeCameraNodeId: "camera-1",
  });
}

export const modelScene: GoldenScene = {
  name: "model",
  driver: "nativeGpuHeadless",
  buildProject,
  compositionId: "comp-model",
  frame: 0,
  width: WIDTH,
  height: HEIGHT,
  seed: "golden-model",
  modelRequirements: [{ assetRef: MODEL_ASSET_REF, modelFixtureFileName: "test-box.glb" }],
};
