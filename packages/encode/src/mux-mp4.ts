import { ArrayBufferTarget, Muxer as Mp4Muxer, StreamTarget as Mp4StreamTarget } from "mp4-muxer";

import type { EncodedAudioChunkResult } from "./encode-audio.js";
import type { EncodedChunkResult } from "./encode-frames.js";
import { mergeVideoAndAudioChunks } from "./mux-audio-video-merge.js";
import { extractRawAudioChunkBytes, extractRawChunkBytes } from "./mux-chunk-bytes.js";
import { toMp4AudioCodec, toMp4VideoCodec } from "./mux-codec-mapping.js";
import type { NodeWritableLike, WebWritableStreamLike } from "./mux-stream-target.js";
import { toSequentialOnData } from "./mux-stream-target.js";

/** Options accepted by `muxToMp4Blob`/`muxToMp4Buffer`/`muxToMp4Stream`. */
export interface MuxMp4Options {
  /** Output video width in pixels; must match what `encodeFrames` was configured with. */
  width: number;
  /** Output video height in pixels; must match what `encodeFrames` was configured with. */
  height: number;
  /**
   * Frame rate of the composition. Threaded into mp4-muxer's
   * `VideoOptions.frameRate`, which it uses to round chunk timestamps to
   * exact frame boundaries rather than accumulating floating point drift
   * across a long render (see mp4-muxer's own `VideoOptions.frameRate` doc).
   */
  fps: number;
}

/**
 * Describes an optional audio track to mux alongside the video track, i.e.
 * Phase 22's `encodeAudio` output. Omitted entirely for a composition with
 * no audio (see this phase's own spec: `resolveAudioMixdown` already
 * returns an empty `segments` array for a composition with no
 * `audioTracks`, and a caller detecting that should skip audio
 * encoding/muxing altogether rather than pass a track with zero chunks
 * here), so every `muxToMp4*` function's video-only behavior (and call
 * signature, for every existing positional argument) is entirely unchanged
 * when this parameter is omitted.
 */
export interface MuxMp4AudioTrackOptions {
  /** The encoded audio chunk stream, i.e. `encodeAudio`'s output. */
  chunks: AsyncGenerator<EncodedAudioChunkResult>;
  /** WebCodecs codec string from the first chunk's `metadata.decoderConfig.codec` (mirrors `firstChunkCodec`'s video-side role). */
  codec: string;
  /** Number of audio channels; must match what `encodeAudio`/`renderAudioMixdown` were configured with. */
  numberOfChannels: number;
  /** Sample rate in Hz; must match what `encodeAudio`/`renderAudioMixdown` were configured with. */
  sampleRate: number;
}

/**
 * Consumes `chunks` (Phase 20's `encodeFrames` output) and, when `audio` is
 * given, Phase 22's `encodeAudio` output too, into `muxer`, then finalizes.
 * Shared by every `muxToMp4*` entry point below so the actual chunk-feeding
 * loop has exactly one implementation.
 *
 * Uses `addVideoChunkRaw`/`addAudioChunkRaw` rather than `addVideoChunk`/
 * `addAudioChunk`: see `mux-chunk-bytes.ts`'s own doc for why (in short,
 * `addVideoChunk`/`addAudioChunk` require a real `instanceof
 * EncodedVideoChunk`/`EncodedAudioChunk`, which only a genuine
 * WebCodecs-capable environment provides).
 *
 * When `audio` is provided, both streams are consumed concurrently via
 * `mergeVideoAndAudioChunks` rather than draining `chunks` fully before
 * starting on `audio.chunks` (or vice versa): see that function's own doc
 * for why interleaving call order does not matter to either muxer, only
 * within-track ordering does.
 */
async function feedChunksIntoMuxer(
  muxer: Mp4Muxer<ArrayBufferTarget | Mp4StreamTarget>,
  chunks: AsyncGenerator<EncodedChunkResult>,
  audio?: MuxMp4AudioTrackOptions,
): Promise<void> {
  if (audio === undefined) {
    for await (const { frame, chunk, metadata } of chunks) {
      const raw = extractRawChunkBytes(chunk, frame);
      muxer.addVideoChunkRaw(raw.data, raw.type, raw.timestamp, raw.duration, metadata);
    }
    muxer.finalize();
    return;
  }

  for await (const merged of mergeVideoAndAudioChunks(chunks, audio.chunks)) {
    if (merged.kind === "video") {
      const { frame, chunk, metadata } = merged.result;
      const raw = extractRawChunkBytes(chunk, frame);
      muxer.addVideoChunkRaw(raw.data, raw.type, raw.timestamp, raw.duration, metadata);
    } else {
      const { chunkIndex, chunk, metadata } = merged.result;
      const raw = extractRawAudioChunkBytes(chunk, chunkIndex);
      muxer.addAudioChunkRaw(raw.data, raw.type, raw.timestamp, raw.duration, metadata);
    }
  }
  muxer.finalize();
}

/**
 * Muxes `chunks` into an in-memory MP4 file and returns it as an
 * `ArrayBuffer`, using `fastStart: 'in-memory'`: since `ArrayBufferTarget`
 * already holds the entire file in memory regardless, there is no
 * sequential-write constraint to respect, so the highest-quality Fast Start
 * mode (metadata physically at the front of the file, enabling playback to
 * begin before the full download completes) costs nothing extra here.
 *
 * The lowest-level of the three `muxToMp4*` entry points: `muxToMp4Blob`
 * wraps this in a `Blob` for the common browser-download case, and this
 * function exists separately for callers that want the raw bytes (e.g. to
 * write to a file themselves, or hand to another API expecting an
 * `ArrayBuffer` directly).
 *
 * `audio` is optional and defaults to omitted (video-only output): see
 * `MuxMp4AudioTrackOptions`'s own doc for why a silent composition should
 * omit it entirely rather than pass a track with zero chunks.
 */
export async function muxToMp4Buffer(
  chunks: AsyncGenerator<EncodedChunkResult>,
  options: MuxMp4Options,
  firstChunkCodec: string,
  audio?: MuxMp4AudioTrackOptions,
): Promise<ArrayBuffer> {
  const target = new ArrayBufferTarget();
  const muxer = new Mp4Muxer({
    target,
    fastStart: "in-memory",
    video: {
      codec: toMp4VideoCodec(firstChunkCodec),
      width: options.width,
      height: options.height,
      frameRate: options.fps,
    },
    ...(audio !== undefined && {
      audio: {
        codec: toMp4AudioCodec(audio.codec),
        numberOfChannels: audio.numberOfChannels,
        sampleRate: audio.sampleRate,
      },
    }),
  });

  await feedChunksIntoMuxer(muxer, chunks, audio);
  return target.buffer;
}

/**
 * Muxes `chunks` into an MP4 file and returns it as a `Blob`
 * (`video/mp4`), ready to be wrapped in `URL.createObjectURL` for a browser
 * download link or `<video>` source. See `muxToMp4Buffer`'s doc for why
 * `fastStart: 'in-memory'` is used unconditionally on this path, and for
 * `audio`'s optionality.
 */
export async function muxToMp4Blob(
  chunks: AsyncGenerator<EncodedChunkResult>,
  options: MuxMp4Options,
  firstChunkCodec: string,
  audio?: MuxMp4AudioTrackOptions,
): Promise<Blob> {
  const buffer = await muxToMp4Buffer(chunks, options, firstChunkCodec, audio);
  return new Blob([buffer], { type: "video/mp4" });
}

/**
 * Muxes `chunks` and writes the resulting MP4 bytes into `destination` (a
 * Node `Writable` or a spec `WritableStream`), for `@cadra/headless`'s
 * server-side rendering path where holding the entire file in memory before
 * writing it out is undesirable for large renders.
 *
 * Uses `fastStart: 'fragmented'`, not `'in-memory'`: a plain `Writable`/
 * `WritableStream` only supports sequential, append-only writes (there is no
 * seek-back operation to patch an already-written header once later data's
 * final size is known), and mp4-muxer's `StreamTarget` writes strictly in
 * increasing `position` order in every `fastStart` mode except `'in-memory'`
 * and the reserved-space object form (both of which patch the moov box
 * in place after it turns out to need more or less space than initially
 * guessed). Fragmented MP4 achieves the same "metadata near the front, not
 * one giant moov at the end" playability benefit Fast Start is named for,
 * while writing strictly sequentially, at the cost of being a less
 * universally-supported MP4 variant than a regular (non-fragmented) file;
 * see this module's own top-level doc and the phase's spec for why `false`
 * (regular MP4, moov at the end, worse playback-before-full-download
 * behavior) is not used here instead.
 *
 * `audio` is optional; see `muxToMp4Buffer`'s doc for its optionality
 * rationale.
 */
export async function muxToMp4Stream(
  chunks: AsyncGenerator<EncodedChunkResult>,
  options: MuxMp4Options,
  firstChunkCodec: string,
  destination: NodeWritableLike | WebWritableStreamLike,
  audio?: MuxMp4AudioTrackOptions,
): Promise<void> {
  const target = new Mp4StreamTarget({
    onData: toSequentialOnData(destination),
  });
  const muxer = new Mp4Muxer({
    target,
    fastStart: "fragmented",
    video: {
      codec: toMp4VideoCodec(firstChunkCodec),
      width: options.width,
      height: options.height,
      frameRate: options.fps,
    },
    ...(audio !== undefined && {
      audio: {
        codec: toMp4AudioCodec(audio.codec),
        numberOfChannels: audio.numberOfChannels,
        sampleRate: audio.sampleRate,
      },
    }),
  });

  await feedChunksIntoMuxer(muxer, chunks, audio);
}
