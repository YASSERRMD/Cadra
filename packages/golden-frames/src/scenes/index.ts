import type { GoldenScene } from "./golden-scene.js";
import { lightingScene } from "./lighting-scene.js";
import { materialsScene } from "./materials-scene.js";
import { minimalDefaultsScene } from "./minimal-defaults-scene.js";
import { motionBlurScene } from "./motion-blur-scene.js";
import { pathTracedScene } from "./path-traced-scene.js";
import { postProcessingScene } from "./post-processing-scene.js";
import { textFontkitScene, textOpentypeScene } from "./text-scene.js";

export type { GoldenScene, GoldenSceneDriver, GoldenSceneTextRequirement } from "./golden-scene.js";
export { lightingScene } from "./lighting-scene.js";
export { materialsScene } from "./materials-scene.js";
export { minimalDefaultsScene } from "./minimal-defaults-scene.js";
export { motionBlurScene } from "./motion-blur-scene.js";
export { pathTracedScene } from "./path-traced-scene.js";
export { postProcessingScene } from "./post-processing-scene.js";
export { textFontkitScene, textOpentypeScene } from "./text-scene.js";

/**
 * Every curated scene this harness renders and compares against a
 * checked-in reference, covering this phase's own required scope: text
 * (both font engines), materials, lighting, post-processing, motion blur,
 * path tracing, and (Phase 73) quality defaults with zero tuning. Each
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
  minimalDefaultsScene,
];
