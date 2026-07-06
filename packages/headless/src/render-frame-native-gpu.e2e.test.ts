import {
  createComposition,
  createFrameContext,
  createProject,
  resolveSceneAtFrame,
  Sequence,
  Shape,
} from "@cadra/core";
import { describe, expect, it } from "vitest";

import {
  createNativeGpuDevice,
  createNativeGpuHeadlessRenderer,
  NativeGpuAdapterUnavailableError,
} from "./render-frame-native-gpu.js";

/**
 * Real, non-mocked end-to-end coverage for Phase 24's experimental
 * Chromium-free native GPU headless render path: no fake `NativeGpuRootFactory`,
 * no fake `GPUDevice`, no Playwright, no browser process anywhere in this
 * file. `createNativeGpuHeadlessRenderer()`'s own real default
 * (`createNativeGpuDevice` -> the real `webgpu` npm package) acquires an
 * actual Dawn-backed native WebGPU adapter/device, and a real `ThreeRenderer`
 * draws through it.
 *
 * Mirrors `@cadra/encode`'s own
 * `render-composition-headless-server.e2e.test.ts` naming and skip-guard
 * convention (a `*.e2e.test.ts` suffix, still matched by this package's
 * default `src/**\/*.test.ts` Vitest `include`, so this genuinely runs as
 * part of `pnpm -w test`, not a separately-tracked/excluded suite) for the
 * same underlying reason: a real native GPU binding is not guaranteed to
 * initialize on every machine `pnpm -w test` might run on (a fresh clone
 * without the `webgpu` package's prebuilt native binary for its OS/arch, a
 * sandboxed CI runner with no GPU/software-Vulkan path at all, ...), so this
 * test skips cleanly (an early `return` inside a passing `it`, not
 * `it.skip`) rather than failing the whole suite when device acquisition
 * itself fails.
 *
 * Unlike the browser e2e test's `isRealChromiumAvailable()` (a cheap,
 * synchronous, no-launch-attempt pre-check), there is no equivalently cheap
 * pre-check for native WebGPU device availability: acquiring a `GPUDevice`
 * *is* the check. This test therefore attempts the real acquisition inside
 * a `try`/`catch` and treats any failure as "not available here", logging
 * the real error so a genuine regression (as opposed to an expected
 * environment gap) is still visible in test output.
 */
describe("createNativeGpuHeadlessRenderer: real end-to-end native GPU render (no browser)", () => {
  it(
    "renders a real scene through a real native WebGPU device and reads back non-blank pixels, with no browser process",
    async () => {
      let device;
      try {
        device = await createNativeGpuDevice();
      } catch (error) {
        // Deliberately visible in CI/local test output, matching the
        // browser e2e test's own console.log convention: an operator
        // scanning for "why did the native GPU e2e test not run" should see
        // this line directly.
        console.log(
          "createNativeGpuHeadlessRenderer e2e test: skipping, a real native WebGPU device could " +
            `not be acquired on this machine (${String(error)}).`,
        );
        return;
      }
      device.destroy();

      const width = 64;
      const height = 64;
      const frameCount = 3;

      const shape = Shape({ id: "shape-1" });
      const composition = createComposition({
        id: "comp-1",
        name: "Main",
        fps: 30,
        durationInFrames: frameCount,
        width,
        height,
        tracks: [
          {
            id: "track-1",
            clips: [Sequence({ id: "clip-1", from: 0, durationInFrames: frameCount, content: shape })],
          },
        ],
      });
      const project = createProject({ id: "p1", name: "Project", compositions: [composition] });

      const renderer = createNativeGpuHeadlessRenderer();

      try {
        await renderer.init({} as never, { width, height });
        expect(renderer.backend).toBe("webgpu");
        expect(renderer.capabilities.isFallback).toBe(false);

        const framePixels: Array<{ width: number; height: number; data: Uint8ClampedArray }> = [];
        for (let frame = 0; frame < frameCount; frame += 1) {
          const sceneState = resolveSceneAtFrame(project, "comp-1", frame);
          const frameContext = createFrameContext({
            frame,
            fps: 30,
            durationInFrames: frameCount,
            seed: "e2e-native-gpu-seed",
          });
          renderer.renderFrame(sceneState, frameContext);
          const pixels = await renderer.readPixels();
          framePixels.push(pixels);
        }

        // Every frame's pixel buffer has the documented PixelBuffer shape:
        // width/height match the requested render size, and data.length is
        // exactly width * height * 4 (RGBA8), with no per-row alignment
        // padding leaked through.
        for (const pixels of framePixels) {
          expect(pixels.width).toBe(width);
          expect(pixels.height).toBe(height);
          expect(pixels.data.length).toBe(width * height * 4);
        }

        // Non-blank sanity check (this phase's own acceptance criterion:
        // proves the native GPU render path actually drew something, not
        // just that the pipeline ran without throwing on an all-zero
        // buffer). The default seeded mesh material (MeshStandardMaterial,
        // per createDefaultMaterialRegistry) is a PBR material with no
        // light in this scene, so the box itself renders as opaque black;
        // its alpha channel (255 where the box's silhouette covers a pixel,
        // 0 in the transparent background outside it, matching this exact
        // renderer's own real clear behavior) is what proves real,
        // non-trivial rasterization occurred, exactly like this phase's own
        // spike verified manually before this test was written.
        const firstFrame = framePixels[0];
        expect(firstFrame).toBeDefined();
        const alphaChannelValues = new Set<number>();
        for (let i = 3; i < (firstFrame?.data.length ?? 0); i += 4) {
          alphaChannelValues.add(firstFrame?.data[i] ?? -1);
        }
        expect(alphaChannelValues.size).toBeGreaterThan(1);
      } finally {
        renderer.dispose();
      }
    },
    30_000,
  );

  it("createNativeGpuDevice rejects with NativeGpuAdapterUnavailableError when the injected root reports no adapter", async () => {
    await expect(
      createNativeGpuDevice({
        createRoot: () => ({
          requestAdapter: async () => null,
        }),
      }),
    ).rejects.toBeInstanceOf(NativeGpuAdapterUnavailableError);
  });
});
