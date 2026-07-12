import { Camera, Light, Text } from "@cadra/core";

import type { GoldenScene, GoldenSceneTextRequirement } from "./golden-scene.js";
import { buildSingleTrackProject } from "./shared.js";

const FPS = 10;
const DURATION_IN_FRAMES = 1;
const WIDTH = 768;
const HEIGHT = 256;
// Every ASCII punctuation mark plus descenders (g, j, p, q, y) mixed with
// x-height and cap-height letters, so a vertical-flip or baseline
// regression shows up as an obvious pixel diff rather than hiding in a
// content string ("Cadra") that happens to still look glyph-shaped when
// mirrored - see build-text-group.test.ts's own regression test for why
// that specifically went unnoticed.
const CONTENT = "Jay. Wow, Quip: Ego; Pi!";
const FONT_SIZE = 0.68;

/**
 * One line of flat MSDF text exercising punctuation and descenders
 * (`.` `,` `:` `;` `!` and `g` `p` `y` `j` `Q`), pinning the fix for the bug
 * where every glyph rendered vertically mirrored within its own
 * (correctly positioned) quad - readable on round/symmetric letters as
 * "just a weird font" but unmistakable on a comma's tail rendering above
 * its dot, or a 'j'/'y' descender rendering above the baseline instead of
 * below it. See `build-text-group.ts`'s `applyGlyphUv` and its own
 * regression test for the fix itself.
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
    transform: { position: [-3.0, -0.2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const ambientLight = Light({ id: "light-ambient", lightType: "ambient", intensity: 1.5 });
  const directionalLight = Light({
    id: "light-directional",
    transform: { position: [2, 3, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
    lightType: "directional",
    intensity: 1.5,
  });

  return buildSingleTrackProject({
    projectId: "p-text-punctuation",
    compositionId: "comp-text-punctuation",
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

export const textPunctuationScene: GoldenScene = {
  name: "text-punctuation",
  driver: "nativeGpuHeadless",
  buildProject,
  compositionId: "comp-text-punctuation",
  frame: 0,
  width: WIDTH,
  height: HEIGHT,
  seed: "golden-text-punctuation",
  textRequirements: [
    { node: TEXT_REQUIREMENT_NODE, fontFixtureFileName: "Inter-Variable.ttf", backend: "opentype" },
  ],
};
