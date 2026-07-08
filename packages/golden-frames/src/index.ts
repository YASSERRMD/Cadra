/**
 * @cadra/golden-frames
 *
 * Phase 71's visual regression harness: renders a curated set of scenes
 * (text via both font engines, materials, lighting, post-processing, motion
 * blur, path tracing) through this codebase's own real render paths
 * (`createNativeGpuHeadlessRenderer` for raster,
 * a dedicated Playwright bridge for path-traced), compares each against a
 * checked-in PNG reference with a tight perceptual tolerance
 * (`comparePixelBuffers`), and provides a one-command flow
 * (`scripts/update-references.mjs`) to accept intended changes after
 * review.
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics.
 */
export const PACKAGE_NAME = "@cadra/golden-frames";

export type { PerceptualDiffResult } from "./perceptual-diff.js";
export {
  comparePixelBuffers,
  DEFAULT_DIFF_RATIO_TOLERANCE,
  DEFAULT_PIXELMATCH_THRESHOLD,
  isWithinTolerance,
  PixelBufferSizeMismatchError,
} from "./perceptual-diff.js";
export { decodePngToPixelBuffer, encodePixelBufferToPng } from "./png-codec.js";
export type { GoldenScene, GoldenSceneDriver, GoldenSceneTextRequirement } from "./scenes/index.js";
export {
  GOLDEN_SCENES,
  lightingScene,
  materialsScene,
  motionBlurScene,
  pathTracedScene,
  postProcessingScene,
  textFontkitScene,
  textOpentypeScene,
} from "./scenes/index.js";
