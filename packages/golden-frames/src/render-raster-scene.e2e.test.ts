import { Camera, type Composition, Light, Shape } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { encodePixelBufferToPng } from "./png-codec.js";
import { renderRasterGoldenScene } from "./render-raster-scene.js";
import type { GoldenScene } from "./scenes/golden-scene.js";
import {
  lightingScene,
  materialsScene,
  minimalDefaultsScene,
  postProcessingScene,
  textFontkitScene,
  textOpentypeScene,
} from "./scenes/index.js";
import { buildSingleTrackProject } from "./scenes/shared.js";
import { isNativeGpuAvailable } from "./test-support/environment-checks.js";

/**
 * A minimal lit-box scene with no `postProcessing` of its own, so a caller
 * can add exactly one effect and A/B against this same scene's own
 * unmodified render - not through `postProcessingScene`, which stacks eight
 * effects together and would not isolate a single one.
 */
function buildSharpenProbeScene(): GoldenScene {
  function buildProject() {
    const camera = Camera({
      id: "camera-1",
      transform: { position: [0, 0, 4.5], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    const box = Shape({
      id: "box-1",
      geometryRef: "box",
      transform: { position: [0, 0, 0], rotation: [0.3, 0.5, 0], scale: [1.6, 1.6, 1.6] },
      material: { baseColor: [0.2, 0.25, 0.9, 1], metalness: 0.2, roughness: 0.4 },
    });
    const ambientLight = Light({ id: "light-ambient", lightType: "ambient", intensity: 1 });
    const directionalLight = Light({
      id: "light-directional",
      transform: { position: [2, 3, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
      lightType: "directional",
      intensity: 2,
    });
    const project = buildSingleTrackProject({
      projectId: "p-sharpen-probe",
      compositionId: "comp-sharpen-probe",
      fps: 10,
      durationInFrames: 1,
      width: 256,
      height: 256,
      nodes: [camera, box, ambientLight, directionalLight],
      activeCameraNodeId: "camera-1",
    });
    return project;
  }
  return {
    name: "sharpen-probe",
    driver: "nativeGpuHeadless",
    buildProject,
    compositionId: "comp-sharpen-probe",
    frame: 0,
    width: 256,
    height: 256,
    seed: "golden-sharpen-probe",
  };
}

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
 * pixel (`[0, 0, 0, 255]`) does not count. A same-scene A/B diff test alone
 * cannot distinguish "the effect renders correctly" from "the effect
 * degenerates the whole frame to solid black" (a solid-black result still
 * "differs" from a correctly-lit baseline by a large pixel count); see
 * `render-browser-scene.e2e.test.ts`'s own identical helper for the real
 * `chromaticAberration` bug this exact gap once let through undetected.
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
 * Real, non-mocked coverage that every `driver: "nativeGpuHeadless"`
 * curated scene actually renders through `createNativeGpuHeadlessRenderer`
 * (a real native Dawn/WebGPU device, no browser) without throwing and
 * produces real, non-blank pixel output at the requested size - this
 * package's own equivalent of `render-frame-native-gpu.e2e.test.ts`'s
 * "renders a real scene" coverage, just driven through this harness's own
 * curated scene registry instead of a one-off inline scene.
 *
 * `pathTracedScene` and `motionBlurScene` are deliberately not covered here:
 * both are `driver: "browser"` (see `GoldenSceneDriver`'s own doc - path
 * tracing has no native-GPU-headless path at all; `motionBlurScene` stays on
 * `"browser"` even though it does not strictly need to anymore, see that
 * scene's own doc), so their real-render coverage lives in
 * `render-browser-scene.e2e.test.ts` instead. `postProcessingScene` *is*
 * covered here (`driver: "nativeGpuHeadless"` as of the fixes documented in
 * its own doc comment) - both via the shared non-blank check below and a
 * dedicated, stronger full-stack test further down; a reference-free,
 * single-effect A/B probe (`sharpen` alone, not through `postProcessingScene`)
 * covers the same "does postProcessing genuinely apply at all" regression
 * independently of any one effect's own quirks.
 *
 * Every test below skips cleanly (an early `return` inside a passing test,
 * not `it.skip`) when no real native WebGPU device can be acquired at all,
 * mirroring `render-frame-native-gpu.e2e.test.ts`'s own convention in
 * `@cadra/headless` - see `isNativeGpuAvailable`'s own doc for why there is
 * no cheaper synchronous pre-check.
 */
describe("renderRasterGoldenScene: real native GPU renders (no browser)", () => {
  const nativeGpuAvailable = isNativeGpuAvailable();

  it.each([
    ["materials", materialsScene],
    ["lighting", lightingScene],
    ["minimal-defaults", minimalDefaultsScene],
    ["post-processing", postProcessingScene],
  ] as const)("renders %s to a non-blank PixelBuffer at the scene's own size", async (_label, scene) => {
    if (!(await nativeGpuAvailable)) {
      return;
    }

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
    if (!(await nativeGpuAvailable)) {
      return;
    }

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
    if (!(await nativeGpuAvailable)) {
      return;
    }

    const pixels = await renderRasterGoldenScene(textFontkitScene);

    const nonBlank = countNonBlankPixels(pixels.data);
    expect(nonBlank).toBeGreaterThan((pixels.width * pixels.height) / 100);
  });

  it("renders the minimal-defaults scene's own sphere with real, varied shading, not a flat silhouette (Phase 73 task 6: quality defaults alone)", async () => {
    if (!(await nativeGpuAvailable)) {
      return;
    }

    const pixels = await renderRasterGoldenScene(minimalDefaultsScene);

    // A flat, unlit silhouette (e.g. the default lighting rig silently
    // failing to engage) would still show as non-blank, but every visible
    // texel would share the same one or two gray values. Real key/fill/rim
    // shading produces a wide spread of distinct brightness levels across
    // the sphere's own visible pixels instead.
    const distinctGrayValues = new Set<number>();
    for (let i = 0; i < pixels.data.length; i += 4) {
      const alpha = pixels.data[i + 3] ?? 0;
      if (alpha === 0) {
        continue;
      }
      distinctGrayValues.add(pixels.data[i]!);
    }
    expect(distinctGrayValues.size).toBeGreaterThan(20);
  });

  it("renders the opentype and fontkit text engines to visually similar (not pixel-identical) output for the same content", async () => {
    if (!(await nativeGpuAvailable)) {
      return;
    }

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

  it("produces a real, visible postProcessing effect through this driver: a same-scene A/B render differs by more than a rounding-level amount", async () => {
    if (!(await nativeGpuAvailable)) {
      return;
    }

    const probe = buildSharpenProbeScene();
    const withoutSharpen = await renderRasterGoldenScene(probe);

    const withSharpen: GoldenScene = {
      ...probe,
      buildProject: () => {
        const project = probe.buildProject();
        return {
          ...project,
          compositions: project.compositions.map((composition): Composition =>
            composition.id === probe.compositionId
              ? { ...composition, postProcessing: { effects: [{ type: "sharpen", amount: 2 }] } }
              : composition,
          ),
        };
      },
    };
    const withSharpenPixels = await renderRasterGoldenScene(withSharpen);

    // See countNonBlackPixels's own doc: an A/B diff alone would still pass
    // on a degenerate solid-black withSharpenPixels, since that still
    // "differs" from a correctly-lit baseline.
    expect(countNonBlackPixels(withSharpenPixels.data)).toBeGreaterThan(500);

    let diffPixelCount = 0;
    for (let i = 0; i < withSharpenPixels.data.length; i += 4) {
      const rDiff = Math.abs(withSharpenPixels.data[i]! - withoutSharpen.data[i]!);
      const gDiff = Math.abs(withSharpenPixels.data[i + 1]! - withoutSharpen.data[i + 1]!);
      const bDiff = Math.abs(withSharpenPixels.data[i + 2]! - withoutSharpen.data[i + 2]!);
      if (rDiff > 2 || gDiff > 2 || bDiff > 2) {
        diffPixelCount += 1;
      }
    }

    // A regression guard for a real, previously-shipped bug: createNativeGpuHeadlessRenderer
    // never actually ran its own post-processing pipeline at all (see
    // applyProductionWebGpuBehavior in @cadra/renderer's own doc), so every
    // postProcessing effect silently no-op'd through this driver - this
    // scene's own sharpen kernel is a deliberately simple, single-effect
    // probe for exactly that regression, independent of any one effect's
    // own further quirks (see the fuller postProcessingScene stack test
    // right below for coverage of those).
    expect(diffPixelCount).toBeGreaterThan(500);
  });

  it(
    "produces a real, visible effect from the full post-processing stack (lut included) through this driver: a same-scene A/B render differs by more than a rounding-level amount",
    async () => {
      if (!(await nativeGpuAvailable)) {
        return;
      }

      const withEffects = await renderRasterGoldenScene(postProcessingScene);

      // See countNonBlackPixels's own doc: an A/B diff alone would still
      // pass on a degenerate solid-black withEffects, since that still
      // "differs" from a correctly-lit baseline. This is this file's own
      // mirror of render-browser-scene.e2e.test.ts's identical test, now
      // that postProcessingScene renders correctly through both drivers
      // (see post-processing-scene.ts's own doc) - kept on both so a future
      // driver-specific regression in either one shows up here directly.
      expect(countNonBlackPixels(withEffects.data)).toBeGreaterThan(8000);

      const withoutEffectsScene: GoldenScene = {
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
      const withoutEffects = await renderRasterGoldenScene(withoutEffectsScene);

      let diffPixelCount = 0;
      for (let i = 0; i < withEffects.data.length; i += 4) {
        const rDiff = Math.abs(withEffects.data[i]! - withoutEffects.data[i]!);
        const gDiff = Math.abs(withEffects.data[i + 1]! - withoutEffects.data[i + 1]!);
        const bDiff = Math.abs(withEffects.data[i + 2]! - withoutEffects.data[i + 2]!);
        if (rDiff > 2 || gDiff > 2 || bDiff > 2) {
          diffPixelCount += 1;
        }
      }

      expect(diffPixelCount).toBeGreaterThan(8000);
    },
    30_000,
  );
});
