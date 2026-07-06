import type { CapturedVideoFrame } from "./capture-frames.js";
import {
  type CodecPreference,
  DEFAULT_CODEC_PREFERENCES,
  probeSupportedCodec,
} from "./codec-probe.js";
import {
  getGlobalIsConfigSupported,
  getGlobalVideoEncoderConstructor,
  type IsConfigSupportedFn,
  type VideoEncoderConstructor,
} from "./video-encoder-factory.js";

/**
 * Every `keyframeIntervalFrames`-th frame (and frame 0) is forced as a
 * keyframe when `options.keyframeIntervalFrames` is not supplied. 30 frames
 * is one keyframe per second at the common 30fps composition rate, a
 * standard streaming/seek-granularity tradeoff: frequent enough that
 * seeking or recovering from a dropped chunk never costs more than a
 * second of frames, infrequent enough that keyframes (always far larger
 * than inter-frames) do not dominate the encoded bitrate.
 */
export const DEFAULT_KEYFRAME_INTERVAL_FRAMES = 30;

/**
 * `encoder.encodeQueueSize` at or above this many pending encodes pauses
 * pulling further frames until a `dequeue` event fires (see
 * `waitForQueueBelowThreshold`'s doc). 2 is deliberately small: it bounds
 * how many `VideoFrame`s (each a full decoded frame's worth of pixel data,
 * with no compression yet applied) can be in flight at once to a small,
 * fixed number, rather than letting rendering race arbitrarily far ahead of
 * encoding. Callers rendering very high resolutions on a slow encoder can
 * raise this for more encode-side pipelining at the cost of more resident
 * memory; callers with tight memory budgets can lower it further (down to
 * the WebCodecs-imposed minimum of 1 in-flight encode).
 */
export const DEFAULT_MAX_QUEUE_SIZE = 2;

/** Options accepted by `encodeFrames`. */
export interface EncodeFramesOptions {
  /** Output video width in pixels, passed through to `VideoEncoderConfig.width`. */
  width: number;
  /** Output video height in pixels, passed through to `VideoEncoderConfig.height`. */
  height: number;
  /** Target bitrate in bits per second, passed through to `VideoEncoderConfig.bitrate`. */
  bitrate: number;
  /** Frame rate, passed through to `VideoEncoderConfig.framerate`. */
  framerate: number;
  /**
   * Ordered codec preference list, probed in order via `isConfigSupported`
   * (first supported entry wins). Defaults to `DEFAULT_CODEC_PREFERENCES`
   * (AV1, then VP9, then H.264).
   */
  codecPreferences?: readonly CodecPreference[];
  /**
   * Force a keyframe every this many frames (and always at frame 0).
   * Defaults to `DEFAULT_KEYFRAME_INTERVAL_FRAMES`.
   */
  keyframeIntervalFrames?: number;
  /**
   * Backpressure threshold: pause pulling further frames while
   * `encoder.encodeQueueSize` is at or above this value. Defaults to
   * `DEFAULT_MAX_QUEUE_SIZE`.
   */
  maxQueueSize?: number;
  /**
   * `VideoEncoder` constructor to use, defaulting to the real global
   * `VideoEncoder` when available. Injectable so tests can supply a fake
   * that records `configure`/`encode`/`flush`/`close` calls and drives
   * `encodeQueueSize`/`dequeue`/`output`/`error` deterministically, without
   * a real WebCodecs-capable environment.
   */
  videoEncoderConstructor?: VideoEncoderConstructor;
  /**
   * `VideoEncoder.isConfigSupported` to use for codec probing, defaulting
   * to the real static method when available. Injectable for the same
   * reason as `videoEncoderConstructor`.
   */
  isConfigSupported?: IsConfigSupportedFn;
}

/** One encoded chunk as `encodeFrames` yields it, paired back to the frame that produced it. */
export interface EncodedChunkResult {
  /** Integer frame index (same numbering as `CapturedVideoFrame.frame`) that produced `chunk`. */
  frame: number;
  /** The encoded chunk `encoder`'s `output` callback delivered for `frame`. */
  chunk: EncodedVideoChunk;
  /** Decoder configuration metadata delivered alongside `chunk`, if any. */
  metadata: EncodedVideoChunkMetadata | undefined;
}

/** Thrown when `videoEncoderConstructor`/`isConfigSupported` resolve to `undefined` (no injected value and no real global). */
export class WebCodecsUnavailableForEncodingError extends Error {
  constructor() {
    super(
      "encodeFrames: WebCodecs VideoEncoder is unavailable in this environment and no videoEncoderConstructor/isConfigSupported override was supplied.",
    );
    this.name = "WebCodecsUnavailableForEncodingError";
  }
}

/** Wraps `encoder`'s `error` callback delivering `err` into this promise's rejection. */
function createEncoderErrorRejection(): {
  promise: Promise<never>;
  reject: (err: DOMException) => void;
} {
  let reject!: (err: DOMException) => void;
  const promise = new Promise<never>((_resolve, promiseReject) => {
    reject = promiseReject;
  });
  // Only ever observed via `Promise.race` against real progress below; if
  // the encoder never errors, this promise never settles and must not raise
  // an unhandled-rejection warning on its own.
  promise.catch(() => {});
  return { promise, reject };
}

/**
 * Resolves once `encoder`'s `encodeQueueSize` drops back below `threshold`.
 * If already below, resolves immediately without waiting for an event at
 * all. Otherwise listens for `dequeue` events (WebCodecs fires one whenever
 * its internal queue shrinks) and re-checks the queue size on each firing,
 * since a single `dequeue` event is not guaranteed to be enough to drop
 * below `threshold` when the queue's current overshoot is larger than one.
 */
function waitForQueueBelowThreshold(encoder: VideoEncoder, threshold: number): Promise<void> {
  if (encoder.encodeQueueSize < threshold) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const handleDequeue = (): void => {
      if (encoder.encodeQueueSize < threshold) {
        encoder.removeEventListener("dequeue", handleDequeue);
        resolve();
      }
      // Still at/above threshold: keep this listener registered and wait
      // for the next dequeue event.
    };
    encoder.addEventListener("dequeue", handleDequeue);
  });
}

/**
 * Whether `frame` must be encoded as a keyframe: always frame 0 (an encoded
 * stream must start with a keyframe to be decodable at all), and then every
 * `keyframeIntervalFrames`-th frame after that.
 */
function isKeyframeDue(frame: number, keyframeIntervalFrames: number): boolean {
  return frame % keyframeIntervalFrames === 0;
}

/**
 * Encodes `capturedFrames` (Phase 19's `captureFrames` narrowed to its
 * `CapturedVideoFrame` case; see this module's own doc for why the
 * `CapturedPixelBuffer` fallback case is out of scope here) into a stream of
 * `EncodedChunkResult`s via a real (or injected fake) WebCodecs
 * `VideoEncoder`.
 *
 * Pipeline shape: this function pulls one frame at a time from
 * `capturedFrames`, which itself pulls one frame at a time from
 * `renderComposition` (via `captureFrames`). Nothing upstream is pushed
 * faster than this function is willing to pull, and this function is only
 * willing to pull the next frame once `encoder.encodeQueueSize` is back
 * below `options.maxQueueSize` (see `waitForQueueBelowThreshold`), so the
 * entire render -> capture -> encode chain paces itself off this one
 * signal, keeping memory bounded end to end.
 *
 * Ownership: `capturedFrames` hands off each `videoFrame` still open (see
 * `CapturedVideoFrame.videoFrame`'s own doc); this function is that
 * ownership contract's consumer, and closes every `videoFrame` itself,
 * immediately after `encoder.encode(...)` returns (encode is fire-and-forget;
 * it does not take ownership of or close its argument).
 *
 * Chunk delivery: `encoder`'s `output` callback fires asynchronously
 * (relative to the `encode()` call that produced it), in the same order
 * chunks were submitted for encoding, so a FIFO queue of pending frame
 * numbers correctly re-pairs each arriving chunk with the frame that
 * produced it. Any chunks that have arrived are drained (yielded) after
 * every `encode()` call and after every backpressure wait, so this
 * generator never buffers more encoded output than necessary; the final
 * `flush()` (see below) guarantees every remaining chunk has arrived by the
 * time this generator finishes.
 *
 * Cleanup: once `capturedFrames` is exhausted, `encoder.flush()` forces out
 * any chunks still buffered inside the codec (resolving only once every
 * pending `output` has already fired) before this generator finishes, then
 * `encoder.close()` releases the encoder. The same flush-then-close
 * sequence runs if the consumer terminates early (breaks its `for await`
 * loop), via the `finally` below, mirroring `captureFrames`'/
 * `renderComposition`'s own `finally`-based disposal.
 *
 * @throws {WebCodecsUnavailableForEncodingError} if no `VideoEncoder`
 *   constructor/`isConfigSupported` is available (no injected override and
 *   no real global).
 * @throws {NoSupportedCodecError} if none of `options.codecPreferences` are
 *   supported at the requested resolution/bitrate/framerate.
 */
export async function* encodeFrames(
  capturedFrames: AsyncGenerator<CapturedVideoFrame>,
  options: EncodeFramesOptions,
): AsyncGenerator<EncodedChunkResult, void, void> {
  const videoEncoderConstructor =
    options.videoEncoderConstructor ?? getGlobalVideoEncoderConstructor();
  const isConfigSupported = options.isConfigSupported ?? getGlobalIsConfigSupported();
  if (videoEncoderConstructor === undefined || isConfigSupported === undefined) {
    throw new WebCodecsUnavailableForEncodingError();
  }

  const codecPreferences = options.codecPreferences ?? DEFAULT_CODEC_PREFERENCES;
  const keyframeIntervalFrames = options.keyframeIntervalFrames ?? DEFAULT_KEYFRAME_INTERVAL_FRAMES;
  const maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;

  const config = await probeSupportedCodec(
    codecPreferences,
    {
      width: options.width,
      height: options.height,
      bitrate: options.bitrate,
      framerate: options.framerate,
    },
    isConfigSupported,
  );

  // Frame indices paired with each `encode()` call, in call order. WebCodecs
  // guarantees a single encoder's `output` callback fires in the same order
  // chunks were submitted for encoding, so shifting this queue as each
  // output arrives correctly re-pairs every chunk with the frame that
  // produced it, with no explicit id threaded through the codec itself.
  const pendingFrameNumbers: number[] = [];
  // Chunks the `output` callback has delivered but this generator has not
  // yet yielded onward.
  const readyChunks: EncodedChunkResult[] = [];
  const errorRejection = createEncoderErrorRejection();

  const encoder = new videoEncoderConstructor({
    output: (chunk, metadata) => {
      const frame = pendingFrameNumbers.shift();
      if (frame === undefined) {
        // Cannot happen in normal operation: every encode() call pushes
        // exactly one frame number before returning, and output fires at
        // most once per encode() call, so this queue can never be emptier
        // than the number of outputs already delivered. Guarded rather than
        // asserted so a future encoder-behavior change fails soft (dropping
        // the chunk) instead of throwing from inside a WebCodecs callback.
        return;
      }
      readyChunks.push({ frame, chunk, metadata });
    },
    error: (err) => {
      errorRejection.reject(err);
    },
  });

  encoder.configure(config);

  try {
    for await (const captured of capturedFrames) {
      if (encoder.encodeQueueSize >= maxQueueSize) {
        await Promise.race([
          waitForQueueBelowThreshold(encoder, maxQueueSize),
          errorRejection.promise,
        ]);
      }

      const keyFrame = isKeyframeDue(captured.frame, keyframeIntervalFrames);
      pendingFrameNumbers.push(captured.frame);
      encoder.encode(captured.videoFrame, { keyFrame });
      captured.videoFrame.close();

      yield* drainReadyChunks(readyChunks);
    }

    await Promise.race([encoder.flush(), errorRejection.promise]);
    yield* drainReadyChunks(readyChunks);
  } finally {
    encoder.close();
  }
}

/** Yields (and removes) every chunk currently in `readyChunks`, oldest first. */
function* drainReadyChunks(
  readyChunks: EncodedChunkResult[],
): Generator<EncodedChunkResult, void, void> {
  let next = readyChunks.shift();
  while (next !== undefined) {
    yield next;
    next = readyChunks.shift();
  }
}
