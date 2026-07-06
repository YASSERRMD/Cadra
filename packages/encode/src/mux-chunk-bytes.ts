/**
 * Both mp4-muxer's and webm-muxer's `addVideoChunk`/`addAudioChunk` require
 * their first argument to be a real `instanceof EncodedVideoChunk`/
 * `instanceof EncodedAudioChunk` (each muxer checks this explicitly and
 * throws a `TypeError` otherwise), which only exists as a global in an
 * environment with real WebCodecs support. This package's Vitest/Node test
 * environment (matching every other module in this package: see
 * `video-encoder-factory.ts`'s doc for the same underlying gap) has no such
 * global, so constructing even a fully realistic fake `EncodedVideoChunk`/
 * `EncodedAudioChunk` for a test can never satisfy that `instanceof` check.
 *
 * `addVideoChunkRaw`/`addAudioChunkRaw` (both muxers' own documented escape
 * hatch for exactly this case: "the encoded video/audio is not obtained
 * through a `VideoEncoder`/`AudioEncoder` but through some other means")
 * sidesteps the check entirely by taking the chunk's raw fields directly,
 * so this module extracts those fields via the one part of
 * `EncodedVideoChunk`'s/`EncodedAudioChunk`'s surface that does not require
 * an `instanceof` check to use: `copyTo`. This makes `mux-mp4.ts`/
 * `mux-webm.ts` work identically whether `chunk` is a real WebCodecs
 * `EncodedVideoChunk`/`EncodedAudioChunk` (a real browser) or any object
 * merely shaped like one (this package's own tests), with no
 * environment-detection branch needed in either module.
 *
 * `EncodedVideoChunk` and `EncodedAudioChunk` are structurally identical
 * (`byteLength`, `duration`, `timestamp`, `type`, `copyTo`; see each
 * interface's own definition), so `extractRawChunkBytes`/
 * `extractRawAudioChunkBytes` below share one private extraction helper,
 * exposed as two separate, explicitly-named public functions (rather
 * than one generically-typed function) so a caller's own code reads as
 * "extract this video chunk" / "extract this audio chunk" without needing
 * to know the two happen to share an implementation.
 */

/** The raw fields `addVideoChunkRaw`/`addAudioChunkRaw` need, extracted from an `EncodedVideoChunk`/`EncodedAudioChunk`. */
export interface RawChunkBytes {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number;
}

/** The narrow structural surface both `EncodedVideoChunk` and `EncodedAudioChunk` share, all `extractRawChunkBytes`'s shared helper needs. */
interface RawExtractableChunk {
  readonly byteLength: number;
  readonly type: "key" | "delta";
  readonly timestamp: number;
  readonly duration: number | null;
  copyTo(destination: Uint8Array): void;
}

/** Thrown when a chunk's `duration` is `null` (WebCodecs permits this; both muxers' `addVideoChunkRaw`/`addAudioChunkRaw` require a real number). */
export class MissingChunkDurationError extends Error {
  constructor(frame: number) {
    super(
      `Chunk for frame ${frame} has a null duration. encodeFrames always sets a duration derived from fps (see capture-timestamp.ts), so a null duration here means this chunk did not come from this package's own encodeFrames, or the encoder implementation omitted it.`,
    );
    this.name = "MissingChunkDurationError";
  }
}

/** Thrown when an audio chunk's `duration` is `null`, the audio-side counterpart to `MissingChunkDurationError`. */
export class MissingAudioChunkDurationError extends Error {
  constructor(chunkIndex: number) {
    super(
      `Audio chunk ${chunkIndex} has a null duration. encodeAudio always sets a duration derived from sampleRate/chunkFrames (see encode-audio.ts), so a null duration here means this chunk did not come from this package's own encodeAudio, or the encoder implementation omitted it.`,
    );
    this.name = "MissingAudioChunkDurationError";
  }
}

/**
 * Copies `chunk`'s encoded bytes out via `copyTo` into a freshly allocated
 * `Uint8Array` of exactly `chunk.byteLength`, alongside its `type`/
 * `timestamp`/`duration`. Shared by `extractRawChunkBytes` (video) and
 * `extractRawAudioChunkBytes` (audio); `throwMissingDuration` lets each
 * public wrapper throw its own distinctly-named, correctly-indexed error.
 */
function extractRawBytes(
  chunk: RawExtractableChunk,
  throwMissingDuration: () => never,
): RawChunkBytes {
  if (chunk.duration === null) {
    throwMissingDuration();
  }

  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);

  return {
    data,
    type: chunk.type,
    timestamp: chunk.timestamp,
    duration: chunk.duration,
  };
}

/**
 * Copies `chunk`'s encoded bytes out via `copyTo` into a freshly allocated
 * `Uint8Array` of exactly `chunk.byteLength`, alongside its `type`/
 * `timestamp`/`duration`, ready to pass to `addVideoChunkRaw`.
 *
 * `frame` is only used for `MissingChunkDurationError`'s message (mirroring
 * `EncodedChunkResult.frame`, this data's origin), not read from `chunk`
 * itself: `EncodedVideoChunk` carries no frame index of its own.
 *
 * @throws {MissingChunkDurationError} if `chunk.duration` is `null`.
 */
export function extractRawChunkBytes(chunk: EncodedVideoChunk, frame: number): RawChunkBytes {
  return extractRawBytes(chunk, () => {
    throw new MissingChunkDurationError(frame);
  });
}

/**
 * Copies `chunk`'s encoded bytes out via `copyTo` into a freshly allocated
 * `Uint8Array` of exactly `chunk.byteLength`, alongside its `type`/
 * `timestamp`/`duration`, ready to pass to `addAudioChunkRaw`. Audio-side
 * counterpart to `extractRawChunkBytes`; see this module's own top-level
 * doc for why `EncodedAudioChunk` can share the same extraction logic.
 *
 * `chunkIndex` is only used for `MissingAudioChunkDurationError`'s message
 * (mirroring `EncodedAudioChunkResult.chunkIndex`, this data's origin), not
 * read from `chunk` itself.
 *
 * @throws {MissingAudioChunkDurationError} if `chunk.duration` is `null`.
 */
export function extractRawAudioChunkBytes(
  chunk: EncodedAudioChunk,
  chunkIndex: number,
): RawChunkBytes {
  return extractRawBytes(chunk, () => {
    throw new MissingAudioChunkDurationError(chunkIndex);
  });
}
