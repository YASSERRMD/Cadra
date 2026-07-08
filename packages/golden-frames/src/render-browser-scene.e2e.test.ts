import type { Composition } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { encodePixelBufferToPng } from "./png-codec.js";
import { renderBrowserGoldenScene } from "./render-browser-scene.js";
import { motionBlurScene, pathTracedScene } from "./scenes/index.js";
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
});
