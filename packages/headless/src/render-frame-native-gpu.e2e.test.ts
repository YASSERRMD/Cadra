import {
  Camera,
  createComposition,
  createFrameContext,
  createProject,
  Light,
  Particles,
  resolveSceneAtFrame,
  Sequence,
  Shape,
  Volume,
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

  /**
   * Phase 68's own explicit acceptance criterion: "test god-ray and fog
   * density animation for correctness and determinism". A `volume` node is
   * WebGPU-only (see `VolumeNode`'s own doc): its raymarched smoke needs a
   * real `VolumeNodeMaterial`/`VolumetricLightingModel`, which - like Phase
   * 67's particle compute kernel above - the pinned headless-Chromium build
   * never exercises (`navigator.gpu` never resolves there), so this uses the
   * same real native-GPU path as this file's own particle test.
   *
   * A volume renders nothing at all without a real scene light (density only
   * scales the light actually reaching each raymarch sample; it does not
   * self-illuminate - see that type's own doc). This scene's own light must
   * specifically be a point or spot light: this project's installed
   * `VolumetricLightingModel.js` (`direct()`) skips every light whose own
   * `light.distance` is `undefined` - true of `AmbientLight`/`DirectionalLight`/
   * `HemisphereLight`, which have no such field at all, and false only for
   * `PointLight`/`SpotLight` - a real, non-obvious constraint of this exact
   * Three.js lighting model discovered by this test itself initially
   * rendering fully blank with a directional+ambient combo regardless of
   * density. `driftSpeed` is nonzero, so a real regression in the per-frame
   * uniform update (e.g. this node's own Phase 68 `float(...)` vs.
   * `uniform(...)` bug, caught and fixed before this test was ever run) would
   * make the two independent renders below disagree.
   */
  it(
    "an animated smoke volume renders identical, non-blank frames across two independent real native-GPU renders (Phase 68)",
    async () => {
      let device;
      try {
        device = await createNativeGpuDevice();
      } catch (error) {
        console.log(
          "createNativeGpuHeadlessRenderer volume e2e test: skipping, a real native WebGPU device " +
            `could not be acquired on this machine (${String(error)}).`,
        );
        return;
      }
      device.destroy();

      const width = 64;
      const height = 64;
      const fps = 30;
      const targetFrame = 10;

      function buildVolumeProject() {
        const volume = Volume({
          id: "volume-1",
          shape: { type: "sphere", radius: 1.5 },
          color: [1, 1, 1, 1],
          density: 4,
          noiseFrequency: 1.5,
          driftSpeed: 0.5,
          raymarchSteps: 16,
        });
        const camera = Camera({
          id: "camera-1",
          transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
        });
        const pointLight = Light({
          id: "light-point",
          transform: { position: [2, 2, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
          lightType: "point",
          intensity: 12,
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
              id: "track-volume",
              clips: [
                Sequence({ id: "clip-volume", from: 0, durationInFrames: targetFrame + 1, content: volume }),
              ],
            },
            {
              id: "track-camera",
              clips: [
                Sequence({ id: "clip-camera", from: 0, durationInFrames: targetFrame + 1, content: camera }),
              ],
            },
            {
              id: "track-point-light",
              clips: [
                Sequence({
                  id: "clip-point-light",
                  from: 0,
                  durationInFrames: targetFrame + 1,
                  content: pointLight,
                }),
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
        const project = buildVolumeProject();
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
              seed: "e2e-volume-seed",
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

      // Non-blank sanity check: proves the lit smoke actually rendered
      // something, not a degenerate all-black frame that would trivially
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

  /**
   * Phase 68's own explicit acceptance criterion: "test god-ray ... for
   * correctness and determinism". `godRays` is WebGPU-only (`GodraysNode`
   * raymarches through a real light's own shadow map via TSL), so - like the
   * volume test above - this uses the real native-GPU path rather than the
   * Playwright browser path, which never exposes `navigator.gpu`.
   *
   * A real, shadow-casting directional light plus an occluder mesh
   * (`castShadow: true`) between the light and the rest of the scene gives
   * `GodraysNode`'s own shadow-map sampling actual spatial variation to
   * raymarch through, rather than a degenerate always-lit shadow map -
   * exercising the real `scene.getObjectByName(effect.lightNodeId)` lookup
   * wired up in `@cadra/renderer`'s `applyWebGpuEffect`, not just a
   * construction-only path.
   */
  it(
    "god rays render identical, non-blank frames across two independent real native-GPU renders (Phase 68)",
    async () => {
      let device;
      try {
        device = await createNativeGpuDevice();
      } catch (error) {
        console.log(
          "createNativeGpuHeadlessRenderer god rays e2e test: skipping, a real native WebGPU device " +
            `could not be acquired on this machine (${String(error)}).`,
        );
        return;
      }
      device.destroy();

      const width = 64;
      const height = 64;
      const fps = 30;
      const targetFrame = 3;

      function buildGodRaysProject() {
        const occluder = Shape({
          id: "occluder-1",
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          castShadow: true,
          receiveShadow: true,
        });
        const camera = Camera({
          id: "camera-1",
          transform: { position: [0, 0, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
        });
        const light = Light({
          id: "light-directional",
          transform: { position: [3, 5, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
          lightType: "directional",
          intensity: 2,
          castShadow: true,
          shadow: { mapSize: 512 },
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
              id: "track-occluder",
              clips: [
                Sequence({ id: "clip-occluder", from: 0, durationInFrames: targetFrame + 1, content: occluder }),
              ],
            },
            {
              id: "track-camera",
              clips: [
                Sequence({ id: "clip-camera", from: 0, durationInFrames: targetFrame + 1, content: camera }),
              ],
            },
            {
              id: "track-light",
              clips: [
                Sequence({ id: "clip-light", from: 0, durationInFrames: targetFrame + 1, content: light }),
              ],
            },
          ],
          postProcessing: {
            effects: [{ type: "godRays", lightNodeId: "light-directional", raymarchSteps: 24 }],
          },
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
        const project = buildGodRaysProject();
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
              seed: "e2e-godrays-seed",
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

      // Non-blank sanity check: proves the lit, shadow-cast scene actually
      // rendered something, not a degenerate all-black frame that would
      // trivially satisfy the equality assertion above.
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
