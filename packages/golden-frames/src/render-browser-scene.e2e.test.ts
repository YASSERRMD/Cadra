import { describe, expect, it } from "vitest";

import { encodePixelBufferToPng } from "./png-codec.js";
import { renderBrowserGoldenScene } from "./render-browser-scene.js";
import { pathTracedScene } from "./scenes/index.js";
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
 *
 * `motionBlurScene` is not a `driver: "browser"` scene (see
 * `GoldenSceneDriver`'s own doc and `motion-blur-scene.ts`'s own doc for
 * why: `motionBlur` was verified to produce zero visible difference
 * through this driver too, so this harness uses the simpler
 * `nativeGpuHeadless` driver for it instead - see
 * `render-raster-scene.e2e.test.ts`).
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
});
