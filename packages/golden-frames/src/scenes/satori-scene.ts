import { Camera, Satori } from "@cadra/core";

import type { GoldenScene } from "./golden-scene.js";
import { buildSingleTrackProject } from "./shared.js";

const FPS = 10;
const DURATION_IN_FRAMES = 1;
const WIDTH = 256;
const HEIGHT = 256;

/**
 * A single real `SatoriNode` (a rounded-rectangle, solid-color `div` layer,
 * no text - `buildSatoriLayerRenderRegistry`'s own doc explains why every
 * curated satori scene here stays text-free: a confirmed upstream
 * Satori/opentype.js bug parsing this workspace's own bundled variable
 * font), unlit (a satori layer's own rasterized texture, applied via
 * `MeshBasicMaterial`, needs no light) - proving `SatoriNode`'s own real
 * Satori-render-then-resvg-rasterize pipeline actually reaches the render
 * target, not the empty-group placeholder every `"satori"` node fell back
 * to before `buildSatoriLayerRenderRegistryForProject`/
 * `render-raster-scene.ts`'s own `buildSatoriLayerRenderRegistry` existed.
 *
 * `width`/`height` are large not for the usual "overfill the frame, skip
 * camera-distance math" reason `render-frames-tools.test.ts`'s/
 * `render-job.e2e.test.ts`'s own solid-fill satori tests use: unlike
 * `ImageNode`, `node-factory.ts`'s own satori mesh construction uses
 * `node.width`/`node.height` directly as *both* the `PlaneGeometry`'s
 * world-unit size *and* (via `prepareSatoriLayerRenderData`) the
 * rasterized texture's own pixel resolution, with no separate world-scale
 * factor - so a small value (a "reasonable world size" in isolation) also
 * rasterizes at that same tiny pixel resolution (a border-radius rasterized
 * at a literal few pixels tall reads as meaningless banding, not a rounded
 * rectangle - exactly what this scene's own first, visibly broken attempt
 * produced). A large value here plus a proportionally distant camera (see
 * below) gets both: crisp rasterization *and* a bounded shape - with its
 * own rounded corners and surrounding background - actually visible in
 * frame, a more informative regression reference than an indistinguishable
 * full-bleed fill (which would not catch a UV/sizing bug that still
 * happened to fill the screen with the right color).
 */
function buildProject() {
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 640], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const satori = Satori({
    id: "satori-1",
    layer: {
      type: "div",
      style: { width: "100%", height: "100%", backgroundColor: "#4488ee", borderRadius: "24px", display: "flex" },
    },
    width: 300,
    height: 300,
  });

  return buildSingleTrackProject({
    projectId: "p-satori",
    compositionId: "comp-satori",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: WIDTH,
    height: HEIGHT,
    nodes: [camera, satori],
    activeCameraNodeId: "camera-1",
  });
}

export const satoriScene: GoldenScene = {
  name: "satori",
  driver: "nativeGpuHeadless",
  buildProject,
  compositionId: "comp-satori",
  frame: 0,
  width: WIDTH,
  height: HEIGHT,
  seed: "golden-satori",
};
