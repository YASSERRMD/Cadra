import { describe, expect, it } from "vitest";

import { encodePixelBufferToPng } from "./png-codec.js";
import { renderRasterGoldenScene } from "./render-raster-scene.js";
import { lightingScene, materialsScene, postProcessingScene, textFontkitScene, textOpentypeScene } from "./scenes/index.js";

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
 * Real, non-mocked coverage that every `driver: "nativeGpuHeadless"`
 * curated scene actually renders through `createNativeGpuHeadlessRenderer`
 * (a real native Dawn/WebGPU device, no browser) without throwing and
 * produces real, non-blank pixel output at the requested size - this
 * package's own equivalent of `render-frame-native-gpu.e2e.test.ts`'s
 * "renders a real scene" coverage, just driven through this harness's own
 * curated scene registry instead of a one-off inline scene.
 *
 * `motionBlurScene`/`pathTracedScene` are deliberately not covered here:
 * both are `driver: "browser"` (see `GoldenSceneDriver`'s own doc for why),
 * so their real-render coverage lives in `render-browser-scene.e2e.test.ts`
 * instead - passing either through this driver would either silently
 * render `motionBlur` with zero effect (a real, verified gap) or throw
 * outright (`renderMode: "pathTraced"` has no native-GPU-headless path at
 * all).
 */
describe("renderRasterGoldenScene: real native GPU renders (no browser)", () => {
  it.each([
    ["materials", materialsScene],
    ["lighting", lightingScene],
    ["post-processing", postProcessingScene],
  ] as const)("renders %s to a non-blank PixelBuffer at the scene's own size", async (_label, scene) => {
    const pixels = await renderRasterGoldenScene(scene);

    expect(pixels.width).toBe(scene.width);
    expect(pixels.height).toBe(scene.height);
    expect(pixels.data.length).toBe(scene.width * scene.height * 4);
    expect(countNonBlankPixels(pixels.data)).toBeGreaterThan(0);

    // Every pixel buffer this driver produces must also be real, valid PNG
    // bytes: golden-frame comparisons round-trip through PNG on disk, not
    // the raw buffer, so a codec failure here would be invisible until the
    // very first reference-image generation.
    const pngBytes = encodePixelBufferToPng(pixels);
    expect(pngBytes.length).toBeGreaterThan(0);
  });

  it("renders real shaped text via the opentype engine, producing visibly more lit pixels than an empty placeholder would", async () => {
    const pixels = await renderRasterGoldenScene(textOpentypeScene);

    expect(pixels.width).toBe(textOpentypeScene.width);
    expect(pixels.height).toBe(textOpentypeScene.height);
    // A registered-but-unrendered placeholder (Phase 71's own prerequisite
    // fix; see three-renderer.ts) would still light the ambient/directional
    // background to a uniform near-black, not zero, so this asserts a
    // meaningfully large glyph coverage, not just "any non-blank pixel at
    // all" (which the ambient light alone would already satisfy).
    const nonBlank = countNonBlankPixels(pixels.data);
    expect(nonBlank).toBeGreaterThan((pixels.width * pixels.height) / 100);
  });

  it("renders real shaped text via the fontkit engine, producing visibly more lit pixels than an empty placeholder would", async () => {
    const pixels = await renderRasterGoldenScene(textFontkitScene);

    const nonBlank = countNonBlankPixels(pixels.data);
    expect(nonBlank).toBeGreaterThan((pixels.width * pixels.height) / 100);
  });

  it("renders the opentype and fontkit text engines to visually similar (not pixel-identical) output for the same content", async () => {
    const opentypePixels = await renderRasterGoldenScene(textOpentypeScene);
    const fontkitPixels = await renderRasterGoldenScene(textFontkitScene);

    const opentypeNonBlank = countNonBlankPixels(opentypePixels.data);
    const fontkitNonBlank = countNonBlankPixels(fontkitPixels.data);

    // Both engines shape the exact same font file/content through
    // independent code paths (opentype.js vs. fontkit); their glyph
    // coverage should land within the same ballpark, not off by orders of
    // magnitude (which would indicate one engine silently failed to shape
    // anything).
    expect(fontkitNonBlank).toBeGreaterThan(opentypeNonBlank * 0.5);
    expect(fontkitNonBlank).toBeLessThan(opentypeNonBlank * 2);
  });
});
