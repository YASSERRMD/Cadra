/**
 * Decodes real video frames in plain Node, via a system-installed `ffmpeg`
 * binary spawned as a child process - the Node-only counterpart to
 * `browser-headless-render-entry.ts`'s own `buildVideoFrameRegistry`, which
 * relies on a real `<video>` element's own decode (`document.createElement("video")`),
 * unavailable outside a browser page. Node has no built-in video demux/decode
 * capability at all (no WebCodecs globals), so this is the one piece of the
 * pipeline with no equivalent already covered by `pngjs` the way image
 * decoding is (see `buildTextureRegistryForProject`, `render-job.ts`).
 *
 * Deliberately spawns whatever `ffmpeg` the host environment already has on
 * `PATH`, rather than bundling a specific build via a package like
 * `@ffmpeg-installer/ffmpeg`: this repo does not redistribute an ffmpeg
 * binary of its own, sidestepping the real licensing question a bundled
 * build raises (LGPL vs. GPL build selection affects redistribution) -
 * `ffmpeg` is a real, environment-level prerequisite for this one feature,
 * the same way a real native WebGPU adapter is a real, environment-level
 * prerequisite for `createNativeGpuHeadlessRenderer` itself (see
 * `NativeGpuAdapterUnavailableError`'s own doc in `@cadra/headless`) -
 * `FfmpegNotFoundError` below mirrors that exact "missing environment
 * capability, not a bug" pattern.
 *
 * Extracts each sampled frame as a PNG (`-f image2pipe -vcodec png`), not
 * raw RGBA: a PNG's own header carries its width/height, so this reuses
 * `pngjs`'s existing decode path (`PNG.sync.read`) exactly like image assets
 * already do, instead of separately probing the source video's own
 * resolution and reshaping a raw byte stream by hand.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PNG } from "pngjs";

/** One successfully decoded video frame, ready for `createDataTexture` (`@cadra/renderer`) to wrap - the Node-only counterpart to an `ImageBitmap`. */
export interface DecodedVideoFrame {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Thrown when no `ffmpeg` binary can be found on `PATH` - a missing environment prerequisite, not a bug; see this module's own doc. */
export class FfmpegNotFoundError extends Error {
  constructor() {
    super(
      "No \"ffmpeg\" binary found on PATH. Real Node-side video frame decoding requires a system-installed " +
        "ffmpeg (e.g. `brew install ffmpeg`, `apt-get install ffmpeg`); this repo does not bundle one.",
    );
    this.name = "FfmpegNotFoundError";
  }
}

/** One `(sourceFrame, timestamp)` pair `decodeVideoFramesWithFfmpeg` should sample - `sourceFrame` is purely a caller-supplied key (matched back onto the returned `Map`), never interpreted by ffmpeg itself; only `timestampSeconds` drives the actual seek. */
export interface VideoFrameSampleRequest {
  sourceFrame: number;
  timestampSeconds: number;
}

/** Runs `ffmpeg` with `args`, feeding nothing to stdin and collecting stdout as one `Buffer`; rejects with `FfmpegNotFoundError` if `ffmpeg` itself cannot be spawned, or a real `Error` (ffmpeg's own stderr tail) on a non-zero exit. */
function runFfmpeg(args: readonly string[]): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new FfmpegNotFoundError());
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      resolvePromise(Buffer.concat(stdoutChunks));
    });
  });
}

/**
 * Decodes every requested sample from one video asset's own `videoBytes`,
 * via a real `ffmpeg` child process per sample - each seeking (`-ss`, fast
 * input-side seeking against the container's own keyframe index) into the
 * *same* temp file, written once regardless of how many samples are
 * requested. A sample whose decode fails (an out-of-range timestamp, a
 * corrupt frame) is simply absent from the returned `Map`, the same
 * "unresolved is an expected runtime state, not a thrown error" contract
 * `buildTextureRegistryForProject`'s own per-asset PNG decode already
 * establishes - the caller (`buildVideoFrameRegistryForProject`,
 * `render-job.ts`) falls that one sample through to the renderer's own
 * documented gray placeholder. `ffmpeg` itself not being on `PATH` at all
 * is different: every sample would fail identically, so the first
 * `FfmpegNotFoundError` this hits is rethrown immediately rather than
 * silently producing an all-placeholder result one sample at a time.
 */
export async function decodeVideoFramesWithFfmpeg(
  videoBytes: Uint8Array,
  samples: readonly VideoFrameSampleRequest[],
): Promise<Map<number, DecodedVideoFrame>> {
  const results = new Map<number, DecodedVideoFrame>();
  if (samples.length === 0) {
    return results;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "cadra-video-decode-"));
  const inputPath = join(tempDir, "input");
  try {
    await writeFile(inputPath, videoBytes);

    for (const sample of samples) {
      try {
        const pngBytes = await runFfmpeg([
          "-y",
          "-ss",
          sample.timestampSeconds.toString(),
          "-i",
          inputPath,
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "png",
          "pipe:1",
        ]);
        const png = PNG.sync.read(pngBytes);
        results.set(sample.sourceFrame, { width: png.width, height: png.height, pixels: new Uint8Array(png.data) });
      } catch (error) {
        if (error instanceof FfmpegNotFoundError) {
          // ffmpeg missing entirely means every remaining sample would fail
          // identically - stop immediately rather than spawn N more
          // processes just to hit the same ENOENT N more times.
          throw error;
        }
        console.error(
          `decodeVideoFramesWithFfmpeg: failed to decode the frame at ${sample.timestampSeconds}s ` +
            `(source frame ${sample.sourceFrame}): ${error instanceof Error ? error.message : String(error)}. ` +
            "This sample is omitted; the node(s) requesting it render as the documented gray placeholder instead.",
        );
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  return results;
}
