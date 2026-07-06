import {
  type AudioCodecPreference,
  DEFAULT_AUDIO_CODEC_PREFERENCES,
  probeSupportedAudioCodec,
} from "./audio-codec-probe.js";
import {
  type AudioEncoderConstructor,
  getGlobalAudioEncoderConstructor,
  getGlobalIsAudioConfigSupported,
  type IsAudioConfigSupportedFn,
} from "./audio-encoder-factory.js";
import { secondsToMicrosecondTimestamp } from "./capture-timestamp.js";
import type { AudioBufferLike } from "./offline-audio-context-like.js";

/**
 * How many sample-frames each `AudioData` chunk fed to `AudioEncoder.encode`
 * carries, at the render sample rate. 1024 matches AAC's standard frame
 * size (the number of samples one AAC frame's bitstream syntax always
 * encodes), so an AAC encoder never has to internally re-buffer a partial
 * frame across a chunk boundary; Opus (encode-side) is equally happy with
 * any chunk size the encoder is handed, since a real WebCodecs
 * implementation re-frames its input internally regardless of the input
 * `AudioData` size. Exposed as a named constant so a test asserting exact
 * chunk counts/timestamps has a single source of truth to compare against.
 */
export const DEFAULT_AUDIO_CHUNK_FRAMES = 1024;

/**
 * `encoder.encodeQueueSize` at or above this many pending encodes pauses
 * pulling further chunks until a `dequeue` event fires, mirroring
 * `encode-frames.ts`'s `DEFAULT_MAX_QUEUE_SIZE`. Audio chunks are far
 * smaller than a video frame's decoded pixel data, so a slightly larger
 * default than video's is safe without materially growing resident memory.
 */
export const DEFAULT_MAX_AUDIO_QUEUE_SIZE = 4;

/** Options accepted by `encodeAudio`. */
export interface EncodeAudioOptions {
  /** Target container: selects AAC (`"mp4"`) or Opus (`"webm"`) from `codecPreferences`. */
  container: "mp4" | "webm";
  /** Target bitrate in bits per second, passed through to `AudioEncoderConfig.bitrate`. */
  bitrate: number;
  /**
   * Audio codec preference list, filtered down to `options.container`'s
   * matching entry (order among same-container entries follows the
   * standard `probeSupportedCodec` first-supported-wins rule). Defaults to
   * `DEFAULT_AUDIO_CODEC_PREFERENCES`.
   */
  codecPreferences?: readonly AudioCodecPreference[];
  /**
   * Sample-frames per `AudioData` chunk. Defaults to
   * `DEFAULT_AUDIO_CHUNK_FRAMES`.
   */
  chunkFrames?: number;
  /**
   * Backpressure threshold: pause pulling further chunks while
   * `encoder.encodeQueueSize` is at or above this value. Defaults to
   * `DEFAULT_MAX_AUDIO_QUEUE_SIZE`.
   */
  maxQueueSize?: number;
  /**
   * `AudioEncoder` constructor to use, defaulting to the real global
   * `AudioEncoder` when available. Injectable so tests can supply a fake
   * that records `configure`/`encode`/`flush`/`close` calls and drives
   * `encodeQueueSize`/`dequeue`/`output`/`error` deterministically, without
   * a real WebCodecs-capable environment.
   */
  audioEncoderConstructor?: AudioEncoderConstructor;
  /**
   * `AudioEncoder.isConfigSupported` to use for codec probing, defaulting
   * to the real static method when available. Injectable for the same
   * reason as `audioEncoderConstructor`.
   */
  isConfigSupported?: IsAudioConfigSupportedFn;
  /**
   * `AudioData` constructor to use, defaulting to the real global
   * `AudioData` when available. Injectable so tests can supply a fake
   * constructor without a real WebCodecs-capable environment.
   */
  audioDataConstructor?: new (init: AudioDataInit) => AudioData;
}

/** One encoded chunk as `encodeAudio` yields it. */
export interface EncodedAudioChunkResult {
  /** Integer chunk index, counting from 0 in submission order. */
  chunkIndex: number;
  /** The encoded chunk `encoder`'s `output` callback delivered for this chunk. */
  chunk: EncodedAudioChunk;
  /** Decoder configuration metadata delivered alongside `chunk`, if any. */
  metadata: EncodedAudioChunkMetadata | undefined;
}

/** Thrown when `audioEncoderConstructor`/`isConfigSupported`/`audioDataConstructor` resolve to `undefined` (no injected value and no real global). */
export class WebCodecsUnavailableForAudioEncodingError extends Error {
  constructor() {
    super(
      "encodeAudio: WebCodecs AudioEncoder is unavailable in this environment and no audioEncoderConstructor/isConfigSupported/audioDataConstructor override was supplied. This package does not implement a non-WebCodecs (e.g. wasm) audio encoding fallback: see this phase's own doc for why a fabricated fallback with no real encoder behind it was rejected in favor of failing loudly here.",
    );
    this.name = "WebCodecsUnavailableForAudioEncodingError";
  }
}

/** Wraps `encoder`'s `error` callback delivering `err` into this promise's rejection. Mirrors `encode-frames.ts`'s `createEncoderErrorRejection`. */
function createEncoderErrorRejection(): {
  promise: Promise<never>;
  reject: (err: DOMException) => void;
} {
  let reject!: (err: DOMException) => void;
  const promise = new Promise<never>((_resolve, promiseReject) => {
    reject = promiseReject;
  });
  promise.catch(() => {});
  return { promise, reject };
}

/**
 * Resolves once `encoder`'s `encodeQueueSize` drops back below `threshold`.
 * Identical in shape to `encode-frames.ts`'s `waitForQueueBelowThreshold`,
 * duplicated rather than shared since the two operate on structurally
 * different encoder types (`AudioEncoder` vs `VideoEncoder`) with no common
 * supertype exposing `encodeQueueSize`/`dequeue` that TypeScript can express
 * without an unsound cast.
 */
function waitForQueueBelowThreshold(encoder: AudioEncoder, threshold: number): Promise<void> {
  if (encoder.encodeQueueSize < threshold) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const handleDequeue = (): void => {
      if (encoder.encodeQueueSize < threshold) {
        encoder.removeEventListener("dequeue", handleDequeue);
        resolve();
      }
    };
    encoder.addEventListener("dequeue", handleDequeue);
  });
}

/** Yields (and removes) every chunk currently in `readyChunks`, oldest first. Mirrors `encode-frames.ts`'s `drainReadyChunks`. */
function* drainReadyChunks(
  readyChunks: EncodedAudioChunkResult[],
): Generator<EncodedAudioChunkResult, void, void> {
  let next = readyChunks.shift();
  while (next !== undefined) {
    yield next;
    next = readyChunks.shift();
  }
}

/**
 * Splits `buffer` into fixed-size `AudioData` chunks of `chunkFrames`
 * sample-frames each (the final chunk may be shorter, covering whatever
 * remains), interleaving every channel into the planar `f32-planar` layout
 * `AudioDataInit.data` expects: channel 0's samples in full, then channel
 * 1's, and so on, matching `AudioBufferLike.getChannelData`'s own
 * per-channel layout directly (no interleaving needed, since `f32-planar`
 * is itself planar).
 *
 * Each `AudioData`'s `timestamp` is in whole microseconds from the start of
 * `buffer` (chunk index times `chunkFrames`, converted via the buffer's own
 * `sampleRate`, through `secondsToMicrosecondTimestamp`: the exact same
 * shared seconds-to-WebCodecs-microseconds conversion
 * `frameToMicrosecondTimestamp` (video's own frame-to-timestamp path;
 * see `capture-timestamp.ts`) reduces to internally), so a chunk's position
 * in the final encoded/muxed output always traces back to its exact
 * sample-accurate offset in the rendered mixdown. Since `buffer` itself
 * (via `renderAudioMixdown`) always starts at frame 0 of the composition
 * regardless of where its own audio content begins, and this function's
 * first chunk (`frameOffset` 0) always converts to timestamp 0 through
 * that same shared conversion `capture-frames.ts` uses for frame 0, both
 * tracks share the same zero point and the same underlying time base
 * conversion once muxed (this phase's own acceptance criterion).
 */
function* chunkAudioBuffer(
  buffer: AudioBufferLike,
  chunkFrames: number,
  audioDataConstructor: new (init: AudioDataInit) => AudioData,
): Generator<AudioData, void, void> {
  const { numberOfChannels, sampleRate, length } = buffer;
  const channelData: Float32Array[] = [];
  for (let channel = 0; channel < numberOfChannels; channel += 1) {
    channelData.push(buffer.getChannelData(channel));
  }

  for (let frameOffset = 0; frameOffset < length; frameOffset += chunkFrames) {
    const framesInChunk = Math.min(chunkFrames, length - frameOffset);
    const planarData = new Float32Array(framesInChunk * numberOfChannels);
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      // Cast is required: TypeScript's DOM lib types getChannelData's
      // return as Float32Array<ArrayBuffer> specifically, but planarData
      // (also a Float32Array<ArrayBuffer>) is only known to satisfy
      // .set()'s general Float32Array parameter, not that exact generic
      // instantiation; both are real Float32Arrays backed by a plain
      // ArrayBuffer at runtime.
      const source = channelData[channel] as Float32Array;
      planarData.set(
        source.subarray(frameOffset, frameOffset + framesInChunk),
        channel * framesInChunk,
      );
    }

    const timestamp = secondsToMicrosecondTimestamp(frameOffset / sampleRate);
    yield new audioDataConstructor({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: framesInChunk,
      numberOfChannels,
      timestamp,
      data: planarData,
    });
  }
}

/**
 * Encodes `buffer` (the offline mixdown render from `renderAudioMixdown`)
 * into a stream of `EncodedAudioChunkResult`s via a real (or injected fake)
 * WebCodecs `AudioEncoder`, mirroring `encode-frames.ts`'s `encodeFrames`
 * pipeline shape: probe a codec, configure the encoder, feed it chunk by
 * chunk, apply backpressure off `encodeQueueSize`, and stream out results as
 * they arrive.
 *
 * Unlike `encodeFrames` (which consumes an already-streaming
 * `AsyncGenerator<CapturedVideoFrame>` produced frame by frame from a live
 * render), this function's input is a single, already-fully-rendered
 * `AudioBufferLike`: an offline audio render produces its entire buffer in
 * one `startRendering()` call (see `renderAudioMixdown`'s own doc), so
 * there is no equivalent incremental audio source to pull from. This
 * function itself performs the chunking (`chunkAudioBuffer`) into
 * `AudioData` objects small enough for a real encoder to accept, and
 * applies the same queue-size-driven backpressure between successive
 * `encode()` calls that `encodeFrames` applies between frames.
 *
 * Every `AudioData` chunk this function constructs is closed immediately
 * after `encoder.encode()` returns (encode is fire-and-forget; it does not
 * take ownership of or close its argument), mirroring `encodeFrames`'s own
 * `videoFrame.close()` ownership discipline.
 *
 * @throws {WebCodecsUnavailableForAudioEncodingError} if no `AudioEncoder`
 *   constructor/`isConfigSupported`/`AudioData` constructor is available
 *   (no injected override and no real global). This package implements no
 *   non-WebCodecs fallback (e.g. a wasm encoder): see that error's own doc.
 * @throws {NoSupportedAudioCodecError} if the codec preference matching
 *   `options.container` is not supported at the requested channel
 *   count/sample rate/bitrate.
 */
export async function* encodeAudio(
  buffer: AudioBufferLike,
  options: EncodeAudioOptions,
): AsyncGenerator<EncodedAudioChunkResult, void, void> {
  const audioEncoderConstructor =
    options.audioEncoderConstructor ?? getGlobalAudioEncoderConstructor();
  const isConfigSupported = options.isConfigSupported ?? getGlobalIsAudioConfigSupported();
  // No dedicated getGlobalAudioDataConstructor factory module: unlike
  // VideoFrame (which video-frame-factory.ts wraps because captureFrames
  // also needs a standalone WebCodecsDetector feature-detection function),
  // nothing else in this package needs AudioData's global independently of
  // encodeAudio itself, so the same typeof-guarded lookup encode-frames.ts's
  // own modules use is inlined here directly rather than factored into a
  // separate file with only one caller.
  const audioDataConstructor =
    options.audioDataConstructor ?? (typeof AudioData === "undefined" ? undefined : AudioData);

  if (
    audioEncoderConstructor === undefined ||
    isConfigSupported === undefined ||
    audioDataConstructor === undefined
  ) {
    throw new WebCodecsUnavailableForAudioEncodingError();
  }

  const allPreferences = options.codecPreferences ?? DEFAULT_AUDIO_CODEC_PREFERENCES;
  const containerPreferences = allPreferences.filter(
    (preference) => preference.container === options.container,
  );
  const chunkFrames = options.chunkFrames ?? DEFAULT_AUDIO_CHUNK_FRAMES;
  const maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_AUDIO_QUEUE_SIZE;

  const config = await probeSupportedAudioCodec(
    containerPreferences,
    {
      numberOfChannels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
      bitrate: options.bitrate,
    },
    isConfigSupported,
  );

  // FIFO queue of pending chunk indices, mirroring encode-frames.ts's
  // pendingFrameNumbers: WebCodecs guarantees a single encoder's `output`
  // callback fires in the same order chunks were submitted, so shifting
  // this queue as each output arrives correctly re-pairs every result with
  // the chunk that produced it.
  const pendingChunkIndices: number[] = [];
  const readyChunks: EncodedAudioChunkResult[] = [];
  const errorRejection = createEncoderErrorRejection();

  const encoder = new audioEncoderConstructor({
    output: (chunk, metadata) => {
      const chunkIndex = pendingChunkIndices.shift();
      if (chunkIndex === undefined) {
        // Cannot happen in normal operation; see encode-frames.ts's own
        // identical guard for why this is a soft-fail rather than an
        // assertion.
        return;
      }
      readyChunks.push({ chunkIndex, chunk, metadata });
    },
    error: (err) => {
      errorRejection.reject(err);
    },
  });

  encoder.configure(config);

  try {
    let chunkIndex = 0;
    for (const audioData of chunkAudioBuffer(buffer, chunkFrames, audioDataConstructor)) {
      if (encoder.encodeQueueSize >= maxQueueSize) {
        await Promise.race([
          waitForQueueBelowThreshold(encoder, maxQueueSize),
          errorRejection.promise,
        ]);
      }

      pendingChunkIndices.push(chunkIndex);
      encoder.encode(audioData);
      audioData.close();
      chunkIndex += 1;

      yield* drainReadyChunks(readyChunks);
    }

    await Promise.race([encoder.flush(), errorRejection.promise]);
    yield* drainReadyChunks(readyChunks);
  } finally {
    encoder.close();
  }
}
