import type { RenderedFrame } from "@cadra/headless";
import type { PixelBuffer } from "@cadra/renderer";

import { frameToMicrosecondTimestamp } from "./capture-timestamp.js";
import {
  detectWebCodecsSupport,
  getGlobalVideoFrameConstructor,
  type VideoFrameConstructor,
  type WebCodecsDetector,
} from "./video-frame-factory.js";

/**
 * Default `VideoFrame.colorSpace`: full-range sRGB-ish, matching what a
 * canvas readback actually contains. Canvas 2D/WebGL/WebGPU pixel data is
 * conventionally full-range (0-255 spans black-to-white, not broadcast
 * video's limited 16-235 range) and sRGB-encoded (`iec61966-2-1` is the
 * sRGB transfer function's formal name; `bt709`'s primaries are a close
 * match to sRGB's), with no YUV matrix involved since the source is
 * already RGB (`matrix: "rgb"` means "no matrix conversion", the correct
 * value for RGB-native content). Overridable via `CaptureFramesOptions`
 * for callers that need different color handling (e.g. matching an
 * existing broadcast pipeline).
 */
export const DEFAULT_CAPTURE_COLOR_SPACE: VideoColorSpaceInit = {
  primaries: "bt709",
  transfer: "iec61966-2-1",
  matrix: "rgb",
  fullRange: true,
};

/** Options accepted by `captureFrames`. */
export interface CaptureFramesOptions {
  /**
   * Frame rate of the composition `renderedFrames` was produced from.
   * Required, not derived from `renderedFrames` itself: `RenderedFrame`
   * carries no fps (only Phase 18's composition does), and silently
   * defaulting would risk a mismatched timestamp with no way to notice.
   */
  fps: number;
  /**
   * `VideoColorSpaceInit` passed to every constructed `VideoFrame`.
   * Defaults to `DEFAULT_CAPTURE_COLOR_SPACE`; see its doc for the
   * rationale for that default.
   */
  colorSpace?: VideoColorSpaceInit;
  /**
   * `VideoFrame` constructor to use, defaulting to the real global
   * `VideoFrame` (via `getGlobalVideoFrameConstructor`) when available.
   * Injectable so tests can supply a fake that records constructions and
   * `.close()` calls without a real WebCodecs-capable environment.
   */
  videoFrameConstructor?: VideoFrameConstructor;
  /**
   * Detects whether WebCodecs is available in this environment, defaulting
   * to `detectWebCodecsSupport` (a real `typeof VideoFrame !== "undefined"`
   * check). Injectable so tests can force the fallback path deterministically.
   */
  detectWebCodecs?: WebCodecsDetector;
}

/** `captureFrames` yielded a live `VideoFrame`: WebCodecs is available in this environment. */
export interface CapturedVideoFrame {
  kind: "video-frame";
  /** Integer frame index, counting from 0, same as the source `RenderedFrame.frame`. */
  frame: number;
  /** Whole microseconds, `frameToMicrosecondTimestamp(frame, fps)`; matches `videoFrame.timestamp`. */
  timestamp: number;
  /**
   * The constructed `VideoFrame`. Ownership transfers to the consumer on
   * yield: `captureFrames` never touches or closes this after yielding it,
   * matching real WebCodecs usage (`VideoEncoder.encode(frame)` does not
   * take ownership or auto-close its argument). The consumer must call
   * `.close()` on it once done (e.g. after `VideoEncoder.encode`), or the
   * underlying media resource leaks.
   */
  videoFrame: VideoFrame;
}

/** `captureFrames` yielded a raw `PixelBuffer`: WebCodecs is unavailable in this environment. */
export interface CapturedPixelBuffer {
  kind: "pixel-buffer";
  /** Integer frame index, counting from 0, same as the source `RenderedFrame.frame`. */
  frame: number;
  /** Whole microseconds, `frameToMicrosecondTimestamp(frame, fps)`; same value a `VideoFrame` would have carried. */
  timestamp: number;
  /** The source frame's own `PixelBuffer`, passed through unchanged. */
  pixels: PixelBuffer;
}

/**
 * One frame as `captureFrames` yields it: a discriminated union on `kind`,
 * so a consumer narrows with a single `switch`/`if` on `capturedFrame.kind`
 * rather than checking for the presence of optional fields.
 */
export type CapturedFrame = CapturedVideoFrame | CapturedPixelBuffer;

/**
 * Converts each of Phase 18's rendered pixel buffers into a WebCodecs
 * `VideoFrame` with a precise, monotonic timestamp derived purely from
 * frame index and fps (see `frameToMicrosecondTimestamp`), falling back to
 * yielding the raw `PixelBuffer` (with the same computed `frame`/
 * `timestamp`) when WebCodecs is unavailable in this environment.
 *
 * Every constructed `VideoFrame` also carries an explicit `duration`
 * (`frameToMicrosecondTimestamp(frame + 1, fps) -
 * frameToMicrosecondTimestamp(frame, fps)`, i.e. exactly one frame's worth
 * of microseconds at this composition's fps), not left `undefined`: a real
 * `VideoEncoder`, lacking an explicit source `VideoFrame.duration`,
 * evidently derives each output `EncodedVideoChunk.duration` from the gap
 * to the *next* frame's timestamp instead, which has no defined value for
 * the very last frame in a stream (there is no next frame to measure a gap
 * to). Verified directly against a real Chromium `VideoEncoder` while
 * building Phase 23's headless server render path: without this explicit
 * `duration`, the last frame's encoded chunk (and therefore the muxed
 * file's own last sample, and the fragment/track duration
 * `readMp4FragmentedDurationTicks`/`readMp4TrackTimescale`'s callers derive
 * from summing every sample) silently came out exactly one frame short of
 * `durationInFrames / fps`, a real bug that the pre-existing muxer test
 * suite's own fake, pre-canned `EncodedVideoChunk`s (which always hardcoded
 * an explicit non-zero duration on every chunk, including the last) never
 * had the chance to surface. Setting `duration` explicitly here removes the
 * ambiguity for the encoder entirely, for every frame, not just the last.
 *

 * A streaming transform over `renderedFrames`, matching `renderComposition`'s
 * own one-item-at-a-time shape: nothing is collected into an array, so a
 * consumer (e.g. Phase 20's `VideoEncoder` pipeline) can encode and discard
 * each frame as it arrives.
 *
 * Ownership contract: every yielded `CapturedVideoFrame.videoFrame` is
 * handed to the consumer still open, i.e. the consumer owns it and must
 * call `.close()` once done, exactly as `VideoEncoder.encode` expects
 * (it does not take ownership of or close its argument). `captureFrames`
 * itself never constructs a `VideoFrame` it does not yield onward, so it has
 * nothing left to close internally in the normal path; the `try`/`finally`
 * below exists so that invariant holds even if a future change to this
 * function introduces an intermediate/temporary `VideoFrame`-like value that
 * is not itself yielded, and so that early termination (the consumer
 * breaking its `for await` loop) is handled the same way a full run is.
 *
 * Early termination: if the consumer stops iterating partway through (e.g.
 * `break`s its `for await` loop), the language runtime calls this
 * generator's `return()`, which unwinds the `try`/`finally` below and
 * propagates the same `return()` call to `renderedFrames`, so Phase 18's
 * own `finally`-based renderer disposal still runs. The consumer remains
 * responsible for closing whatever `VideoFrame`s it already received before
 * stopping; frames not yet yielded are never constructed at all (the loop
 * body constructs one `VideoFrame` per iteration, immediately before
 * yielding it), so there is nothing left un-closed on this side either way.
 */
export async function* captureFrames(
  renderedFrames: AsyncGenerator<RenderedFrame>,
  options: CaptureFramesOptions,
): AsyncGenerator<CapturedFrame, void, void> {
  const colorSpace = options.colorSpace ?? DEFAULT_CAPTURE_COLOR_SPACE;
  const detectWebCodecs = options.detectWebCodecs ?? detectWebCodecsSupport;
  const webCodecsAvailable = detectWebCodecs();
  const videoFrameConstructor = options.videoFrameConstructor ?? getGlobalVideoFrameConstructor();

  try {
    for await (const rendered of renderedFrames) {
      const timestamp = frameToMicrosecondTimestamp(rendered.frame, options.fps);
      // See this function's own doc for why this is computed as a
      // difference of two timestamps (matching whatever gap-derivation a
      // real encoder itself uses for every frame but the last) rather than
      // a simpler `MICROSECONDS_PER_SECOND / options.fps`: both are
      // mathematically the same value, but computing it this way keeps a
      // single shared rounding rule (`frameToMicrosecondTimestamp`'s own)
      // as the sole source of truth for every timestamp/duration this
      // module produces.
      const duration =
        frameToMicrosecondTimestamp(rendered.frame + 1, options.fps) - timestamp;

      if (webCodecsAvailable && videoFrameConstructor !== undefined) {
        const videoFrame = new videoFrameConstructor(rendered.pixels.data, {
          format: "RGBA",
          codedWidth: rendered.pixels.width,
          codedHeight: rendered.pixels.height,
          timestamp,
          duration,
          colorSpace,
        });
        yield { kind: "video-frame", frame: rendered.frame, timestamp, videoFrame };
      } else {
        yield {
          kind: "pixel-buffer",
          frame: rendered.frame,
          timestamp,
          pixels: rendered.pixels,
        };
      }
    }
  } finally {
    // No intermediate/un-yielded VideoFrame is ever constructed above: each
    // iteration either yields the VideoFrame it just built, or yields the
    // raw PixelBuffer. This finally is a deliberate no-op placeholder
    // matching renderComposition's disposal shape, guarding against a
    // future change introducing a temporary VideoFrame that must be closed
    // here instead of yielded.
  }
}
