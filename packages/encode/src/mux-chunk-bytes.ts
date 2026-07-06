/**
 * Both mp4-muxer's and webm-muxer's `addVideoChunk` require their first
 * argument to be a real `instanceof EncodedVideoChunk` (each muxer checks
 * this explicitly and throws a `TypeError` otherwise), which only exists as
 * a global in an environment with real WebCodecs support. This package's
 * Vitest/Node test environment (matching every other module in this
 * package: see `video-encoder-factory.ts`'s doc for the same underlying
 * gap) has no such global, so constructing even a fully realistic fake
 * `EncodedVideoChunk` for a test can never satisfy that `instanceof` check.
 *
 * `addVideoChunkRaw` (both muxers' own documented escape hatch for exactly
 * this case: "the encoded video is not obtained through a `VideoEncoder`
 * but through some other means") sidesteps the check entirely by taking the
 * chunk's raw fields directly, so this module extracts those fields via the
 * one part of `EncodedVideoChunk`'s surface that does not require an
 * `instanceof` check to use: `copyTo`. This makes `mux-mp4.ts`/`mux-webm.ts`
 * work identically whether `chunk` is a real WebCodecs `EncodedVideoChunk`
 * (a real browser) or any object merely shaped like one (this package's own
 * tests), with no environment-detection branch needed in either module.
 */

/** The raw fields `addVideoChunkRaw` needs, extracted from an `EncodedVideoChunk`. */
export interface RawChunkBytes {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number;
}

/** Thrown when a chunk's `duration` is `null` (WebCodecs permits this; both muxers' `addVideoChunkRaw` require a real number). */
export class MissingChunkDurationError extends Error {
  constructor(frame: number) {
    super(
      `Chunk for frame ${frame} has a null duration. encodeFrames always sets a duration derived from fps (see capture-timestamp.ts), so a null duration here means this chunk did not come from this package's own encodeFrames, or the encoder implementation omitted it.`,
    );
    this.name = "MissingChunkDurationError";
  }
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
  if (chunk.duration === null) {
    throw new MissingChunkDurationError(frame);
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
