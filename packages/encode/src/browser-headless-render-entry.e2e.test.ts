import { readFileSync } from "node:fs";

import {
  Camera,
  type Composition,
  createComposition,
  createProject,
  Image,
  type Project,
  Sequence,
} from "@cadra/core";
import { BROWSER_ENTRY_GLOBAL_NAME, bundleBrowserEntry, launchPlaywrightHeadlessBrowser } from "@cadra/headless";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { BROWSER_HEADLESS_RENDER_ENTRY_PATH } from "./browser-headless-render-entry-path.js";
import type { SerializedEncodedAudioChunk, SerializedEncodedChunk } from "./serialized-encoded-chunk.js";

/**
 * This test lives in `@cadra/encode` for the same reason
 * `render-composition-headless-server.e2e.test.ts` does: see that file's
 * own doc for the full rationale (in short, `BROWSER_HEADLESS_RENDER_ENTRY_PATH`
 * is only resolvable from inside `@cadra/encode` itself).
 *
 * Whether real Chromium is available in this environment, mirroring
 * `render-composition-headless-server.e2e.test.ts`'s own
 * `isRealChromiumAvailable` exactly (see that file's doc for the full
 * rationale for this guard shape).
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

/** Small and comfortably interior: axis-aligned fillRect at integer coordinates has no anti-aliased edge pixels to worry about. */
const SIZE = { width: 24, height: 24 };
const BOX_A = { x: 2, y: 2, w: 6, h: 6, color: [255, 0, 0] as const };
const BOX_B = { x: 16, y: 16, w: 6, h: 6, color: [0, 0, 255] as const };
/** Sample points well inside each box, far from its edges and from the other box. */
const POINT_A = { x: 5, y: 5 };
const POINT_B = { x: 19, y: 19 };
const TRANSPARENT = [0, 0, 0, 0];

/** Reads one RGBA pixel out of a flat, top-left-origin RGBA8 buffer, mirroring `PixelBuffer`'s own documented layout. */
function pixelAt(data: readonly number[], width: number, x: number, y: number): readonly number[] {
  const index = (y * width + x) * 4;
  return data.slice(index, index + 4);
}

/**
 * Regression coverage for the real, non-mocked `createRealReadPixels`
 * (the browser-side snapshot-canvas `readPixels` every real headless render
 * uses): a render's snapshot canvas is created once and only resized (never
 * recreated) across an entire render's worth of frames, and a resize to the
 * *same* size (every frame after the first, for any render at a constant
 * resolution) does not implicitly clear it. Without a `clearRect` before
 * each frame's `drawImage`, a render target that clears to transparent
 * between frames (the common case: only actual geometry is opaque) leaves
 * every earlier frame's opaque pixels composited into the readback forever,
 * silently corrupting every real multi-frame render's output.
 *
 * Exercises the real exported `createRealReadPixels` inside a real
 * Chromium page (via the same `bundleBrowserEntry`/
 * `launchPlaywrightHeadlessBrowser` real-browser plumbing every other e2e
 * test in this file's sibling suite uses), fed synthetic frames directly
 * rather than a full render/encode/mux pass: this isolates the assertion to
 * exactly the function the bug lives in, with no WebGL/WebGPU renderer,
 * WebCodecs encoder, or muxer in the loop to obscure a failure or make the
 * test flaky/slow.
 */
describe("createRealReadPixels: cross-frame contamination regression", () => {
  it(
    "does not composite a previous frame's opaque pixels into a region the current frame leaves transparent",
    async () => {
      if (!chromiumAvailable) {
        console.log(
          "createRealReadPixels e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
        );
        return;
      }

      const entrySource = await bundleBrowserEntry({
        entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
      });
      const browser = await launchPlaywrightHeadlessBrowser({});
      try {
        const page = await browser.newPage();
        await page.addScript(entrySource);

        const frames = await page.evaluate(
          async (arg: {
            globalName: string;
            size: { width: number; height: number };
            boxes: Array<{ x: number; y: number; w: number; h: number; color: readonly number[] }>;
          }) => {
            const entry = (
              window as unknown as Record<
                string,
                | {
                    createRealReadPixels: () => (
                      target: HTMLCanvasElement,
                      size: { width: number; height: number },
                    ) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
                  }
                | undefined
              >
            )[arg.globalName];
            if (entry === undefined) {
              throw new Error(`window["${arg.globalName}"] was not defined.`);
            }

            // The real function under test, called exactly as
            // `buildEncodedChunksForRange` itself calls it: once, up front,
            // reusing the one closure (and its one snapshot canvas) across
            // every frame below.
            const readPixels = entry.createRealReadPixels();

            // One real target canvas, reused and redrawn every "frame",
            // exactly like the real render loop's single persistent render
            // canvas: only its content changes between calls, never its
            // identity or size.
            const targetCanvas = document.createElement("canvas");
            targetCanvas.width = arg.size.width;
            targetCanvas.height = arg.size.height;
            const targetContext = targetCanvas.getContext("2d");
            if (targetContext === null) {
              throw new Error("Failed to acquire a 2D context for the synthetic target canvas.");
            }

            // Sequential, not Promise.all/map: a real render always drives
            // frames one at a time, and this loop's own correctness
            // (mutating the shared targetCanvas between reads) depends on
            // each readPixels call fully finishing before the next frame is
            // drawn.
            const capturedFrames: number[][] = [];
            for (const box of arg.boxes) {
              // Transparent background, exactly like a WebGL/WebGPU render
              // target cleared to (0,0,0,0) with only actual geometry drawn
              // opaque: this is what makes the missing-`clearRect` bug
              // observable at all (a source that is opaque everywhere would
              // fully overwrite the snapshot regardless of whether it was
              // cleared first).
              targetContext.clearRect(0, 0, arg.size.width, arg.size.height);
              targetContext.fillStyle = `rgb(${box.color[0]}, ${box.color[1]}, ${box.color[2]})`;
              targetContext.fillRect(box.x, box.y, box.w, box.h);

              const pixels = await readPixels(targetCanvas, arg.size);
              capturedFrames.push(Array.from(pixels.data));
            }

            return capturedFrames;
          },
          {
            globalName: BROWSER_ENTRY_GLOBAL_NAME,
            size: SIZE,
            // Box A, then box B (A moves fully out of frame), then box A
            // again: three frames is enough to prove both "a vacated region
            // clears" and "it stays clear/correct across more than one
            // subsequent frame," not just a single before/after pair.
            boxes: [BOX_A, BOX_B, BOX_A],
          },
        );

        expect(frames).toHaveLength(3);
        for (const frame of frames) {
          expect(frame).toHaveLength(SIZE.width * SIZE.height * 4);
        }

        const [frame0, frame1, frame2] = frames as [number[], number[], number[]];

        // Frame 0: only box A has ever been drawn. Box B's region has
        // never had anything drawn there, so it must read back transparent.
        expect(pixelAt(frame0, SIZE.width, POINT_A.x, POINT_A.y)).toEqual([...BOX_A.color, 255]);
        expect(pixelAt(frame0, SIZE.width, POINT_B.x, POINT_B.y)).toEqual(TRANSPARENT);

        // Frame 1: box A has moved fully away to box B's position. This is
        // the critical regression assertion: box A's now-vacated region
        // must read back transparent (background), not still show box A's
        // opaque color left over from frame 0's snapshot.
        expect(pixelAt(frame1, SIZE.width, POINT_B.x, POINT_B.y)).toEqual([...BOX_B.color, 255]);
        expect(pixelAt(frame1, SIZE.width, POINT_A.x, POINT_A.y)).toEqual(TRANSPARENT);

        // Frame 2: box A returns; box B's region (vacated this time) must
        // likewise read back transparent, proving the fix holds across
        // more than one frame transition, not just the first.
        expect(pixelAt(frame2, SIZE.width, POINT_A.x, POINT_A.y)).toEqual([...BOX_A.color, 255]);
        expect(pixelAt(frame2, SIZE.width, POINT_B.x, POINT_B.y)).toEqual(TRANSPARENT);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});

/** A square PNG, solid pure red across its own top half and solid pure blue across its own bottom half - deliberately asymmetric top-vs-bottom so a vertical mirror (a flipY-class bug) is empirically distinguishable from correct orientation, not just "some real image content appeared." */
function buildTwoToneTestPng(size: number): Buffer {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (size * y + x) << 2;
      const isTopHalf = y < size / 2;
      png.data[index] = isTopHalf ? 255 : 0;
      png.data[index + 1] = 0;
      png.data[index + 2] = isTopHalf ? 0 : 255;
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/**
 * A project with a single `ImageNode` (real `assetRef`, scaled large enough
 * to fill the entire frame at the camera's own distance/fov - see
 * `IMAGE_SIZE`'s own doc) plus a `CameraNode`, no lights (the image's own
 * `MeshBasicMaterial` is unlit, so a real render needs no light source to
 * show its real texture at full color).
 */
function buildImageFillsFrameProject(assetRef: string): Project {
  const image = Image({
    id: "image-1",
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
    fps: 10,
    durationInFrames: 1,
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
    tracks: [
      {
        id: "track-image",
        clips: [Sequence({ id: "clip-image", from: 0, durationInFrames: 1, content: image })],
      },
      {
        id: "track-camera",
        clips: [Sequence({ id: "clip-camera", from: 0, durationInFrames: 1, content: camera })],
      },
    ],
  });

  return createProject({
    id: "image-e2e",
    name: "Image e2e",
    compositions: [{ ...composition, activeCameraTrack: [{ startFrame: 0, durationInFrames: 1, cameraNodeId: "camera-1" }] }],
  });
}

/**
 * Square, matching `buildImageFillsFrameProject`'s own square composition
 * (so the default 50deg fov's vertical and horizontal frustum cross-sections
 * at the camera's own 5-unit distance are equal): `2 * 5 * tan(25deg) ≈
 * 4.66` units visible top-to-bottom at the image plane's own z=0, safely
 * smaller than the image node's own 8-unit `transform.scale`, so the
 * rendered plane overflows every edge of the frame with margin - no
 * background pixel anywhere in the output to accidentally sample instead of
 * the image's own real texture content.
 */
const IMAGE_SIZE = 32;

describe("runBrowserHeadlessRenderRange: real ImageNode texture rendering", () => {
  it(
    "renders a real, uploaded image's own real pixel content, right-side up (not vertically mirrored, not the gray placeholder)",
    async () => {
      if (!chromiumAvailable) {
        console.log(
          "ImageNode texture rendering e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
        );
        return;
      }

      const entrySource = await bundleBrowserEntry({
        entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
      });
      const browser = await launchPlaywrightHeadlessBrowser({});
      try {
        const page = await browser.newPage();
        await page.addScript(entrySource);

        const assetRef = "cadra-asset://two-tone-test";
        const pngBytes = buildTwoToneTestPng(IMAGE_SIZE);
        const project = buildImageFillsFrameProject(assetRef);

        const result = await page.evaluate(
          async (arg: { globalName: string; project: Project; assetRef: string; pngBytes: number[] }) => {
            const entry = (
              window as unknown as Record<
                string,
                | {
                    runBrowserHeadlessRenderRange: (config: {
                      project: Project;
                      compositionId: string;
                      seed: string | number;
                      bitrate: number;
                      startFrame: number;
                      endFrame: number;
                      imageRenderEntries: Array<{ assetRef: string; bytes: number[] }>;
                    }) => Promise<SerializedEncodedChunk[]>;
                  }
                | undefined
              >
            )[arg.globalName];
            if (entry === undefined) {
              throw new Error(`window["${arg.globalName}"] was not defined.`);
            }

            const chunks = await entry.runBrowserHeadlessRenderRange({
              project: arg.project,
              compositionId: "comp-1",
              seed: "image-e2e-seed",
              bitrate: 1_000_000,
              startFrame: 0,
              endFrame: 1,
              imageRenderEntries: [{ assetRef: arg.assetRef, bytes: arg.pngBytes }],
            });

            const chunk = chunks[0];
            if (chunk === undefined) {
              throw new Error("Expected at least one encoded chunk.");
            }

            // codedWidth/codedHeight are given explicitly (not left for the
            // decoder to infer from the bitstream alone): verified
            // empirically that omitting them makes this same real chunk's
            // own real decode fail outright ("EncodingError: Error during
            // flush.") on this environment's own AV1 decoder implementation,
            // even though VideoDecoderConfig's own spec marks both optional.
            const decoderConfig = {
              codec: chunk.codec!,
              codedWidth: arg.project.compositions[0]!.width,
              codedHeight: arg.project.compositions[0]!.height,
              ...(chunk.description !== undefined
                ? { description: Uint8Array.from(chunk.description) }
                : {}),
            };

            // Decode the real, just-encoded chunk back to real pixels via a
            // real in-page WebCodecs VideoDecoder - the same real browser,
            // the same real codec this render itself just chose, no
            // external decoder/tool needed.
            const decodedFrame = await new Promise<VideoFrame>((resolve, reject) => {
              const decoder = new VideoDecoder({
                output: (frame) => resolve(frame),
                error: (error) => reject(error),
              });
              decoder.configure(decoderConfig);
              decoder.decode(
                new EncodedVideoChunk({
                  type: chunk.type,
                  timestamp: chunk.timestamp,
                  duration: chunk.duration,
                  data: Uint8Array.from(chunk.data),
                }),
              );
              decoder.flush().catch(() => {
                // Any decode failure already surfaces through the `error`
                // callback above, which rejects this same promise; a
                // rejected flush() after that point would otherwise become
                // an unhandled rejection with nothing left to reject.
              });
            });

            const canvas = document.createElement("canvas");
            canvas.width = decodedFrame.displayWidth;
            canvas.height = decodedFrame.displayHeight;
            const context = canvas.getContext("2d");
            if (context === null) {
              throw new Error("Failed to acquire a 2D context for the decoded-frame canvas.");
            }
            context.drawImage(decodedFrame, 0, 0);
            decodedFrame.close();
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            return { width: canvas.width, height: canvas.height, data: Array.from(imageData.data) };
          },
          { globalName: BROWSER_ENTRY_GLOBAL_NAME, project, assetRef, pngBytes: Array.from(pngBytes) },
        );

        expect(result.width).toBe(IMAGE_SIZE);
        expect(result.height).toBe(IMAGE_SIZE);

        // Sampled a few pixels in from each edge/the vertical center, clear
        // of any lossy-compression bleed at the red/blue boundary row.
        const topPixel = pixelAt(result.data, result.width, 16, 4);
        const bottomPixel = pixelAt(result.data, result.width, 16, 28);

        // Top of frame: the source PNG's own top half was pure red. A
        // flipY-class bug would show blue here instead (the source's own
        // bottom half, mirrored to the top).
        expect(topPixel[0]).toBeGreaterThan(150);
        expect(topPixel[2]).toBeLessThan(100);

        // Bottom of frame: the source PNG's own bottom half was pure blue.
        expect(bottomPixel[2]).toBeGreaterThan(150);
        expect(bottomPixel[0]).toBeLessThan(100);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});

/** A real, valid, uncompressed WAV file: a single-channel sine tone at `frequencyHz`, `durationSeconds` long, 16-bit PCM - simple enough to hand-construct correctly with no encoding library, and a format every real browser's own `decodeAudioData` accepts. */
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

/** A project with one audio clip (referencing `assetRef`) spanning the whole composition, plus a lit box (video content is irrelevant to this suite, but a composition needs a valid target to resolve against). */
function buildProjectWithAudio(assetRef: string, durationInFrames: number, fps: number): Project {
  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps,
    durationInFrames,
    width: 16,
    height: 16,
    tracks: [],
  });
  const withAudioTrack: Composition = {
    ...composition,
    audioTracks: [
      {
        id: "audio-track-1",
        clips: [
          {
            id: "audio-clip-1",
            startFrame: 0,
            durationInFrames,
            assetRef,
          },
        ],
      },
    ],
  };
  return createProject({ id: "audio-e2e", name: "Audio e2e", compositions: [withAudioTrack] });
}

/**
 * Proves `runBrowserHeadlessAudioMixdown` delivers real, decodable,
 * non-silent audio - not just a correctly-shaped but empty/degenerate
 * chunk stream - mirroring this file's own `ImageNode` texture test: real
 * source bytes in, decoded back via a real in-page WebCodecs `AudioDecoder`
 * (the audio-side counterpart to that test's own `VideoDecoder` use), real
 * PCM samples checked directly rather than assumed from the pipeline
 * merely not throwing.
 */
describe("runBrowserHeadlessAudioMixdown: real audio mixdown/encode", () => {
  it(
    "renders a real uploaded audio asset's own real, non-silent samples",
    async () => {
      if (!chromiumAvailable) {
        console.log(
          "Audio mixdown e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
        );
        return;
      }

      const entrySource = await bundleBrowserEntry({
        entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
      });
      const browser = await launchPlaywrightHeadlessBrowser({});
      try {
        const page = await browser.newPage();
        await page.addScript(entrySource);

        const assetRef = "cadra-asset://sine-tone";
        const fps = 10;
        const durationInFrames = 10;
        const wavBytes = buildSineWaveWav(durationInFrames / fps, 440);
        const project = buildProjectWithAudio(assetRef, durationInFrames, fps);

        const result = await page.evaluate(
          async (arg: {
            globalName: string;
            project: Project;
            assetRef: string;
            wavBytes: number[];
          }) => {
            const entry = (
              window as unknown as Record<
                string,
                | {
                    runBrowserHeadlessAudioMixdown: (config: {
                      project: Project;
                      compositionId: string;
                      container: "mp4" | "webm";
                      bitrate: number;
                      audioAssetEntries: Array<{ assetRef: string; bytes: number[] }>;
                    }) => Promise<
                      | {
                          chunks: SerializedEncodedAudioChunk[];
                          codec: string;
                          numberOfChannels: number;
                          sampleRate: number;
                        }
                      | undefined
                    >;
                  }
                | undefined
              >
            )[arg.globalName];
            if (entry === undefined) {
              throw new Error(`window["${arg.globalName}"] was not defined.`);
            }

            const mixdownResult = await entry.runBrowserHeadlessAudioMixdown({
              project: arg.project,
              compositionId: "comp-1",
              container: "mp4",
              bitrate: 128_000,
              audioAssetEntries: [{ assetRef: arg.assetRef, bytes: arg.wavBytes }],
            });
            if (mixdownResult === undefined) {
              throw new Error("Expected a real audio mixdown result, got undefined.");
            }
            if (mixdownResult.chunks.length === 0) {
              throw new Error("Expected at least one encoded audio chunk.");
            }

            // Decode the real, just-encoded chunks back to real samples via
            // a real in-page WebCodecs AudioDecoder - same rationale as
            // this file's own VideoDecoder use for the image texture test.
            const decodedFrames: Array<{ numberOfFrames: number; samples: number[] }> = [];
            await new Promise<void>((resolve, reject) => {
              const decoder = new AudioDecoder({
                output: (audioData) => {
                  const samples = new Float32Array(audioData.numberOfFrames);
                  audioData.copyTo(samples, { planeIndex: 0 });
                  decodedFrames.push({
                    numberOfFrames: audioData.numberOfFrames,
                    samples: Array.from(samples),
                  });
                  audioData.close();
                  if (decodedFrames.length === mixdownResult.chunks.length) {
                    resolve();
                  }
                },
                error: (error) => reject(error),
              });
              decoder.configure({
                codec: mixdownResult.codec,
                sampleRate: mixdownResult.sampleRate,
                numberOfChannels: mixdownResult.numberOfChannels,
              });
              for (const chunk of mixdownResult.chunks) {
                decoder.decode(
                  new EncodedAudioChunk({
                    type: chunk.type,
                    timestamp: chunk.timestamp,
                    duration: chunk.duration,
                    data: Uint8Array.from(chunk.data),
                  }),
                );
              }
              decoder.flush().catch(() => {
                // Any decode failure already surfaces through the `error`
                // callback above, which rejects this same promise.
              });
            });

            return {
              chunkCount: mixdownResult.chunks.length,
              codec: mixdownResult.codec,
              numberOfChannels: mixdownResult.numberOfChannels,
              sampleRate: mixdownResult.sampleRate,
              decodedFrames,
            };
          },
          { globalName: BROWSER_ENTRY_GLOBAL_NAME, project, assetRef, wavBytes: Array.from(wavBytes) },
        );

        expect(result.chunkCount).toBeGreaterThan(0);
        expect(result.sampleRate).toBeGreaterThan(0);
        expect(result.numberOfChannels).toBeGreaterThan(0);
        expect(result.decodedFrames.length).toBeGreaterThan(0);

        // Real, non-silent content: at least one decoded sample across
        // every frame must have a meaningfully non-zero amplitude - a
        // broken pipeline (e.g. a mixdown that resolved no segments, or an
        // encoder fed an all-zero buffer) would decode back to all-zero
        // (or, for a lossy codec's own quantization noise floor, at most
        // vanishingly small) samples instead.
        const allSamples = result.decodedFrames.flatMap((frame) => frame.samples);
        const maxAbsSample = Math.max(...allSamples.map((sample) => Math.abs(sample)));
        expect(maxAbsSample).toBeGreaterThan(0.1);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});
