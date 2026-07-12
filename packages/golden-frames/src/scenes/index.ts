import {
  aspectRatio9x16Scene,
  aspectRatio16x9Scene,
  aspectRatio21x9Scene,
} from "./aspect-ratio-scene.js";
import type { GoldenScene } from "./golden-scene.js";
import { lightingScene } from "./lighting-scene.js";
import { materialsScene } from "./materials-scene.js";
import { minimalDefaultsScene } from "./minimal-defaults-scene.js";
import { modelScene } from "./model-scene.js";
import { motionBlurScene } from "./motion-blur-scene.js";
import { pathTracedScene } from "./path-traced-scene.js";
import { postProcessingScene } from "./post-processing-scene.js";
import { satoriScene } from "./satori-scene.js";
import { textPunctuationScene } from "./text-punctuation-scene.js";
import { textFontkitScene, textOpentypeScene } from "./text-scene.js";

export {
  aspectRatio9x16Scene,
  aspectRatio16x9Scene,
  aspectRatio21x9Scene,
} from "./aspect-ratio-scene.js";
export type {
  GoldenScene,
  GoldenSceneDriver,
  GoldenSceneModelRequirement,
  GoldenSceneTextRequirement,
} from "./golden-scene.js";
export { lightingScene } from "./lighting-scene.js";
export { materialsScene } from "./materials-scene.js";
export { minimalDefaultsScene } from "./minimal-defaults-scene.js";
export { modelScene } from "./model-scene.js";
export { motionBlurScene } from "./motion-blur-scene.js";
export { pathTracedScene } from "./path-traced-scene.js";
export { postProcessingScene } from "./post-processing-scene.js";
export { satoriScene } from "./satori-scene.js";
export { textPunctuationScene } from "./text-punctuation-scene.js";
export { textFontkitScene, textOpentypeScene } from "./text-scene.js";

/**
 * Every curated scene this harness renders and compares against a
 * checked-in reference, covering this phase's own required scope: text
 * (both font engines), materials, lighting, post-processing, motion blur,
 * path tracing, quality defaults with zero tuning, and (this session) real
 * `ModelNode`/`SatoriNode` rendering - the two scene node kinds this
 * session wired into `render_frames`/`render_scene` but which, until now,
 * had no reference-image regression coverage of their own, so a future
 * change could silently re-break either with nothing catching it. Each
 * `name` doubles as its reference PNG's filename stem (see
 * `reference-path.ts`), so every entry's `name` must be unique and
 * filesystem-safe.
 */
export const GOLDEN_SCENES: readonly GoldenScene[] = [
  materialsScene,
  lightingScene,
  postProcessingScene,
  motionBlurScene,
  pathTracedScene,
  textOpentypeScene,
  textFontkitScene,
  textPunctuationScene,
  minimalDefaultsScene,
  aspectRatio16x9Scene,
  aspectRatio9x16Scene,
  aspectRatio21x9Scene,
  modelScene,
  satoriScene,
];
