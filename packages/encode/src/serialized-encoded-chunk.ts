import type { EncodedAudioChunkResult } from "./encode-audio.js";
import type { EncodedChunkResult } from "./encode-frames.js";
import { extractRawAudioChunkBytes, extractRawChunkBytes } from "./mux-chunk-bytes.js";

/**
 * A plain-data, structured-clone-safe rendering of one `EncodedChunkResult`,
 * for crossing a `page.evaluate` return-value boundary (Phase 25's
 * per-range browser render path: a browser page renders and encodes its own
 * frame range, then hands the resulting chunk sequence back to the Node
 * orchestrator as this function's return value, not as live
 * `EncodedVideoChunk`/`VideoFrame` objects, neither of which survives a
 * structured-clone round trip with its methods/behavior intact the way a
 * plain object does).
 *
 * Every field here is exactly what `extractRawChunkBytes` already extracts
 * from a real `EncodedVideoChunk` via `copyTo` (see that module's own doc
 * for why `copyTo` is the one part of `EncodedVideoChunk`'s surface usable
 * without a same-realm `instanceof` check), plus `frame` and the codec
 * description bytes (if any) flattened out of `EncodedChunkResult.metadata`
 * into their own plain, serializable fields.
 */
export interface SerializedEncodedChunk {
  /** Same as `EncodedChunkResult.frame`: this chunk's absolute, composition-wide frame index. */
  frame: number;
  /** Same as `EncodedVideoChunk.type`. */
  type: "key" | "delta";
  /** Same as `EncodedVideoChunk.timestamp` (whole microseconds). */
  timestamp: number;
  /** Same as `EncodedVideoChunk.duration` (whole microseconds); never `null` here (see `extractRawChunkBytes`'s own doc: a `null` duration throws before reaching this function). */
  duration: number;
  /** This chunk's compressed bytes, as a plain array of byte values (0-255), reconstructable via `Uint8Array.from(data)`. */
  data: number[];
  /** `EncodedChunkResult.metadata?.decoderConfig?.codec`, if present. */
  codec: string | undefined;
  /** `EncodedChunkResult.metadata?.decoderConfig?.description`'s bytes, flattened to a plain array (0-255 values), if a description was present at all. `undefined` when this chunk carried no `decoderConfig`/`description` (the common case for every non-keyframe, and even for some keyframes/codecs; see `EncodeFramesOptions`'s own doc). */
  description: number[] | undefined;
}

/**
 * Converts `description` (whatever `AllowSharedBufferSource` shape
 * `VideoDecoderConfig.description` carries: an `ArrayBuffer` or a typed
 * array view over one) into a plain `number[]` of byte values, the only
 * shape guaranteed to survive a `page.evaluate` structured-clone round trip
 * with no loss (a `Uint8Array` itself does survive real structured-clone in
 * general, but this codebase's own existing write bridge
 * (`browser-headless-render-entry.ts`'s `createBridgedWriteTarget`) already
 * established the plain-`number[]`-array convention for exactly this kind
 * of byte data crossing this exact boundary, so this module matches it
 * rather than introducing a second, inconsistent convention).
 */
function toByteArray(description: AllowSharedBufferSource): number[] {
  // `AllowSharedBufferSource` is `ArrayBuffer | SharedArrayBuffer |
  // ArrayBufferView`; `DataView`'s own constructor is the one view type that
  // accepts every one of those three variants directly (unlike
  // `Uint8Array`'s constructor, which rejects a bare `SharedArrayBuffer`),
  // so reading byte-by-byte through a `DataView` handles all three
  // uniformly with no branching on which variant `description` actually is.
  const view = ArrayBuffer.isView(description)
    ? new DataView(description.buffer, description.byteOffset, description.byteLength)
    : new DataView(description);

  const bytes: number[] = new Array<number>(view.byteLength);
  for (let i = 0; i < view.byteLength; i += 1) {
    bytes[i] = view.getUint8(i);
  }
  return bytes;
}

/**
 * Serializes one `EncodedChunkResult` (a live `EncodedVideoChunk` plus its
 * metadata, as `encodeFrames` yields it) into a `SerializedEncodedChunk`:
 * plain, structured-clone-safe data with no live WebCodecs object anywhere
 * in it. See this module's own top-level doc for why this conversion is
 * necessary at all.
 *
 * @throws {MissingChunkDurationError} if `chunkResult.chunk.duration` is
 *   `null` (propagated from `extractRawChunkBytes`).
 */
export function serializeEncodedChunk(chunkResult: EncodedChunkResult): SerializedEncodedChunk {
  const raw = extractRawChunkBytes(chunkResult.chunk, chunkResult.frame);
  const decoderConfig = chunkResult.metadata?.decoderConfig;

  return {
    frame: chunkResult.frame,
    type: raw.type,
    timestamp: raw.timestamp,
    duration: raw.duration,
    data: Array.from(raw.data),
    codec: decoderConfig?.codec,
    description:
      decoderConfig?.description !== undefined ? toByteArray(decoderConfig.description) : undefined,
  };
}

/**
 * Reconstructs a Node-side-usable `EncodedChunkResult`-shaped value from a
 * `SerializedEncodedChunk` (the inverse of `serializeEncodedChunk`), for
 * feeding into `feedChunksIntoMuxer`/`muxToMp4Stream`/`muxToWebmStream` (all
 * of which only ever call `addVideoChunkRaw`-style raw-bytes APIs, via
 * `extractRawChunkBytes`, on the chunk they are given - so this
 * reconstruction only needs to satisfy `extractRawChunkBytes`'s own narrow
 * `RawExtractableChunk` structural surface, not the real, full WebCodecs
 * `EncodedVideoChunk` interface, which a deserialized plain object could
 * never satisfy nominally in a browser environment's own `instanceof`
 * sense anyway).
 *
 * The returned chunk's `copyTo` writes `serialized.data`'s bytes back out
 * (mirroring the real `EncodedVideoChunk.copyTo` contract exactly), and
 * `byteLength`/`type`/`timestamp`/`duration` are plain fields copied
 * straight from `serialized`.
 */
export function deserializeEncodedChunkResult(
  serialized: SerializedEncodedChunk,
): EncodedChunkResult {
  const bytes = Uint8Array.from(serialized.data);
  const chunk = {
    type: serialized.type,
    timestamp: serialized.timestamp,
    duration: serialized.duration,
    byteLength: bytes.byteLength,
    copyTo: (destination: Uint8Array) => {
      destination.set(bytes);
    },
  } as unknown as EncodedVideoChunk;

  const metadata: EncodedVideoChunkMetadata | undefined =
    serialized.codec !== undefined
      ? {
          decoderConfig: {
            codec: serialized.codec,
            ...(serialized.description !== undefined && {
              description: Uint8Array.from(serialized.description),
            }),
          },
        }
      : undefined;

  return { frame: serialized.frame, chunk, metadata };
}

/**
 * The audio-side counterpart to `SerializedEncodedChunk`: same purpose
 * (crossing a `page.evaluate` boundary with no live WebCodecs object in
 * it), same field shapes, `chunkIndex` in place of `frame` (mirroring
 * `EncodedAudioChunkResult`'s own field name - an audio chunk has no frame
 * index of its own to carry).
 */
export interface SerializedEncodedAudioChunk {
  /** Same as `EncodedAudioChunkResult.chunkIndex`. */
  chunkIndex: number;
  /** Same as `EncodedAudioChunk.type`. */
  type: "key" | "delta";
  /** Same as `EncodedAudioChunk.timestamp` (whole microseconds). */
  timestamp: number;
  /** Same as `EncodedAudioChunk.duration` (whole microseconds); never `null` here (see `extractRawAudioChunkBytes`'s own doc: a `null` duration throws before reaching this function). */
  duration: number;
  /** This chunk's compressed bytes, as a plain array of byte values (0-255), reconstructable via `Uint8Array.from(data)`. */
  data: number[];
  /** `EncodedAudioChunkResult.metadata?.decoderConfig?.codec`, if present. */
  codec: string | undefined;
  /** `EncodedAudioChunkResult.metadata?.decoderConfig?.description`'s bytes, flattened to a plain array (0-255 values), if a description was present at all. */
  description: number[] | undefined;
}

/** Audio-side counterpart to `serializeEncodedChunk`; see that function's own doc. */
export function serializeEncodedAudioChunk(
  chunkResult: EncodedAudioChunkResult,
): SerializedEncodedAudioChunk {
  const raw = extractRawAudioChunkBytes(chunkResult.chunk, chunkResult.chunkIndex);
  const decoderConfig = chunkResult.metadata?.decoderConfig;

  return {
    chunkIndex: chunkResult.chunkIndex,
    type: raw.type,
    timestamp: raw.timestamp,
    duration: raw.duration,
    data: Array.from(raw.data),
    codec: decoderConfig?.codec,
    description:
      decoderConfig?.description !== undefined ? toByteArray(decoderConfig.description) : undefined,
  };
}

/** Audio-side counterpart to `deserializeEncodedChunkResult`; see that function's own doc. */
export function deserializeEncodedAudioChunkResult(
  serialized: SerializedEncodedAudioChunk,
): EncodedAudioChunkResult {
  const bytes = Uint8Array.from(serialized.data);
  const chunk = {
    type: serialized.type,
    timestamp: serialized.timestamp,
    duration: serialized.duration,
    byteLength: bytes.byteLength,
    copyTo: (destination: Uint8Array) => {
      destination.set(bytes);
    },
  } as unknown as EncodedAudioChunk;

  // The cast (like `chunk`'s own above) is deliberate: a real
  // `AudioDecoderConfig` also requires `numberOfChannels`/`sampleRate`,
  // which `MuxMp4AudioTrackOptions`/`MuxWebmAudioTrackOptions` already
  // carry as their own top-level fields instead (see this module's own
  // caller, `render-job.ts`'s `muxConcatenatedSegments`) - nothing in this
  // codebase's own mux path reads a chunk's per-chunk decoderConfig for
  // anything beyond `.codec` (mirroring the video-side reconstruction's
  // own identical scope).
  const metadata: EncodedAudioChunkMetadata | undefined =
    serialized.codec !== undefined
      ? ({
          decoderConfig: {
            codec: serialized.codec,
            ...(serialized.description !== undefined && {
              description: Uint8Array.from(serialized.description),
            }),
          },
        } as unknown as EncodedAudioChunkMetadata)
      : undefined;

  return { chunkIndex: serialized.chunkIndex, chunk, metadata };
}
