import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { decodeVideoFramesWithFfmpeg, FfmpegNotFoundError } from "./ffmpeg-video-frame-decoder.js";

/**
 * Real, non-mocked end-to-end coverage: no fake `spawn`, no fake ffmpeg
 * output - a real `ffmpeg` binary must be on `PATH` for this file's own
 * tests to actually exercise anything. Mirrors `@cadra/headless`'s own
 * `render-frame-native-gpu.e2e.test.ts` naming and skip-guard convention (a
 * `*.e2e.test.ts` suffix, still matched by this package's default
 * `src/**\/*.test.ts` Vitest `include`) for the same underlying reason: a
 * real `ffmpeg` binary is not guaranteed to be installed on every machine
 * `pnpm -w test` might run on, so every test below skips cleanly (an early
 * `return` inside a passing `it`, not `it.skip`) rather than failing the
 * whole suite when ffmpeg genuinely is not available here.
 */

/** Encodes a tiny, real, four-frame test video via ffmpeg's own `testsrc` synthetic source (a well-known, deterministic pattern that visibly changes frame to frame) - real encoded bytes, not a hand-crafted fixture file. */
function encodeTestVideo(): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=2:size=64x64:rate=4",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code} while encoding the test fixture`));
        return;
      }
      resolvePromise(new Uint8Array(Buffer.concat(chunks)));
    });
  });
}

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await encodeTestVideo();
    return true;
  } catch (error) {
    console.log(
      `ffmpeg-video-frame-decoder e2e tests: skipping, a real ffmpeg binary could not encode a test fixture on this machine (${String(error)}).`,
    );
    return false;
  }
}

describe("decodeVideoFramesWithFfmpeg: real end-to-end video decoding (no mocks)", () => {
  it("decodes a real sampled frame to the video's own real dimensions and non-trivial pixel data", async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }
    const videoBytes = await encodeTestVideo();

    const decoded = await decodeVideoFramesWithFfmpeg(videoBytes, [{ sourceFrame: 0, timestampSeconds: 0.1 }]);

    const frame = decoded.get(0);
    expect(frame).toBeDefined();
    expect(frame?.width).toBe(64);
    expect(frame?.height).toBe(64);
    expect(frame?.pixels.length).toBe(64 * 64 * 4);
    // testsrc is a real, visibly-colored pattern, not a blank/black frame.
    let nonBlankPixelCount = 0;
    for (let i = 0; i < (frame?.pixels.length ?? 0); i += 4) {
      const r = frame?.pixels[i] ?? 0;
      const g = frame?.pixels[i + 1] ?? 0;
      const b = frame?.pixels[i + 2] ?? 0;
      if (r > 0 || g > 0 || b > 0) {
        nonBlankPixelCount += 1;
      }
    }
    expect(nonBlankPixelCount).toBeGreaterThan(0);
  });

  it("decodes genuinely different pixel content for two different timestamps of the same moving test pattern", async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }
    const videoBytes = await encodeTestVideo();

    const decoded = await decodeVideoFramesWithFfmpeg(videoBytes, [
      { sourceFrame: 0, timestampSeconds: 0.1 },
      { sourceFrame: 1, timestampSeconds: 1.5 },
    ]);

    const first = decoded.get(0);
    const second = decoded.get(1);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(Array.from(first?.pixels ?? [])).not.toEqual(Array.from(second?.pixels ?? []));
  });

  it("decodes only one temp file write regardless of how many samples are requested (real multi-sample seek against one asset)", async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }
    const videoBytes = await encodeTestVideo();

    const decoded = await decodeVideoFramesWithFfmpeg(videoBytes, [
      { sourceFrame: 0, timestampSeconds: 0.1 },
      { sourceFrame: 1, timestampSeconds: 0.6 },
      { sourceFrame: 2, timestampSeconds: 1.1 },
      { sourceFrame: 3, timestampSeconds: 1.6 },
    ]);

    expect(decoded.size).toBe(4);
    for (const key of [0, 1, 2, 3]) {
      expect(decoded.get(key)?.width).toBe(64);
    }
  });

  it("omits (not throws for) a single out-of-range sample while still decoding every in-range one", async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }
    const videoBytes = await encodeTestVideo();

    const decoded = await decodeVideoFramesWithFfmpeg(videoBytes, [
      { sourceFrame: 0, timestampSeconds: 0.1 },
      { sourceFrame: 1, timestampSeconds: 999 },
    ]);

    expect(decoded.get(0)).toBeDefined();
    expect(decoded.get(1)).toBeUndefined();
  });

  it("returns an empty Map for an empty samples list without spawning ffmpeg at all", async () => {
    const decoded = await decodeVideoFramesWithFfmpeg(new Uint8Array(), []);
    expect(decoded.size).toBe(0);
  });
});

describe("decodeVideoFramesWithFfmpeg: ffmpeg genuinely missing from PATH", () => {
  it("rejects with FfmpegNotFoundError, not a generic error", async () => {
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      await expect(
        decodeVideoFramesWithFfmpeg(new Uint8Array([1, 2, 3]), [{ sourceFrame: 0, timestampSeconds: 0 }]),
      ).rejects.toBeInstanceOf(FfmpegNotFoundError);
    } finally {
      if (originalPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = originalPath;
      }
    }
  });
});
