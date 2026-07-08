import { Camera, Light, Text } from "@cadra/core";

import type { GoldenScene, GoldenSceneTextRequirement } from "./golden-scene.js";
import { buildSingleTrackProject } from "./shared.js";

const FPS = 10;
const DURATION_IN_FRAMES = 1;
const WIDTH = 256;
const HEIGHT = 256;
const CONTENT = "Cadra";
const FONT_SIZE = 1.2;

/**
 * One line of flat MSDF text, lit only incidentally (MSDF glyph quads are
 * unlit; the lights here exist so this scene is not literally
 * light-free, matching every other curated scene's shape). `fontSize` is
 * small (world-unit em size, not pixels - see `buildTextGroup`'s own doc:
 * "the caller scales the returned root group by the node's own fontSize"),
 * matching the same roughly-unit-scale convention `Shape`'s default `1x1x1`
 * box already establishes for this harness's other scenes; the node's own
 * `transform.position` shifts it left/down by roughly half its own expected
 * width/cap-height so `CONTENT` sits close to frame center rather than
 * growing off-screen to the right from an origin anchor.
 *
 * `fontRef` is deliberately omitted (renders with "the renderer's own
 * default" font - see `TextNode`'s own doc), so the render driver registers
 * its real `TextRenderEntry` under the registry's own `"default"` key,
 * exactly matching `computeTextNodeRenderKey`'s fallback.
 */
function buildProject() {
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const text = Text({
    id: "title",
    content: CONTENT,
    fontSize: FONT_SIZE,
    color: [1, 1, 1, 1],
    transform: { position: [-1.6, -0.4, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const ambientLight = Light({ id: "light-ambient", lightType: "ambient", intensity: 1.5 });
  const directionalLight = Light({
    id: "light-directional",
    transform: { position: [2, 3, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
    lightType: "directional",
    intensity: 1.5,
  });

  return buildSingleTrackProject({
    projectId: "p-text",
    compositionId: "comp-text",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: WIDTH,
    height: HEIGHT,
    nodes: [camera, text, ambientLight, directionalLight],
    activeCameraNodeId: "camera-1",
  });
}

/** `computeTextNodeRenderKey` only reads `fontRef`/`content`/`variationAxes`; this node has neither `fontRef` nor `variationAxes`. */
const TEXT_REQUIREMENT_NODE: GoldenSceneTextRequirement["node"] = { content: CONTENT };

/** The same scene, shaped by `@cadra/text`'s `opentype.js`-backed engine - the default `createFontRegistry` backend, and the one a browser-bundled render page can also use. */
export const textOpentypeScene: GoldenScene = {
  name: "text-opentype",
  driver: "nativeGpuHeadless",
  buildProject,
  compositionId: "comp-text",
  frame: 0,
  width: WIDTH,
  height: HEIGHT,
  seed: "golden-text-opentype",
  textRequirements: [
    { node: TEXT_REQUIREMENT_NODE, fontFixtureFileName: "Inter-Variable.ttf", backend: "opentype" },
  ],
};

/** The same scene, shaped by `@cadra/text`'s independent `fontkit`-backed engine (Node-only, richer variable-font introspection) - proving both text engines produce a correctly-rendered result, not just one. */
export const textFontkitScene: GoldenScene = {
  name: "text-fontkit",
  driver: "nativeGpuHeadless",
  buildProject,
  compositionId: "comp-text",
  frame: 0,
  width: WIDTH,
  height: HEIGHT,
  seed: "golden-text-fontkit",
  textRequirements: [
    { node: TEXT_REQUIREMENT_NODE, fontFixtureFileName: "Inter-Variable.ttf", backend: "fontkit" },
  ],
};
