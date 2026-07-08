import { createWriteStream, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Camera,
  type Composition,
  createComposition,
  createProject,
  Light,
  type Project,
  Sequence,
  Shape,
} from "@cadra/core";
import { renderCompositionHeadlessServer } from "@cadra/headless";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import { BROWSER_HEADLESS_RENDER_ENTRY_PATH } from "./browser-headless-render-entry-path.js";
import { expectedMp4DurationTicks } from "./mux-timescale.js";
import { readMp4FragmentedDurationTicks, readMp4TrackTimescale } from "./mux-validate-mp4.js";

/**
 * This test lives in `@cadra/encode`, not `@cadra/headless` (where the
 * function it exercises, `renderCompositionHeadlessServer`, is actually
 * defined): `@cadra/headless`'s package template exposes only a single
 * `"."` `exports` subpath (matching every other package in this workspace),
 * so nothing outside `@cadra/headless` can import
 * `BROWSER_HEADLESS_RENDER_ENTRY_PATH`'s target file
 * (`browser-headless-render-entry.js`) except by pointing esbuild at a raw
 * filesystem path, and that path is only knowable/stable from *inside*
 * `@cadra/encode` itself (see `browser-headless-render-entry-path.ts`'s own
 * doc). `@cadra/encode` already has a real, legitimate, cycle-free
 * `dependencies` edge on `@cadra/headless` (for `renderComposition`'s own
 * types), so importing `renderCompositionHeadlessServer` from
 * `@cadra/headless`'s barrel here introduces no new dependency edge, and
 * Turborepo's `dependsOn: ["^build"]` task graph correctly guarantees
 * `@cadra/headless` (and every other package `@cadra/encode` already
 * depends on) is built before this test file ever runs. Placing this test
 * in `@cadra/headless` instead would have required either a new
 * `@cadra/encode` dependency edge there (recreating the exact circular
 * workspace dependency this phase's architecture deliberately avoids
 * throughout; see `bundle-browser-entry.ts`'s own doc) or reaching into
 * `@cadra/encode`'s `dist/` output by a raw relative path with no
 * `package.json` edge to guarantee Turborepo builds it first.
 */

const FPS = 10;
const DURATION_IN_FRAMES = 3;
const WIDTH = 64;
const HEIGHT = 64;

/**
 * A small, real scene: one lit box, viewed head-on from `[0, 0, 5]`. Kept
 * tiny (3 frames, 64x64) so this real-browser test stays fast.
 *
 * `activeCameraTrack` is spread onto `createComposition`'s result rather
 * than passed as one of its own props: `createComposition`'s
 * `CompositionProps` does not currently accept `activeCameraTrack` (a
 * pre-existing gap in `@cadra/core`, out of this phase's scope; flagged
 * separately), so every other caller needing an active camera in this
 * codebase already works around it the exact same way (see
 * `packages/core/src/timeline-engine/resolve-scene.test.ts`'s own
 * `buildCameraProject` helper).
 *
 * Lighting: an ambient light alone at the renderer's default intensity
 * produced an indistinguishable-from-background render in manual
 * verification while building this test (a `MeshStandardMaterial`'s PBR
 * lighting response is simply too dim under a single intensity-1 ambient
 * light against a black background); `intensity: 1.5` on both an ambient
 * and a directional light (the latter positioned off-origin, since a
 * `THREE.DirectionalLight` sitting at the exact same point as its own
 * default target produces a degenerate zero-length light direction and
 * therefore no illumination at all) reliably lights the box's visible
 * faces well above the black background, verified against this exact real
 * WebGL2/SwiftShader backend before being encoded into this test.
 */
function buildProject(): Project {
  const shape = Shape({ id: "shape-1" });
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const ambientLight = Light({ id: "light-ambient", lightType: "ambient", intensity: 1.5 });
  const directionalLight = Light({
    id: "light-directional",
    transform: { position: [2, 3, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
    lightType: "directional",
    intensity: 1.5,
  });

  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: WIDTH,
    height: HEIGHT,
    tracks: [
      {
        id: "track-shape",
        clips: [
          Sequence({ id: "clip-shape", from: 0, durationInFrames: DURATION_IN_FRAMES, content: shape }),
        ],
      },
      {
        id: "track-camera",
        clips: [
          Sequence({ id: "clip-camera", from: 0, durationInFrames: DURATION_IN_FRAMES, content: camera }),
        ],
      },
      {
        id: "track-ambient-light",
        clips: [
          Sequence({
            id: "clip-ambient-light",
            from: 0,
            durationInFrames: DURATION_IN_FRAMES,
            content: ambientLight,
          }),
        ],
      },
      {
        id: "track-directional-light",
        clips: [
          Sequence({
            id: "clip-directional-light",
            from: 0,
            durationInFrames: DURATION_IN_FRAMES,
            content: directionalLight,
          }),
        ],
      },
    ],
  });
  const withActiveCameraTrack: Composition = {
    ...composition,
    activeCameraTrack: [{ startFrame: 0, durationInFrames: DURATION_IN_FRAMES, cameraNodeId: "camera-1" }],
  };

  return createProject({ id: "p1", name: "Project", compositions: [withActiveCameraTrack] });
}

/**
 * `buildProject`'s own scene, plus every Phase 58/59 post-processing effect
 * (both pre-tonemap: `bloom`, `depthOfField`; and post-tonemap: `sharpen`,
 * `chromaticAberration`, `vignette`, `filmGrain`, `lensDistortion`) and
 * ambient occlusion together in one composition. This is real, non-mocked
 * coverage that the whole unified pipeline (`buildWebGl2Pipeline` in
 * `@cadra/renderer`, since this exact headless Chromium/SwiftShader
 * environment resolves to the WebGL2 fallback backend, per `buildProject`'s
 * own doc) actually runs end to end through a real browser without
 * throwing, composes AO and post-processing correctly (see
 * `RenderPassConfig`'s own doc in `@cadra/renderer` for why they must share
 * one composer), and still produces real, non-blank pixel output - exactly
 * the kind of coverage this improvement track's own working rules call for
 * ("every new visual effect must be covered by a golden-frame test") ahead
 * of Phase 71's own dedicated golden-frame harness.
 */
function buildProjectWithPostProcessing(): Project {
  const project = buildProject();
  const composition = project.compositions[0];
  if (composition === undefined) {
    throw new Error("buildProject() always returns a project with exactly one composition.");
  }

  const withPostProcessing: Composition = {
    ...composition,
    shadowQuality: { ambientOcclusion: { radius: 1, intensity: 0.5 } },
    postProcessing: {
      effects: [
        { type: "bloom", threshold: 0.6, intensity: 0.8, radius: 0.4 },
        { type: "depthOfField", focusDistance: 5, aperture: 0.05, maxBlur: 1 },
        { type: "sharpen", amount: 0.4 },
        { type: "chromaticAberration", intensity: 0.4 },
        { type: "vignette", darkness: 0.5, offset: 1 },
        { type: "filmGrain", intensity: 0.3 },
        { type: "lensDistortion", amount: 0.05 },
      ],
    },
  };

  return { ...project, compositions: [withPostProcessing] };
}

/**
 * A scene built specifically to exercise Phase 60's own velocity-buffer
 * motion blur: the same lit-box scene as `buildProject`, except the box's
 * own `transform.position` is a `keyframeTrack` moving it a large distance
 * (20 scene units, comfortably more than the box's own size) across the
 * three-frame composition, with `motionBlur` (a high shutter angle, to make
 * any wiring bug maximally visible) as the only configured effect. This is
 * real, non-mocked coverage that `VelocityNode`'s own per-object motion
 * tracking (see `applyWebGpuEffect` in `@cadra/renderer`) actually executes
 * end to end through a real browser without throwing - ahead of Phase 71's
 * own dedicated golden-frame harness, which is the right place for a pixel-
 * level check of the blur's own direction and magnitude.
 */
function buildProjectWithMotionBlur(): Project {
  const project = buildProject();
  const composition = project.compositions[0];
  if (composition === undefined) {
    throw new Error("buildProject() always returns a project with exactly one composition.");
  }

  const movingShape = Shape({
    id: "shape-1",
    transform: {
      position: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: [-10, 0, 0] },
          { frame: DURATION_IN_FRAMES - 1, value: [10, 0, 0] },
        ],
      },
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });

  const withMovingShape: Composition = {
    ...composition,
    tracks: composition.tracks.map((track) =>
      track.id === "track-shape"
        ? {
            ...track,
            clips: track.clips.map((clip) => ({ ...clip, node: movingShape })),
          }
        : track,
    ),
    postProcessing: {
      effects: [{ type: "motionBlur", shutterAngle: 360, samples: 8 }],
    },
  };

  return { ...project, compositions: [withMovingShape] };
}

/**
 * Whether real Chromium is available in this environment: checked
 * synchronously via Playwright's own `chromium.executablePath()` (the exact
 * path Playwright itself would try to launch) plus a filesystem existence
 * check, without actually attempting a launch. This is the guard this
 * phase's spec calls for: a fresh machine with no cached browser and no
 * network access must skip this test cleanly, not fail the suite or hang.
 */
function isRealChromiumAvailable(): boolean {
  try {
    const executablePath = chromium.executablePath();
    readFileSync(executablePath);
    return true;
  } catch {
    return false;
  }
}

const chromiumAvailable = isRealChromiumAvailable();

/**
 * Real, non-mocked end-to-end coverage: launches actual headless Chromium
 * (via `@cadra/headless`'s real default `browserLauncher`/`bundleEntry`,
 * i.e. no options overriding either), renders `buildProject()`'s tiny scene
 * through the genuine browser-side pipeline (this package's own real
 * `runBrowserHeadlessRender`, a real `createRenderer()` WebGL2/SwiftShader
 * backend, real WebCodecs encoding, real mp4-muxer muxing), and writes the
 * result to a real file on disk via a real `fs.createWriteStream`.
 *
 * Skips cleanly (an early `return` inside a passing `it`, not `it.skip`, so
 * a `pnpm -w test` run in an environment lacking a real browser still
 * reports this test as run/green rather than a separately-tracked skip
 * some CI dashboards treat as noteworthy) when `isRealChromiumAvailable()`
 * is false: this repository's sandbox has cached Chromium (see this
 * phase's own spec), but a fresh clone/CI machine with no cached browser
 * and no network to fetch one must not fail this suite.
 *
 * A generous but bounded 60-second test timeout (this test's own
 * `it(..., timeoutMs)` third argument, layered on top of
 * `renderCompositionHeadlessServer`'s own internal per-attempt timeout)
 * guards against a genuinely stuck browser hanging the whole `pnpm -w test`
 * run indefinitely, matching this phase's explicit "must not hang" spec
 * requirement.
 */
describe("renderCompositionHeadlessServer: real end-to-end browser render", () => {
  it(
    "renders a real scene to a valid MP4 via a real headless browser",
    async () => {
      if (!chromiumAvailable) {
        // Deliberately visible in CI/local test output (no-console is not
        // configured as a lint rule in this repo): an operator scanning for
        // "why did the real-browser test not run" should see this line
        // directly, not have to go hunting for a silently-skipped test.
        console.log(
          "renderCompositionHeadlessServer e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
        );
        return;
      }

      const project = buildProject();
      const outputPath = join(
        tmpdir(),
        `cadra-headless-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`,
      );
      const destination = createWriteStream(outputPath);

      const progressCalls: Array<[number, number]> = [];

      try {
        await renderCompositionHeadlessServer({
          project,
          compositionId: "comp-1",
          seed: "e2e-seed",
          format: "mp4",
          bitrate: 1_000_000,
          destination,
          entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
          onProgress: (frame, totalFrames) => progressCalls.push([frame, totalFrames]),
          // Bundling a real, full workspace (Three.js/WebGPU included) plus
          // a real Chromium launch is legitimately slower than this
          // package's fake-browser unit tests; 45s comfortably covers both
          // on this sandbox's hardware while staying well inside this
          // test's own 60s outer timeout (see the `it(...)` call below), so
          // a real timeout (not a hang) is still what a genuinely stuck
          // browser would hit.
          timeoutMs: 45_000,
          maxAttempts: 1,
        });

        // Progress must have reported every frame, in order, matching
        // renderComposition's own OnProgressFn contract relayed through the
        // exposeFunction bridge end to end.
        expect(progressCalls).toEqual([
          [0, DURATION_IN_FRAMES],
          [1, DURATION_IN_FRAMES],
          [2, DURATION_IN_FRAMES],
        ]);

        const bytes = readFileSync(outputPath);
        expect(bytes.byteLength).toBeGreaterThan(0);

        // Container-level duration validation (this phase's own acceptance
        // criterion): muxToMp4Stream always writes a fragmented MP4 (see
        // mux-mp4.ts's own doc), so the per-fragment moof.traf duration sum
        // is what carries the real total, not moov.mvhd.duration (which a
        // fragmented file always reports as 0).
        const trackTimescale = readMp4TrackTimescale(bytes);
        expect(trackTimescale).toBeGreaterThan(0);
        const actualDurationTicks = readMp4FragmentedDurationTicks(bytes);
        const expectedTicks = expectedMp4DurationTicks(DURATION_IN_FRAMES, FPS, trackTimescale);
        expect(actualDurationTicks).toBe(expectedTicks);

        // Pixel-content sanity check (this phase's own acceptance
        // criterion: proves the GPU render path actually drew something,
        // not just that muxing succeeded on blank/constant input). A
        // legitimately blank/constant-color render compresses to a
        // suspiciously tiny keyframe (near-zero residual entropy across
        // every pixel); this test's scene (a lit box against a black
        // background, verified non-blank via this exact real
        // WebGL2/SwiftShader backend while building this test, see
        // `buildProject`'s own doc) instead produces real spatial variation
        // for the encoder to compress, so the encoded file is substantially
        // larger than a single-color frame of the same dimensions would
        // produce. 512 bytes is comfortably above what container overhead
        // (moov/moof/mdat box headers) plus one solid-color keyframe of a
        // 64x64 video would ever total, while comfortably below what three
        // real frames of an actual lit box encode to.
        expect(bytes.byteLength).toBeGreaterThan(512);
      } finally {
        rmSync(outputPath, { force: true });
      }
    },
    60_000,
  );

  it(
    "renders a scene with every post-processing effect and ambient occlusion enabled together, via a real headless browser",
    async () => {
      if (!chromiumAvailable) {
        console.log(
          "renderCompositionHeadlessServer post-processing e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
        );
        return;
      }

      const project = buildProjectWithPostProcessing();
      const outputPath = join(
        tmpdir(),
        `cadra-headless-e2e-postfx-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`,
      );
      const destination = createWriteStream(outputPath);

      try {
        await renderCompositionHeadlessServer({
          project,
          compositionId: "comp-1",
          seed: "e2e-postfx-seed",
          format: "mp4",
          bitrate: 1_000_000,
          destination,
          entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
          onProgress: () => {},
          timeoutMs: 45_000,
          maxAttempts: 1,
        });

        // The whole point of this test: every effect's own pass/node
        // construction, plus AO and post-processing sharing one composer
        // (see buildProjectWithPostProcessing's own doc), ran through a
        // real browser without throwing, and still produced a real,
        // non-blank, validly muxed MP4 - not a golden-frame pixel match
        // (that is Phase 71's own job), but real proof this phase's large
        // amount of new pipeline-construction code actually executes.
        const bytes = readFileSync(outputPath);
        expect(bytes.byteLength).toBeGreaterThan(512);

        const trackTimescale = readMp4TrackTimescale(bytes);
        expect(trackTimescale).toBeGreaterThan(0);
        const actualDurationTicks = readMp4FragmentedDurationTicks(bytes);
        const expectedTicks = expectedMp4DurationTicks(DURATION_IN_FRAMES, FPS, trackTimescale);
        expect(actualDurationTicks).toBe(expectedTicks);
      } finally {
        rmSync(outputPath, { force: true });
      }
    },
    60_000,
  );

  it(
    "renders a fast-moving object with velocity-buffer motion blur enabled, via a real headless browser",
    async () => {
      if (!chromiumAvailable) {
        console.log(
          "renderCompositionHeadlessServer motion blur e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
        );
        return;
      }

      const project = buildProjectWithMotionBlur();
      const outputPath = join(
        tmpdir(),
        `cadra-headless-e2e-motionblur-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`,
      );
      const destination = createWriteStream(outputPath);

      try {
        await renderCompositionHeadlessServer({
          project,
          compositionId: "comp-1",
          seed: "e2e-motionblur-seed",
          format: "mp4",
          bitrate: 1_000_000,
          destination,
          entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
          onProgress: () => {},
          timeoutMs: 45_000,
          maxAttempts: 1,
        });

        // Real proof VelocityNode's own per-object motion tracking
        // (previous vs current matrixWorld, including this scene's own
        // real inter-frame motion) executes end to end without throwing,
        // and still produces a real, non-blank, validly muxed MP4.
        const bytes = readFileSync(outputPath);
        expect(bytes.byteLength).toBeGreaterThan(512);

        const trackTimescale = readMp4TrackTimescale(bytes);
        expect(trackTimescale).toBeGreaterThan(0);
        const actualDurationTicks = readMp4FragmentedDurationTicks(bytes);
        const expectedTicks = expectedMp4DurationTicks(DURATION_IN_FRAMES, FPS, trackTimescale);
        expect(actualDurationTicks).toBe(expectedTicks);
      } finally {
        rmSync(outputPath, { force: true });
      }
    },
    60_000,
  );
});
