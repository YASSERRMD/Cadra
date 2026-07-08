import {
  Camera,
  createComposition,
  createFrameContext,
  createProject,
  Particles,
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

  /**
   * Phase 67's own explicit acceptance criterion: "a large emitter produces
   * identical particle state for a given frame across runs". Unlike
   * `@cadra/encode`'s own Playwright-based e2e tests, this genuinely
   * exercises the real WebGPU compute path: `renderCompositionHeadlessServer`'s
   * default browser launcher never resolves `navigator.gpu` in this
   * repository's pinned headless Chromium build (see `browser-launcher.ts`'s
   * own `DEFAULT_GPU_LAUNCH_ARGS` doc), so a particle system rendered that
   * way would silently take the CPU-simulated WebGL2 fallback instead of the
   * TSL storage-buffer compute kernel this test actually needs to prove
   * deterministic. `createNativeGpuHeadlessRenderer` forces a real native
   * `GPUDevice` (Dawn, via the `webgpu` npm package) with no browser
   * involved, exactly like this file's own first test, so `renderer.backend`
   * asserting `"webgpu"` below is a real, not incidental, guarantee.
   *
   * Reading back raw pixels (no MP4 encode/mux step in between, unlike
   * `render-composition-headless-server.e2e.test.ts`'s own determinism
   * tests) means two independent renders of the same seed/frame can be
   * asserted byte-identical outright, with no tolerance needed for an
   * unrelated container-timestamp field.
   */
  it(
    "a large particle emitter produces identical particle state for a given frame across two independent real native-GPU renders (Phase 67)",
    async () => {
      let device;
      try {
        device = await createNativeGpuDevice();
      } catch (error) {
        console.log(
          "createNativeGpuHeadlessRenderer particles e2e test: skipping, a real native WebGPU device " +
            `could not be acquired on this machine (${String(error)}).`,
        );
        return;
      }
      device.destroy();

      const width = 64;
      const height = 64;
      const fps = 30;
      const targetFrame = 20;

      function buildParticlesProject() {
        const particles = Particles({
          id: "particles-1",
          maxParticles: 500,
          emissionRate: 500,
          shape: { type: "sphere", radius: 0.3 },
          lifetimeSeconds: 5,
          initialSpeed: 0.5,
          direction: [0, 1, 0],
          spreadAngle: Math.PI,
          startSize: 0.4,
          blendMode: "additive",
          colorOverLife: [
            { time: 0, color: [1, 1, 1, 1] },
            { time: 1, color: [1, 1, 1, 1] },
          ],
        });
        const camera = Camera({
          id: "camera-1",
          transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
        });
        const composition = createComposition({
          id: "comp-1",
          name: "Main",
          fps,
          durationInFrames: targetFrame + 1,
          width,
          height,
          tracks: [
            {
              id: "track-particles",
              clips: [
                Sequence({
                  id: "clip-particles",
                  from: 0,
                  durationInFrames: targetFrame + 1,
                  content: particles,
                }),
              ],
            },
            {
              id: "track-camera",
              clips: [
                Sequence({ id: "clip-camera", from: 0, durationInFrames: targetFrame + 1, content: camera }),
              ],
            },
          ],
        });
        const withActiveCameraTrack = {
          ...composition,
          activeCameraTrack: [
            { startFrame: 0, durationInFrames: targetFrame + 1, cameraNodeId: "camera-1" },
          ],
        };
        return createProject({ id: "p1", name: "Project", compositions: [withActiveCameraTrack] });
      }

      async function renderThroughTargetFrame(): Promise<{
        width: number;
        height: number;
        data: Uint8ClampedArray;
      }> {
        const project = buildParticlesProject();
        const renderer = createNativeGpuHeadlessRenderer();
        try {
          await renderer.init({} as never, { width, height });
          expect(renderer.backend).toBe("webgpu");

          let pixels: { width: number; height: number; data: Uint8ClampedArray } | undefined;
          for (let frame = 0; frame <= targetFrame; frame += 1) {
            const sceneState = resolveSceneAtFrame(project, "comp-1", frame);
            const frameContext = createFrameContext({
              frame,
              fps,
              durationInFrames: targetFrame + 1,
              seed: "e2e-particles-seed",
            });
            renderer.renderFrame(sceneState, frameContext);
            pixels = await renderer.readPixels();
          }
          if (pixels === undefined) {
            throw new Error("expected at least one rendered frame");
          }
          return pixels;
        } finally {
          renderer.dispose();
        }
      }

      const first = await renderThroughTargetFrame();
      const second = await renderThroughTargetFrame();

      expect(second.width).toBe(first.width);
      expect(second.height).toBe(first.height);
      expect(second.data.length).toBe(first.data.length);
      expect(Array.from(second.data)).toEqual(Array.from(first.data));

      // Non-blank sanity check: proves the emitter actually rendered
      // something (additive-blended opaque-white sprites over a black
      // background), not a degenerate all-black frame that would trivially
      // satisfy the equality assertion above.
      let nonBlankPixelCount = 0;
      for (let i = 0; i < first.data.length; i += 4) {
        const r = first.data[i] ?? 0;
        const g = first.data[i + 1] ?? 0;
        const b = first.data[i + 2] ?? 0;
        if (r > 0 || g > 0 || b > 0) {
          nonBlankPixelCount += 1;
        }
      }
      expect(nonBlankPixelCount).toBeGreaterThan(0);
    },
    60_000,
  );
});
