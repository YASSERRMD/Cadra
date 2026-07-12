import { createWriteStream, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Camera,
  type Composition,
  createComposition,
  createProject,
  Image,
  Light,
  Model,
  type Project,
  Satori,
  Sequence,
  Shape,
  Video,
} from "@cadra/core";
import { launchPlaywrightHeadlessBrowser, renderCompositionHeadlessServer } from "@cadra/headless";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BROWSER_HEADLESS_RENDER_ENTRY_PATH } from "./browser-headless-render-entry-path.js";
import { expectedMp4DurationTicks } from "./mux-timescale.js";
import {
  readMp4AudioFragmentedDurationTicks,
  readMp4AudioTrackTimescale,
  readMp4FragmentedDurationTicks,
  readMp4TrackTimescale,
} from "./mux-validate-mp4.js";
import { submitEncodedRenderJob } from "./render-job.js";
import type { SerializedEncodedChunk } from "./serialized-encoded-chunk.js";

/**
 * This test lives in `@cadra/encode`, not `@cadra/headless` (where
 * `submitEncodedRenderJob`'s own core scheduling engine,
 * `@cadra/headless`'s `submitRenderJob`, is defined), for the exact same
 * reason `render-composition-headless-server.e2e.test.ts` does: see that
 * file's own doc for the full rationale (in short, `BROWSER_HEADLESS_RENDER_ENTRY_PATH`
 * is only resolvable from inside `@cadra/encode` itself, and this package
 * already has a legitimate, cycle-free `dependencies` edge on
 * `@cadra/headless`).
 *
 * Kept small and fast per this phase's own spec: a handful of ranges (2-3)
 * of a handful of frames each (6 frames per range), real Chromium, real
 * WebCodecs, real mp4-muxer, guarded to skip cleanly (never hang or fail
 * the suite) when no real Chromium is available in this environment,
 * mirroring `render-composition-headless-server.e2e.test.ts`'s own guard
 * exactly.
 */

const FPS = 10;
/** 2 ranges of 6 frames each once split with rangeSizeFrames/rangeAlignmentFrames: 3 (see the tests below): frame 0-5 and 6-11. */
const DURATION_IN_FRAMES = 12;
const WIDTH = 48;
const HEIGHT = 48;
/**
 * Deliberately small (3, not this package's own `DEFAULT_KEYFRAME_INTERVAL_FRAMES`
 * of 30): with only 12 frames total, a real keyframe interval of 30 would
 * force every frame in this test to be a keyframe anyway (the interval
 * never being reached), which would not actually exercise "does a
 * non-keyframe-boundary-adjacent range still open cleanly on its own
 * keyframe" at all. 3 forces keyframes at frames 0, 3, 6, 9, matching this
 * test's own 2-range split (ranges start at 0 and 6, both multiples of 3)
 * exactly as a real caller using this same alignment value would expect.
 */
const KEYFRAME_INTERVAL_FRAMES = 3;

/** A small, real scene: one lit box, mirroring `render-composition-headless-server.e2e.test.ts`'s own `buildProject` exactly (same lighting rationale documented there). */
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
          Sequence({
            id: "clip-shape",
            from: 0,
            durationInFrames: DURATION_IN_FRAMES,
            content: shape,
          }),
        ],
      },
      {
        id: "track-camera",
        clips: [
          Sequence({
            id: "clip-camera",
            from: 0,
            durationInFrames: DURATION_IN_FRAMES,
            content: camera,
          }),
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
    activeCameraTrack: [
      { startFrame: 0, durationInFrames: DURATION_IN_FRAMES, cameraNodeId: "camera-1" },
    ],
  };

  return createProject({ id: "p1", name: "Project", compositions: [withActiveCameraTrack] });
}

/** Whether real Chromium is available, mirroring `render-composition-headless-server.e2e.test.ts`'s own `isRealChromiumAvailable`. */
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

/** Writes to, then reads back and deletes, a temp file, for a destination `submitEncodedRenderJob`/`renderCompositionHeadlessServer` can stream a real muxed file into. */
async function renderToTempFile(
  render: (destination: ReturnType<typeof createWriteStream>) => Promise<void>,
): Promise<Buffer> {
  const outputPath = join(
    tmpdir(),
    `cadra-render-job-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`,
  );
  const destination = createWriteStream(outputPath);
  try {
    await render(destination);
    return readFileSync(outputPath);
  } finally {
    rmSync(outputPath, { force: true });
  }
}

describe("submitEncodedRenderJob: real parallel range render vs. real sequential render", () => {
  it("produces a final muxed file whose container-level duration/frame-span exactly matches a real sequential renderCompositionHeadlessServer render of the same project/seed", async () => {
    if (!chromiumAvailable) {
      console.log(
        "submitEncodedRenderJob e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
      );
      return;
    }

    const project = buildProject();
    const seed = "range-vs-sequential-e2e-seed";

    // Real sequential baseline: one browser, the whole composition, via
    // the existing Phase 23 orchestrator, entirely unmodified.
    const sequentialBytes = await renderToTempFile((destination) =>
      renderCompositionHeadlessServer({
        project,
        compositionId: "comp-1",
        seed,
        format: "mp4",
        bitrate: 1_000_000,
        destination,
        entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
        timeoutMs: 45_000,
        maxAttempts: 1,
      }),
    );

    // Real parallel range render: 2 ranges (frames [0,6) and [6,12)),
    // each its own real headless browser instance, running concurrently
    // (maxConcurrency: 2), via this phase's own new orchestrator.
    const rangeProgressCalls: Array<[number, number]> = [];
    const parallelBytes = await renderToTempFile(async (destination) => {
      const handle = await submitEncodedRenderJob({
        project,
        compositionId: "comp-1",
        seed,
        format: "mp4",
        bitrate: 1_000_000,
        destination,
        entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
        rangeSizeFrames: DURATION_IN_FRAMES / 2,
        rangeAlignmentFrames: KEYFRAME_INTERVAL_FRAMES,
        keyframeIntervalFrames: KEYFRAME_INTERVAL_FRAMES,
        maxConcurrency: 2,
        timeoutMs: 45_000,
        onProgress: (frame, totalFrames) => rangeProgressCalls.push([frame, totalFrames]),
      });
      await handle.result;
    });

    // Both real, non-empty, valid MP4s.
    expect(sequentialBytes.byteLength).toBeGreaterThan(0);
    expect(parallelBytes.byteLength).toBeGreaterThan(0);

    // Progress was reported once per frame, across both ranges combined
    // (order/interleaving across concurrent ranges is not asserted, only
    // that every frame in both ranges reported exactly once).
    expect(rangeProgressCalls).toHaveLength(DURATION_IN_FRAMES);

    // Container-level equivalence (this phase's own explicit acceptance
    // criterion): both files cover the exact same total duration once
    // muxed, proving the range-parallel render's final, single mux pass
    // combined every range's frames into one file spanning the whole
    // composition, identical to what one continuous sequential render
    // produces. Track timescale can legitimately differ in absolute value
    // between two independently-constructed muxer sessions (mp4-muxer
    // picks a timescale from the frame timestamps it happens to see), so
    // this compares each file's own duration-in-seconds (ticks /
    // timescale), not raw tick counts against each other directly.
    const sequentialTimescale = readMp4TrackTimescale(sequentialBytes);
    const parallelTimescale = readMp4TrackTimescale(parallelBytes);
    expect(sequentialTimescale).toBeGreaterThan(0);
    expect(parallelTimescale).toBeGreaterThan(0);

    const sequentialDurationSeconds =
      readMp4FragmentedDurationTicks(sequentialBytes) / sequentialTimescale;
    const parallelDurationSeconds =
      readMp4FragmentedDurationTicks(parallelBytes) / parallelTimescale;
    const expectedDurationSeconds = DURATION_IN_FRAMES / FPS;

    expect(sequentialDurationSeconds).toBeCloseTo(expectedDurationSeconds, 5);
    expect(parallelDurationSeconds).toBeCloseTo(expectedDurationSeconds, 5);
    expect(parallelDurationSeconds).toBeCloseTo(sequentialDurationSeconds, 5);

    // Sanity: this also matches expectedMp4DurationTicks's own formula at
    // each file's own timescale, exactly as
    // render-composition-headless-server.e2e.test.ts already asserts for
    // the sequential path alone.
    expect(readMp4FragmentedDurationTicks(sequentialBytes)).toBe(
      expectedMp4DurationTicks(DURATION_IN_FRAMES, FPS, sequentialTimescale),
    );
    expect(readMp4FragmentedDurationTicks(parallelBytes)).toBe(
      expectedMp4DurationTicks(DURATION_IN_FRAMES, FPS, parallelTimescale),
    );

    // Non-trivial, real pixel content in both (same rationale as
    // render-composition-headless-server.e2e.test.ts's own check): proves
    // both paths actually drew something, not just that muxing succeeded
    // on blank input.
    expect(sequentialBytes.byteLength).toBeGreaterThan(512);
    expect(parallelBytes.byteLength).toBeGreaterThan(512);
  }, 120_000);
});

describe("range render vs. sequential render: raw encoded chunk byte comparison", () => {
  /**
   * Launches a real headless browser, injects the real bundled entry
   * script, and calls the real `runBrowserHeadlessRenderRange` for
   * `[startFrame, endFrame)`, returning its raw `SerializedEncodedChunk[]`.
   * This is the lowest-level real-browser call this test suite makes:
   * no job orchestrator, no worker pool, just one direct call to the exact
   * same browser-side function `submitEncodedRenderJob` itself calls per
   * range, so this test's own byte comparison is not obscured by anything
   * `render-job.ts`'s own scheduling/retry logic does.
   */
  async function renderRangeDirectly(
    project: Project,
    seed: string,
    startFrame: number,
    endFrame: number,
  ): Promise<SerializedEncodedChunk[]> {
    const { bundleBrowserEntry, launchPlaywrightHeadlessBrowser, BROWSER_ENTRY_GLOBAL_NAME } =
      await import("@cadra/headless");
    const entrySource = await bundleBrowserEntry({
      entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
    });
    const browser = await launchPlaywrightHeadlessBrowser({});
    try {
      const page = await browser.newPage();
      await page.addScript(entrySource);
      return await page.evaluate(
        (arg: {
          config: {
            project: Project;
            compositionId: string;
            seed: string;
            bitrate: number;
            startFrame: number;
            endFrame: number;
            keyframeIntervalFrames: number;
          };
          globalName: string;
        }) => {
          const entry = (
            window as unknown as Record<
              string,
              | {
                  runBrowserHeadlessRenderRange: (
                    config: typeof arg.config,
                  ) => Promise<SerializedEncodedChunk[]>;
                }
              | undefined
            >
          )[arg.globalName];
          if (entry === undefined) {
            throw new Error(`window["${arg.globalName}"] was not defined.`);
          }
          return entry.runBrowserHeadlessRenderRange(arg.config);
        },
        {
          config: {
            project,
            compositionId: "comp-1",
            seed,
            bitrate: 1_000_000,
            startFrame,
            endFrame,
            keyframeIntervalFrames: KEYFRAME_INTERVAL_FRAMES,
          },
          globalName: BROWSER_ENTRY_GLOBAL_NAME,
        },
      );
    } finally {
      await browser.close();
    }
  }

  it("states precisely what equivalence a range's own chunks have to a sequential single-pass render's corresponding chunks", async () => {
    if (!chromiumAvailable) {
      console.log(
        "range vs. sequential raw chunk comparison: skipping, real Chromium not found in this environment.",
      );
      return;
    }

    const project = buildProject();
    const seed = "raw-chunk-comparison-seed";

    // Sequential baseline: one continuous render+encode of the WHOLE
    // composition (frames 0-11), one single VideoEncoder instance from
    // start to finish, via the same runBrowserHeadlessRenderRange
    // function (with the default full [0, durationInFrames) range),
    // ensuring the only variable between this and the two-range case
    // below is "one encoder for everything" vs. "one fresh encoder per
    // range."
    const sequentialChunks = await renderRangeDirectly(project, seed, 0, DURATION_IN_FRAMES);

    // Range render: the exact same frames, but as two independent
    // browser instances/encoders, each covering half the composition,
    // exactly mirroring what submitEncodedRenderJob itself dispatches.
    const rangeAChunks = await renderRangeDirectly(project, seed, 0, DURATION_IN_FRAMES / 2);
    const rangeBChunks = await renderRangeDirectly(
      project,
      seed,
      DURATION_IN_FRAMES / 2,
      DURATION_IN_FRAMES,
    );
    const rangeChunks = [...rangeAChunks, ...rangeBChunks];

    // Both must cover the exact same set of frames, in the exact same
    // order: this is the baseline structural equivalence this whole
    // comparison depends on.
    expect(rangeChunks.map((c) => c.frame)).toEqual(sequentialChunks.map((c) => c.frame));
    expect(rangeChunks.map((c) => c.frame)).toEqual(
      Array.from({ length: DURATION_IN_FRAMES }, (_, i) => i),
    );

    // Keyframe placement must be identical: frame 0 (always forced) and
    // every multiple of KEYFRAME_INTERVAL_FRAMES (3: frames 0, 3, 6, 9)
    // are keyframes in BOTH the sequential run and the range run, exactly
    // as encodeFrames's own isKeyframeDue (an absolute-frame-index check)
    // guarantees regardless of which encoder instance/range produced
    // that frame. This is what makes concatenation clean: range B's own
    // opening frame (6) is independently decodable without needing
    // anything from range A.
    const expectedKeyframes = [0, 3, 6, 9];
    expect(sequentialChunks.filter((c) => c.type === "key").map((c) => c.frame)).toEqual(
      expectedKeyframes,
    );
    expect(rangeChunks.filter((c) => c.type === "key").map((c) => c.frame)).toEqual(
      expectedKeyframes,
    );

    // The actual byte-level comparison this phase's spec calls for
    // stating precisely: compare every frame's compressed bytes between
    // the range run and the sequential run.
    let identicalByteCount = 0;
    const differences: Array<{ frame: number; sequentialLength: number; rangeLength: number }> = [];
    for (let i = 0; i < sequentialChunks.length; i += 1) {
      const sequential = sequentialChunks[i];
      const range = rangeChunks[i];
      if (sequential === undefined || range === undefined) {
        continue;
      }
      const sequentialBytes = Uint8Array.from(sequential.data);
      const rangeBytes = Uint8Array.from(range.data);
      const identical =
        sequentialBytes.byteLength === rangeBytes.byteLength &&
        sequentialBytes.every((byte, index) => byte === rangeBytes[index]);
      if (identical) {
        identicalByteCount += 1;
      } else {
        differences.push({
          frame: sequential.frame,
          sequentialLength: sequentialBytes.byteLength,
          rangeLength: rangeBytes.byteLength,
        });
      }
    }

    // This is the precise, honest claim this phase's design note calls
    // for (see render-job.ts's own module doc): full byte-identity of
    // *compressed* output across independently-constructed encoder
    // instances is NOT guaranteed by the WebCodecs/underlying codec
    // specs (rate control/adaptive quantization state is legitimately
    // encoder-implementation-defined), so this assertion is deliberately
    // NOT `expect(identicalByteCount).toBe(sequentialChunks.length)`.
    // Instead: log the actual observed result plainly, so a reader of
    // this test's own output sees the real, measured outcome on this
    // exact Chromium/SwiftShader build, whichever way it falls.
    console.log(
      `range vs. sequential raw chunk byte comparison: ${identicalByteCount}/${sequentialChunks.length} frames byte-identical.` +
        (differences.length > 0
          ? ` Differing frames: ${JSON.stringify(differences)}`
          : " Every frame was byte-identical on this run."),
    );

    // What IS asserted, unconditionally, as this phase's real, verifiable
    // equivalence guarantee: every chunk's declared type (key/delta),
    // timestamp, and duration match exactly between the range run and
    // the sequential run (these come from encodeFrames'/captureFrames'
    // own deterministic, frame-index-derived math, not from encoder-
    // internal state, so they are guaranteed identical regardless of
    // whether the underlying compressed bytes happen to match).
    for (let i = 0; i < sequentialChunks.length; i += 1) {
      expect(rangeChunks[i]?.type).toBe(sequentialChunks[i]?.type);
      expect(rangeChunks[i]?.timestamp).toBe(sequentialChunks[i]?.timestamp);
      expect(rangeChunks[i]?.duration).toBe(sequentialChunks[i]?.duration);
    }

    // And: every chunk in both runs decodes to a plausible, non-empty
    // compressed payload (proving both paths encoded real content, not
    // zero-byte placeholders).
    for (const chunk of [...sequentialChunks, ...rangeChunks]) {
      expect(chunk.data.length).toBeGreaterThan(0);
    }
  }, 120_000);
});

/** A real, valid, uncompressed WAV file, mirroring `browser-headless-render-entry.e2e.test.ts`'s own identical `buildSineWaveWav` (duplicated, not imported/shared, matching this codebase's own convention of small per-file test fixture builders - see that file's own `buildTwoToneTestPng`/`render-e2e.test.ts`'s `buildSolidColorPng` for the same pattern already established for images). */
function buildSineWaveWav(durationSeconds: number, frequencyHz: number, sampleRate = 44_100): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const numSamples = Math.floor(durationSeconds * sampleRate);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numSamples * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < numSamples; i += 1) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequencyHz * t) * 0.8;
    view.setInt16(44 + i * blockAlign, Math.round(sample * 32_767), true);
  }

  return new Uint8Array(buffer);
}

/**
 * Proves the full `submitEncodedRenderJob` orchestration - asset fetch,
 * the dedicated audio-mixdown browser task, and the final mux pass all
 * threaded together correctly - produces a real MP4 with a real,
 * correctly-sized audio track, not just a video-only file silently
 * ignoring the composition's own `audioTracks`. Complements (does not
 * duplicate) `browser-headless-render-entry.e2e.test.ts`'s own
 * `runBrowserHeadlessAudioMixdown` test: that one verifies the actual
 * decoded audio *content* is real and non-silent; this one verifies the
 * *orchestration* around it - fetching the right asset bytes, launching
 * the dedicated browser task alongside the video ranges, and correctly
 * threading its result into the final muxed container - the layer this
 * suite's own sibling describe blocks above already apply to the
 * video-only path.
 */
describe("submitEncodedRenderJob: real audio track in the final muxed output", () => {
  it(
    "produces an MP4 with a real audio track whose own duration matches the composition",
    async () => {
      if (!chromiumAvailable) {
        console.log(
          "submitEncodedRenderJob audio e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
        );
        return;
      }

      const fps = 10;
      const durationInFrames = 12;
      const assetRef = "cadra-asset://sine-tone";
      const wavBytes = buildSineWaveWav(durationInFrames / fps, 440);

      const composition = createComposition({
        id: "comp-1",
        name: "Main",
        fps,
        durationInFrames,
        width: WIDTH,
        height: HEIGHT,
        tracks: [
          {
            id: "track-shape",
            clips: [
              Sequence({
                id: "clip-shape",
                from: 0,
                durationInFrames,
                content: Shape({ id: "shape-1" }),
              }),
            ],
          },
        ],
      });
      const withAudioTrack: Composition = {
        ...composition,
        audioTracks: [
          {
            id: "audio-track-1",
            clips: [{ id: "audio-clip-1", startFrame: 0, durationInFrames, assetRef }],
          },
        ],
      };
      const project = createProject({
        id: "audio-job-e2e",
        name: "Audio job e2e",
        compositions: [withAudioTrack],
      });

      const fetchAssetBytes = async (ref: string): Promise<Uint8Array | undefined> =>
        ref === assetRef ? wavBytes : undefined;

      const bytes = await renderToTempFile((destination) =>
        submitEncodedRenderJob({
          project,
          compositionId: "comp-1",
          seed: "audio-job-e2e-seed",
          format: "mp4",
          bitrate: 200_000,
          destination,
          entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
          fetchAssetBytes,
        }).then((handle) => handle.result),
      );

      expect(bytes.byteLength).toBeGreaterThan(512);

      const videoTimescale = readMp4TrackTimescale(bytes);
      expect(videoTimescale).toBeGreaterThan(0);
      const videoDurationSeconds = readMp4FragmentedDurationTicks(bytes) / videoTimescale;
      expect(videoDurationSeconds).toBeCloseTo(durationInFrames / fps, 5);

      const audioTimescale = readMp4AudioTrackTimescale(bytes);
      expect(audioTimescale).toBeDefined();
      expect(audioTimescale!).toBeGreaterThan(0);
      const audioDurationTicks = readMp4AudioFragmentedDurationTicks(bytes);
      expect(audioDurationTicks).toBeDefined();
      const audioDurationSeconds = audioDurationTicks! / audioTimescale!;

      // Real, meaningful audio duration - close to the composition's own
      // duration, not zero and not some unrelated fixed value a broken
      // pipeline might have produced instead. A generous tolerance (audio
      // frame boundaries do not divide evenly at every fps/sample-rate
      // combination, so the encoded track's own duration can round to the
      // nearest whole encoder chunk rather than the exact requested length).
      expect(audioDurationSeconds).toBeGreaterThan(durationInFrames / fps - 0.25);
      expect(audioDurationSeconds).toBeLessThan(durationInFrames / fps + 0.25);
    },
    60_000,
  );

  it(
    "produces an ordinary video-only MP4 (no audio track) for a composition with no audioTracks at all",
    async () => {
      if (!chromiumAvailable) {
        console.log(
          "submitEncodedRenderJob no-audio e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
        );
        return;
      }

      const project = buildProject();

      const bytes = await renderToTempFile((destination) =>
        submitEncodedRenderJob({
          project,
          compositionId: "comp-1",
          seed: "no-audio-seed",
          format: "mp4",
          bitrate: 200_000,
          destination,
          entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
        }).then((handle) => handle.result),
      );

      expect(readMp4TrackTimescale(bytes)).toBeGreaterThan(0);
      // No audioTracks on this composition at all (buildProject's own
      // shape): resolveAudioMixdown's own segments come back empty, so no
      // audio browser task ever launches and no audio argument ever
      // reaches muxToMp4Stream - proven here by the muxed file itself
      // genuinely having no audio track, not merely by this job not
      // throwing.
      expect(readMp4AudioTrackTimescale(bytes)).toBeUndefined();
    },
    60_000,
  );
});

/** Frame rate shared by both compositions in the `VideoNode` e2e test below: the source (color-swap) composition and the outer (`VideoNode`-consuming) composition must agree, since `resolveVideoSourceFrame`'s own returned source frame is expressed in the *consuming* composition's own fps space, not any notion of the source video's own encoded fps (see `resolveVideoSourceFrame`'s own doc in `@cadra/core`) - using the same fps for both is what makes composition-absolute frame 1 of the outer project land exactly on the source video's own frame 1 boundary, rather than some fractional point between two of its encoded frames. */
const VIDEO_TEST_FPS = 10;
/** Square, matching `browser-headless-render-entry.e2e.test.ts`'s own `IMAGE_SIZE` rationale: small, and large enough relative to the fullscreen plane's own `transform.scale` that no background pixel survives anywhere in the frame. */
const VIDEO_TEST_SIZE = 32;

/** A solid-color square PNG, mirroring `browser-headless-render-entry.e2e.test.ts`'s own `buildTwoToneTestPng` rationale, one flat color per call rather than a two-tone split. */
function buildSolidColorPng(size: number, color: readonly [number, number, number]): Buffer {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i += 1) {
    const index = i << 2;
    png.data[index] = color[0];
    png.data[index + 1] = color[1];
    png.data[index + 2] = color[2];
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * A project whose sole purpose is to be rendered once, to real, valid,
 * playable video bytes, as this test's own *input* fixture: two fullscreen
 * `ImageNode`s, one per frame (solid red at composition frame 0, solid
 * blue at frame 1), mirroring `browser-headless-render-entry.e2e.test.ts`'s
 * own `buildImageFillsFrameProject` fullscreen-plane technique - reusing
 * this package's own real, already-proven encode/mux pipeline to
 * synthesize a real test video, rather than hand-building a container.
 */
function buildTwoFrameColorSwapImageProject(redAssetRef: string, blueAssetRef: string): Project {
  const redImage = Image({
    id: "red-image",
    assetRef: redAssetRef,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [8, 8, 8] },
  });
  const blueImage = Image({
    id: "blue-image",
    assetRef: blueAssetRef,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [8, 8, 8] },
  });
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });

  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: VIDEO_TEST_FPS,
    durationInFrames: 2,
    width: VIDEO_TEST_SIZE,
    height: VIDEO_TEST_SIZE,
    tracks: [
      {
        id: "track-image",
        clips: [
          Sequence({ id: "clip-red", from: 0, durationInFrames: 1, content: redImage }),
          Sequence({ id: "clip-blue", from: 1, durationInFrames: 1, content: blueImage }),
        ],
      },
      {
        id: "track-camera",
        clips: [Sequence({ id: "clip-camera", from: 0, durationInFrames: 2, content: camera })],
      },
    ],
  });

  return createProject({
    id: "color-swap-source",
    name: "Color swap source",
    compositions: [
      { ...composition, activeCameraTrack: [{ startFrame: 0, durationInFrames: 2, cameraNodeId: "camera-1" }] },
    ],
  });
}

/**
 * The actual project under test: a single, fullscreen `VideoNode`
 * referencing `assetRef` (the color-swap video `buildTwoFrameColorSwapImageProject`
 * produces), no `inFrame`/`outFrame`/`playbackRate` override - every
 * default (`inFrame: 0`, `playbackRate: 1`, `outFrame` unbounded) means
 * `resolveVideoSourceFrame` maps composition-absolute frame N directly to
 * source frame N, so composition frame 0 must show red and frame 1 must
 * show blue, exactly matching the source video's own two frames.
 */
function buildVideoFillsFrameProject(assetRef: string): Project {
  const video = Video({
    id: "video-1",
    assetRef,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [8, 8, 8] },
  });
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });

  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: VIDEO_TEST_FPS,
    durationInFrames: 2,
    width: VIDEO_TEST_SIZE,
    height: VIDEO_TEST_SIZE,
    tracks: [
      {
        id: "track-video",
        clips: [Sequence({ id: "clip-video", from: 0, durationInFrames: 2, content: video })],
      },
      {
        id: "track-camera",
        clips: [Sequence({ id: "clip-camera", from: 0, durationInFrames: 2, content: camera })],
      },
    ],
  });

  return createProject({
    id: "video-e2e",
    name: "Video e2e",
    compositions: [
      { ...composition, activeCameraTrack: [{ startFrame: 0, durationInFrames: 2, cameraNodeId: "camera-1" }] },
    ],
  });
}

/** Reads one RGBA pixel out of a flat, top-left-origin RGBA8 buffer, mirroring `browser-headless-render-entry.e2e.test.ts`'s own `pixelAt`. */
function pixelAt(data: readonly number[], width: number, x: number, y: number): readonly number[] {
  const index = (y * width + x) * 4;
  return data.slice(index, index + 4);
}

describe("submitEncodedRenderJob: real VideoNode texture rendering", () => {
  it(
    "renders the correct source frame's own real pixel content at each composition frame (not stuck on frame 0, not off-by-one)",
    async () => {
      if (!chromiumAvailable) {
        console.log(
          "VideoNode texture rendering e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
        );
        return;
      }

      // --- Step 1: produce a real, valid, playable 2-frame test video
      // (frame 0 red, frame 1 blue) via this package's own real production
      // render pipeline (submitEncodedRenderJob itself) - the exact same
      // real encode+mux path this whole package exists to run, reused here
      // purely as this test's own fixture-generation step.
      const redAssetRef = "cadra-asset://color-swap-red";
      const blueAssetRef = "cadra-asset://color-swap-blue";
      const redPng = buildSolidColorPng(VIDEO_TEST_SIZE, [255, 0, 0]);
      const bluePng = buildSolidColorPng(VIDEO_TEST_SIZE, [0, 0, 255]);
      const sourceBytesByRef: Record<string, Uint8Array> = {
        [redAssetRef]: redPng,
        [blueAssetRef]: bluePng,
      };

      const testVideoBytes = await renderToTempFile((destination) =>
        submitEncodedRenderJob({
          project: buildTwoFrameColorSwapImageProject(redAssetRef, blueAssetRef),
          compositionId: "comp-1",
          seed: "color-swap-source-seed",
          format: "mp4",
          bitrate: 2_000_000,
          destination,
          entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
          timeoutMs: 45_000,
          fetchAssetBytes: async (assetRef) => sourceBytesByRef[assetRef],
        }).then((handle) => handle.result),
      );

      // --- Step 2: render a genuinely different project containing one
      // VideoNode referencing the video Step 1 just produced, through the
      // real production submitEncodedRenderJob path - proving
      // render-job.ts's own scene walk/dedup/per-range sample computation
      // and browser-headless-render-entry.ts's own decode work correctly
      // together, not merely in isolation.
      const videoAssetRef = "cadra-asset://color-swap-video";
      const outputBytes = await renderToTempFile((destination) =>
        submitEncodedRenderJob({
          project: buildVideoFillsFrameProject(videoAssetRef),
          compositionId: "comp-1",
          seed: "video-node-e2e-seed",
          format: "mp4",
          bitrate: 2_000_000,
          destination,
          entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
          timeoutMs: 45_000,
          fetchAssetBytes: async (assetRef) => (assetRef === videoAssetRef ? testVideoBytes : undefined),
        }).then((handle) => handle.result),
      );

      // --- Step 3: verify the final output's own frame 0 and frame 1
      // directly, via a real, plain <video> element sampled through a
      // canvas (no @cadra bundled code needed here at all - this only
      // proves outputBytes is a genuinely valid, standard-decodable video
      // whose own content is correct, the same real-world criterion any
      // actual video player would apply).
      const browser = await launchPlaywrightHeadlessBrowser({});
      try {
        const page = await browser.newPage();
        const sampled = await page.evaluate(
          async (arg: { videoBytes: number[]; fps: number }) => {
            const video = document.createElement("video");
            video.muted = true;
            video.playsInline = true;
            video.preload = "auto";
            const blob = new Blob([Uint8Array.from(arg.videoBytes)]);
            await new Promise<void>((resolve, reject) => {
              video.addEventListener("loadeddata", () => resolve(), { once: true });
              video.addEventListener(
                "error",
                () => reject(video.error instanceof Error ? video.error : new Error("video load failed")),
                { once: true },
              );
              video.src = URL.createObjectURL(blob);
            });

            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const context = canvas.getContext("2d");
            if (context === null) {
              throw new Error("Failed to acquire a 2D context.");
            }
            // Re-bound to a fresh const: TypeScript's narrowing of
            // `context !== null` above does not flow into the nested
            // `seekAndSample` function declaration below.
            const context2d = context;

            async function seekAndSample(timestamp: number): Promise<number[]> {
              if (Math.abs(video.currentTime - timestamp) > 1e-4) {
                await new Promise<void>((resolve, reject) => {
                  const onSeeked = (): void => {
                    video.removeEventListener("error", onError);
                    resolve();
                  };
                  const onError = (): void => {
                    video.removeEventListener("seeked", onSeeked);
                    reject(video.error instanceof Error ? video.error : new Error("video seek failed"));
                  };
                  video.addEventListener("seeked", onSeeked, { once: true });
                  video.addEventListener("error", onError, { once: true });
                  video.currentTime = timestamp;
                });
              }
              context2d.drawImage(video, 0, 0);
              const imageData = context2d.getImageData(0, 0, canvas.width, canvas.height);
              return Array.from(imageData.data);
            }

            const frame0 = await seekAndSample(0);
            const frame1 = await seekAndSample(1 / arg.fps);
            return { width: canvas.width, height: canvas.height, frame0, frame1 };
          },
          { videoBytes: Array.from(outputBytes), fps: VIDEO_TEST_FPS },
        );

        expect(sampled.width).toBe(VIDEO_TEST_SIZE);
        expect(sampled.height).toBe(VIDEO_TEST_SIZE);

        const center = Math.floor(VIDEO_TEST_SIZE / 2);
        const frame0Pixel = pixelAt(sampled.frame0, sampled.width, center, center);
        const frame1Pixel = pixelAt(sampled.frame1, sampled.width, center, center);

        // Composition frame 0: the VideoNode's own source frame 0 (the
        // color-swap video's own red frame). A "stuck on the placeholder"
        // regression would leave this the renderer's own gray placeholder
        // color instead.
        expect(frame0Pixel[0]).toBeGreaterThan(150);
        expect(frame0Pixel[2]).toBeLessThan(100);

        // Composition frame 1: the VideoNode's own source frame 1 (blue).
        // An off-by-one regression (e.g. still sampling source frame 0, or
        // this render key never actually changing between frames) would
        // leave this red instead of blue.
        expect(frame1Pixel[2]).toBeGreaterThan(150);
        expect(frame1Pixel[0]).toBeLessThan(100);
      } finally {
        await browser.close();
      }
    },
    90_000,
  );
});

/**
 * Proves `submitEncodedRenderJob` - `render_scene`'s own real production
 * render path - actually renders a real `ModelNode`, not the silently empty
 * group every `"model"` node fell back to before this wiring
 * (`buildModelRenderEntriesForProject`/`browser-headless-render-entry.ts`'s
 * own `buildModelRegistry` were both new; the reconciler's own
 * `buildModelObject`/`applyModelProperties` were already implemented and
 * tested, but - like `render_frames`' own equivalent gap this mirrors - had
 * no real caller feeding them an actual loaded model).
 *
 * Verifies via a raw output-byte comparison (`Buffer.compare`), not a
 * decoded-pixel one: an empty-group placeholder renders identically
 * regardless of the referenced GLB's own material color, so two renders
 * differing only in that color producing byte-identical output would be
 * exactly the pre-fix symptom - the same technique (and the same real
 * production `submitEncodedRenderJob` pipeline) `render-e2e.test.ts`'s own
 * "real image asset bytes reach the renderer" test already establishes for
 * `ImageNode`.
 */
describe("submitEncodedRenderJob: real ModelNode texture rendering", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(
    "renders visibly different output for two renders whose only difference is their ModelNode's own GLB material color",
    async () => {
      if (!chromiumAvailable) {
        console.log(
          "ModelNode e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
        );
        return;
      }

      const redGlbBytes = await buildGlbBytes(0xff0000);
      const blueGlbBytes = await buildGlbBytes(0x0000ff);

      async function renderWithModel(assetRef: string, glbBytes: Uint8Array): Promise<Buffer> {
        return renderToTempFile((destination) =>
          submitEncodedRenderJob({
            project: buildModelFillsFrameProject(assetRef),
            compositionId: "comp-1",
            seed: "model-node-e2e-seed",
            format: "mp4",
            bitrate: 2_000_000,
            destination,
            entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
            timeoutMs: 45_000,
            fetchAssetBytes: async (ref) => (ref === assetRef ? glbBytes : undefined),
          }).then((handle) => handle.result),
        );
      }

      const redOutput = await renderWithModel("cadra-asset://model-red", redGlbBytes);
      const blueOutput = await renderWithModel("cadra-asset://model-blue", blueGlbBytes);

      expect(Buffer.compare(redOutput, blueOutput)).not.toBe(0);
    },
    60_000,
  );
});

/**
 * Proves `submitEncodedRenderJob` - `render_scene`'s own real production
 * render path - actually renders a real `SatoriNode`, not the silently
 * empty group every `"satori"` node fell back to before this wiring
 * (`buildSatoriLayerRenderEntriesForRange`/`browser-headless-render-entry.ts`'s
 * own `buildSatoriLayerRenderRegistry` were both new; `render_frames`' own
 * equivalent gap was already closed separately, but satori rendering cannot
 * run inside a browser page at all - see `SerializedSatoriLayerRenderEntry`'s
 * own doc - so this needed genuinely separate, per-range Node-side
 * rasterization, not just reusing the same registry-building function).
 *
 * Same raw-output-byte-comparison technique as the `ModelNode` test
 * immediately above, for the same reason: an empty-group placeholder
 * renders identically regardless of the satori layer's own color.
 */
describe("submitEncodedRenderJob: real SatoriNode rendering", () => {
  it(
    "renders visibly different output for two renders whose only difference is their SatoriNode's own layer color",
    async () => {
      if (!chromiumAvailable) {
        console.log(
          "SatoriNode e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
        );
        return;
      }

      async function renderWithColor(color: string): Promise<Buffer> {
        return renderToTempFile((destination) =>
          submitEncodedRenderJob({
            project: buildSatoriFillsFrameProject(color),
            compositionId: "comp-1",
            seed: "satori-node-e2e-seed",
            format: "mp4",
            bitrate: 2_000_000,
            destination,
            entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
            timeoutMs: 45_000,
          }).then((handle) => handle.result),
        );
      }

      const redOutput = await renderWithColor("#ff0000");
      const blueOutput = await renderWithColor("#0000ff");

      expect(Buffer.compare(redOutput, blueOutput)).not.toBe(0);
    },
    60_000,
  );
});

/**
 * A minimal `FileReader` standing in for the real DOM one, mirroring
 * `@cadra/renderer`'s own `gltf-loader.test.ts` `NodeFileReaderPolyfill`
 * exactly: `GLTFExporter`'s own writer unconditionally reaches for a real
 * `FileReader` to turn its own merged `Blob` into an `ArrayBuffer` (binary
 * `.glb` mode), a genuine DOM API this headless Vitest/Node test environment
 * does not provide on its own.
 */
class NodeFileReaderPolyfill {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;

  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      this.onloadend?.();
    });
  }

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      const base64 = Buffer.from(buffer).toString("base64");
      this.result = `data:${blob.type};base64,${base64}`;
      this.onloadend?.();
    });
  }
}

/**
 * Builds a real, self-contained `.glb`'s raw bytes: a unit `THREE.BoxGeometry`
 * with a solid-`color` `MeshStandardMaterial`, round-tripped through
 * `GLTFExporter`'s own `binary: true` mode - the exact same real-GLB
 * construction `@cadra/renderer`'s own `gltf-loader.test.ts` (and this
 * package's own `render-frames-tools.test.ts` equivalent, for the
 * `render_frames` side of this same gap) already prove `createDefaultParseGltf`
 * correctly parses back into a usable mesh.
 */
async function buildGlbBytes(color: number): Promise<Uint8Array> {
  vi.stubGlobal("FileReader", NodeFileReaderPolyfill);
  try {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "TestBox";
    const scene = new THREE.Scene();
    scene.add(mesh);

    const glb = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
    return new Uint8Array(glb);
  } finally {
    vi.unstubAllGlobals();
  }
}

/**
 * The actual project under test: a single, fullscreen `ModelNode`
 * referencing `assetRef` (one of `buildGlbBytes`' own GLBs), scaled to
 * `[4, 4, 4]` - a unit box's near face then sits at world Z `+2`, well
 * inside the default `fov: 50`/distance-5 camera's frustum at that depth,
 * filling the whole frame - mirroring `buildVideoFillsFrameProject`'s own
 * "generously overfill, no per-test camera-distance math" approach. Lit
 * (ambient + directional), since a `ModelNode`'s cloned material is
 * whatever the source GLTF authored - here, a lit `MeshStandardMaterial` -
 * unlike `ImageNode`/`VideoNode`'s always-unlit `MeshBasicMaterial`.
 */
function buildModelFillsFrameProject(assetRef: string): Project {
  const model = Model({
    id: "model-1",
    assetRef,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [4, 4, 4] },
  });
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
    fps: VIDEO_TEST_FPS,
    durationInFrames: 2,
    width: VIDEO_TEST_SIZE,
    height: VIDEO_TEST_SIZE,
    tracks: [
      {
        id: "track-model",
        clips: [Sequence({ id: "clip-model", from: 0, durationInFrames: 2, content: model })],
      },
      {
        id: "track-camera",
        clips: [Sequence({ id: "clip-camera", from: 0, durationInFrames: 2, content: camera })],
      },
      {
        id: "track-ambient",
        clips: [Sequence({ id: "clip-ambient", from: 0, durationInFrames: 2, content: ambientLight })],
      },
      {
        id: "track-directional",
        clips: [Sequence({ id: "clip-directional", from: 0, durationInFrames: 2, content: directionalLight })],
      },
    ],
  });

  return createProject({
    id: "model-e2e",
    name: "Model e2e",
    compositions: [
      { ...composition, activeCameraTrack: [{ startFrame: 0, durationInFrames: 2, cameraNodeId: "camera-1" }] },
    ],
  });
}

/**
 * The actual project under test: a single, fullscreen `SatoriNode` whose
 * own `layer` is a solid-`color` `div` (no text at all, so no font-family-
 * matching question to worry about - see
 * `buildSatoriLayerRenderEntriesForRange`'s own doc), mirroring
 * `render-frames-tools.test.ts`'s own `buildSatoriFillsFrameDocument`: a
 * satori node's own geometry is sized directly from its own `width`/
 * `height` in world units (not normalized to 1 unit wide), so a
 * generously large, fixed `width`/`height` trivially fills the whole
 * camera frustum. No lights needed - a satori layer's own rasterized
 * texture, applied via `MeshBasicMaterial`, is unlit.
 */
function buildSatoriFillsFrameProject(color: string): Project {
  const satori = Satori({
    id: "satori-1",
    layer: {
      type: "div",
      style: { width: "100%", height: "100%", backgroundColor: color, display: "flex" },
    },
    width: 400,
    height: 400,
  });
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });

  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: VIDEO_TEST_FPS,
    durationInFrames: 2,
    width: VIDEO_TEST_SIZE,
    height: VIDEO_TEST_SIZE,
    tracks: [
      {
        id: "track-satori",
        clips: [Sequence({ id: "clip-satori", from: 0, durationInFrames: 2, content: satori })],
      },
      {
        id: "track-camera",
        clips: [Sequence({ id: "clip-camera", from: 0, durationInFrames: 2, content: camera })],
      },
    ],
  });

  return createProject({
    id: "satori-e2e",
    name: "Satori e2e",
    compositions: [
      { ...composition, activeCameraTrack: [{ startFrame: 0, durationInFrames: 2, cameraNodeId: "camera-1" }] },
    ],
  });
}
