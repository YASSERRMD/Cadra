import type { Composition } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { encodePixelBufferToPng } from "./png-codec.js";
import { renderBrowserGoldenScene } from "./render-browser-scene.js";
import { motionBlurScene, pathTracedScene, postProcessingScene } from "./scenes/index.js";
import { isRealChromiumAvailable } from "./test-support/environment-checks.js";

const chromiumAvailable = isRealChromiumAvailable();

/** How many of a `PixelBuffer`'s pixels have any non-zero color/alpha channel at all. */
function countNonBlankPixels(data: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i] ?? 0) > 0 || (data[i + 1] ?? 0) > 0 || (data[i + 2] ?? 0) > 0 || (data[i + 3] ?? 0) > 0) {
      count += 1;
    }
  }
  return count;
}

/**
 * How many of a `PixelBuffer`'s pixels have any non-zero *color* channel
 * specifically - unlike `countNonBlankPixels`, an opaque-but-solid-black
 * pixel (`[0, 0, 0, 255]`) does not count. A real regression (a broken
 * post-processing node degenerating its whole output to solid black) still
 * renders fully opaque, so `countNonBlankPixels` alone cannot catch it; this
 * is exactly the gap that let a previous `chromaticAberration` bug (three.js's
 * own `ChromaticAberrationNode` silently producing solid black when its
 * `center` argument is left at its documented-but-unimplemented `null`
 * default; see `post-processing-pipeline.ts`'s own `"chromaticAberration"`
 * case) pass this file's own A/B test undetected: a solid-black `withEffects`
 * still "differs" from a correctly-lit `withoutEffects` baseline by a large,
 * threshold-clearing pixel count.
 */
function countNonBlackPixels(data: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i] ?? 0) > 0 || (data[i + 1] ?? 0) > 0 || (data[i + 2] ?? 0) > 0) {
      count += 1;
    }
  }
  return count;
}

/**
 * Real, non-mocked coverage that `driver: "browser"` curated scenes
 * actually render through a real headless-Chromium page without throwing
 * and produce real, non-blank pixel output - this package's own equivalent
 * of `render-composition-headless-server.e2e.test.ts`'s "renders a real
 * scene" coverage in `@cadra/encode`.
 */
describe("renderBrowserGoldenScene: real headless-Chromium renders", () => {
  it(
    "renders the path-traced scene to a non-blank PixelBuffer at the scene's own size",
    async () => {
      if (!chromiumAvailable) {
        return;
      }

      const pixels = await renderBrowserGoldenScene(pathTracedScene);

      expect(pixels.width).toBe(pathTracedScene.width);
      expect(pixels.height).toBe(pathTracedScene.height);
      expect(pixels.data.length).toBe(pathTracedScene.width * pathTracedScene.height * 4);
      expect(countNonBlankPixels(pixels.data)).toBeGreaterThan(0);

      const pngBytes = encodePixelBufferToPng(pixels);
      expect(pngBytes.length).toBeGreaterThan(0);
    },
    // A real browser launch plus a real path-traced render comfortably
    // exceeds Vitest's 5s default under concurrent load (this package's
    // other real-GPU/real-browser test files running at the same time);
    // see compare-references.e2e.test.ts's own identical timeout.
    30_000,
  );

  it(
    "renders the motion-blur scene to a non-blank PixelBuffer at the scene's own size",
    async () => {
      if (!chromiumAvailable) {
        return;
      }

      const pixels = await renderBrowserGoldenScene(motionBlurScene);

      expect(pixels.width).toBe(motionBlurScene.width);
      expect(pixels.height).toBe(motionBlurScene.height);
      expect(pixels.data.length).toBe(motionBlurScene.width * motionBlurScene.height * 4);
      expect(countNonBlankPixels(pixels.data)).toBeGreaterThan(0);

      const pngBytes = encodePixelBufferToPng(pixels);
      expect(pngBytes.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it(
    "produces a real, visible motionBlur effect: a same-scene A/B render differs by more than a rounding-level amount",
    async () => {
      if (!chromiumAvailable) {
        return;
      }

      const withBlur = await renderBrowserGoldenScene(motionBlurScene);

      // The exact same scene, minus postProcessing entirely: motion-blur-scene.ts's
      // own doc explains why this A/B comparison (rather than, say, a fixed
      // reference image) is what actually caught motionBlur's own
      // driver-specific gap in the first place.
      const withoutBlurScene = {
        ...motionBlurScene,
        buildProject: () => {
          const project = motionBlurScene.buildProject();
          return {
            ...project,
            compositions: project.compositions.map((composition): Composition =>
              composition.id === motionBlurScene.compositionId
                ? { ...composition, postProcessing: undefined }
                : composition,
            ),
          };
        },
      };
      const withoutBlur = await renderBrowserGoldenScene(withoutBlurScene);

      let diffPixelCount = 0;
      for (let i = 0; i < withBlur.data.length; i += 4) {
        const rDiff = Math.abs(withBlur.data[i]! - withoutBlur.data[i]!);
        const gDiff = Math.abs(withBlur.data[i + 1]! - withoutBlur.data[i + 1]!);
        const bDiff = Math.abs(withBlur.data[i + 2]! - withoutBlur.data[i + 2]!);
        if (rDiff > 2 || gDiff > 2 || bDiff > 2) {
          diffPixelCount += 1;
        }
      }

      // A genuine blur streak covers a meaningful swath of the moving box's
      // own silhouette, not just a handful of anti-aliased edge texels: this
      // threshold is comfortably below what a real shutterAngle: 360 sweep
      // produces (see this scene's own doc) while still failing hard on the
      // previously-reported "zero difference" symptom.
      expect(diffPixelCount).toBeGreaterThan(500);
    },
    30_000,
  );

  it(
    "renders the post-processing scene to a non-blank PixelBuffer at the scene's own size",
    async () => {
      if (!chromiumAvailable) {
        return;
      }

      const pixels = await renderBrowserGoldenScene(postProcessingScene);

      expect(pixels.width).toBe(postProcessingScene.width);
      expect(pixels.height).toBe(postProcessingScene.height);
      expect(pixels.data.length).toBe(postProcessingScene.width * postProcessingScene.height * 4);
      expect(countNonBlankPixels(pixels.data)).toBeGreaterThan(0);
      // countNonBlankPixels alone would still pass on a fully opaque, solid-
      // black degenerate render (alpha > 0 everywhere): see
      // countNonBlackPixels's own doc for the real bug this exact gap once
      // let through undetected.
      expect(countNonBlackPixels(pixels.data)).toBeGreaterThan(8000);

      const pngBytes = encodePixelBufferToPng(pixels);
      expect(pngBytes.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it(
    "produces a real, visible effect from the full post-processing stack (lut included): a same-scene A/B render differs by more than a rounding-level amount",
    async () => {
      if (!chromiumAvailable) {
        return;
      }

      const withEffects = await renderBrowserGoldenScene(postProcessingScene);

      // A same-scene A/B diff alone cannot distinguish "the effects render
      // correctly" from "the effects degenerate the whole frame to solid
      // black" (see countNonBlackPixels's own doc for the real bug this
      // exact gap once let through undetected): assert directly that
      // withEffects itself still has substantial real color content, not
      // just that it differs from the baseline below.
      expect(countNonBlackPixels(withEffects.data)).toBeGreaterThan(8000);

      // The exact same scene, minus postProcessing/ambient-occlusion entirely:
      // see post-processing-scene.ts's own doc for why this scene needs a
      // real browser at all - its own lut effect (unlike every other effect
      // it stacks) does not render correctly through the experimental
      // native-Dawn nativeGpuHeadless driver.
      const withoutEffectsScene = {
        ...postProcessingScene,
        buildProject: () => {
          const project = postProcessingScene.buildProject();
          return {
            ...project,
            compositions: project.compositions.map((composition): Composition =>
              composition.id === postProcessingScene.compositionId
                ? { ...composition, postProcessing: undefined, shadowQuality: undefined }
                : composition,
            ),
          };
        },
      };
      const withoutEffects = await renderBrowserGoldenScene(withoutEffectsScene);

      let diffPixelCount = 0;
      for (let i = 0; i < withEffects.data.length; i += 4) {
        const rDiff = Math.abs(withEffects.data[i]! - withoutEffects.data[i]!);
        const gDiff = Math.abs(withEffects.data[i + 1]! - withoutEffects.data[i + 1]!);
        const bDiff = Math.abs(withEffects.data[i + 2]! - withoutEffects.data[i + 2]!);
        if (rDiff > 2 || gDiff > 2 || bDiff > 2) {
          diffPixelCount += 1;
        }
      }

      // Eight stacked effects (bloom/sharpen/chromaticAberration/vignette/
      // filmGrain/lensDistortion/colorGrade/lut) plus ambient occlusion
      // reshape a large share of the frame (measured directly: ~15556/65536
      // px, ~23.7%), not just a thin edge band; this threshold sits
      // comfortably below that while still failing hard on a
      // silently-reverted-to-no-op pipeline.
      expect(diffPixelCount).toBeGreaterThan(8000);
    },
    30_000,
  );
});
