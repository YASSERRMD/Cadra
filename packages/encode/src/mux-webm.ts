import {
  ArrayBufferTarget,
  Muxer as WebmMuxer,
  StreamTarget as WebmStreamTarget,
} from "webm-muxer";

import type { EncodedAudioChunkResult } from "./encode-audio.js";
import type { EncodedChunkResult } from "./encode-frames.js";
import { mergeVideoAndAudioChunks } from "./mux-audio-video-merge.js";
import { extractRawAudioChunkBytes, extractRawChunkBytes } from "./mux-chunk-bytes.js";
import { toWebmAudioCodec, toWebmVideoCodec } from "./mux-codec-mapping.js";
import type { NodeWritableLike, WebWritableStreamLike } from "./mux-stream-target.js";
import { toSequentialOnData } from "./mux-stream-target.js";

/**
 * A known, documented limitation of webm-muxer itself (not something any
 * option to `Muxer`'s constructor changes): the `Segment.Info.Duration` it
 * writes (when it writes one at all; see `muxToWebmStream`'s own doc for
 * when it does not) is tracked internally as "the highest video chunk
 * timestamp seen so far," with no addition for that last chunk's own
 * duration. This makes it intrinsically one frame-duration short of
 * `durationInFrames / fps` (this codebase's definition of a composition's
 * full duration, including the last frame's own extent): the true final
 * frame (index `durationInFrames - 1`) is credited only with its own start
 * time, never the further `1 / fps` seconds it itself spans. See
 * `mux-timescale.ts`'s `expectedWebmMuxerDurationTicksFromLastChunkTimestamp`
 * for the exact value this produces (used by this package's own test suite
 * to assert against webm-muxer's real, documented behavior rather than a
 * value it cannot actually produce).
 */

/** Options accepted by `muxToWebmBlob`/`muxToWebmBuffer`/`muxToWebmStream`. */
export interface MuxWebmOptions {
  /** Output video width in pixels; must match what `encodeFrames` was configured with. */
  width: number;
  /** Output video height in pixels; must match what `encodeFrames` was configured with. */
  height: number;
  /**
   * Frame rate of the composition. Threaded into webm-muxer's
   * `video.frameRate`, which (per webm-muxer's own doc) is metadata-only:
   * unlike mp4-muxer, it does not round chunk timestamps to it. Still worth
   * always supplying: it is what a player reads back to report fps (this
   * phase's acceptance criteria), and the source of truth for the codec
   * `DefaultDuration` element written into the WebM track itself.
   */
  fps: number;
}

/**
 * Describes an optional audio track to mux alongside the video track, i.e.
 * Phase 22's `encodeAudio` output. Mirrors `mux-mp4.ts`'s
 * `MuxMp4AudioTrackOptions`; see its own doc for why a silent composition
 * should omit this entirely rather than pass a track with zero chunks.
 */
export interface MuxWebmAudioTrackOptions {
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
 * Shared by every `muxToWebm*` entry point below so the actual
 * chunk-feeding loop has exactly one implementation.
 *
 * Uses `addVideoChunkRaw`/`addAudioChunkRaw` rather than `addVideoChunk`/
 * `addAudioChunk`: see `mux-chunk-bytes.ts`'s own doc for why (in short,
 * `addVideoChunk`/`addAudioChunk` require a real `instanceof
 * EncodedVideoChunk`/`EncodedAudioChunk`, which only a genuine
 * WebCodecs-capable environment provides). Unlike mp4-muxer's
 * `addVideoChunkRaw`/`addAudioChunkRaw`, webm-muxer's versions take no
 * explicit `duration` argument (Matroska has no per-sample duration field
 * the way an MP4 sample table does; a track's overall duration comes from
 * its blocks' timestamps), so `extractRawChunkBytes`'s/
 * `extractRawAudioChunkBytes`'s `duration` field is read (and validated
 * non-null) but not threaded through here.
 *
 * When `audio` is provided, both streams are consumed concurrently via
 * `mergeVideoAndAudioChunks`; see that function's own doc for why
 * interleaving call order does not matter to either muxer.
 */
async function feedChunksIntoMuxer(
  muxer: WebmMuxer<ArrayBufferTarget | WebmStreamTarget>,
  chunks: AsyncGenerator<EncodedChunkResult>,
  audio?: MuxWebmAudioTrackOptions,
): Promise<void> {
  if (audio === undefined) {
    for await (const { frame, chunk, metadata } of chunks) {
      const raw = extractRawChunkBytes(chunk, frame);
      muxer.addVideoChunkRaw(raw.data, raw.type, raw.timestamp, metadata);
    }
    muxer.finalize();
    return;
  }

  for await (const merged of mergeVideoAndAudioChunks(chunks, audio.chunks)) {
    if (merged.kind === "video") {
      const { frame, chunk, metadata } = merged.result;
      const raw = extractRawChunkBytes(chunk, frame);
      muxer.addVideoChunkRaw(raw.data, raw.type, raw.timestamp, metadata);
    } else {
      const { chunkIndex, chunk, metadata } = merged.result;
      const raw = extractRawAudioChunkBytes(chunk, chunkIndex);
      muxer.addAudioChunkRaw(raw.data, raw.type, raw.timestamp, metadata);
    }
  }
  muxer.finalize();
}

/**
 * Muxes `chunks` into an in-memory WebM file and returns it as an
 * `ArrayBuffer`.
 *
 * Unlike MP4, WebM (Matroska) has no "Fast Start" concept to opt into:
 * there is no equivalent of relocating a metadata box to the front of the
 * file, because Matroska's `Segment.Info.Duration` is a single small
 * element patched in place at `finalize()` (once the real duration is
 * known), not a separate index/metadata block that can grow large enough to
 * be worth relocating the way an MP4 `moov` box can. This function omits
 * `streaming: true` specifically so that `Duration` element is written
 * (`ArrayBufferTarget` already holds everything in memory, so patching it in
 * place afterward costs nothing extra, mirroring why `muxToMp4Buffer` uses
 * `fastStart: 'in-memory'` unconditionally); see `muxToWebmStream`'s doc for
 * the sequential-write path, where that tradeoff does not hold.
 *
 * `audio` is optional and defaults to omitted (video-only output): see
 * `MuxWebmAudioTrackOptions`'s own doc for why a silent composition should
 * omit it entirely rather than pass a track with zero chunks.
 */
export async function muxToWebmBuffer(
  chunks: AsyncGenerator<EncodedChunkResult>,
  options: MuxWebmOptions,
  firstChunkCodec: string,
  audio?: MuxWebmAudioTrackOptions,
): Promise<ArrayBuffer> {
  const target = new ArrayBufferTarget();
  const muxer = new WebmMuxer({
    target,
    video: {
      codec: toWebmVideoCodec(firstChunkCodec),
      width: options.width,
      height: options.height,
      frameRate: options.fps,
    },
    ...(audio !== undefined && {
      audio: {
        codec: toWebmAudioCodec(audio.codec),
        numberOfChannels: audio.numberOfChannels,
        sampleRate: audio.sampleRate,
      },
    }),
  });

  await feedChunksIntoMuxer(muxer, chunks, audio);
  return target.buffer;
}

/**
 * Muxes `chunks` into a WebM file and returns it as a `Blob`
 * (`video/webm`), ready to be wrapped in `URL.createObjectURL` for a browser
 * download link or `<video>` source. `audio` is optional; see
 * `muxToWebmBuffer`'s doc for its optionality rationale.
 */
export async function muxToWebmBlob(
  chunks: AsyncGenerator<EncodedChunkResult>,
  options: MuxWebmOptions,
  firstChunkCodec: string,
  audio?: MuxWebmAudioTrackOptions,
): Promise<Blob> {
  const buffer = await muxToWebmBuffer(chunks, options, firstChunkCodec, audio);
  return new Blob([buffer], { type: "video/webm" });
}

/**
 * Muxes `chunks` and writes the resulting WebM bytes into `destination` (a
 * Node `Writable` or a spec `WritableStream`), for `@cadra/headless`'s
 * server-side rendering path.
 *
 * Uses `streaming: true`, webm-muxer's option for exactly this case (see its
 * own `MuxerOptions.streaming` doc): without it, webm-muxer reserves a
 * placeholder `Duration` element up front and seeks back to patch in the
 * real value once known, which (like MP4's non-fragmented Fast Start modes;
 * see `muxToMp4Stream`'s doc) requires random access a plain `Writable`/
 * `WritableStream` cannot provide. The tradeoff `streaming: true` accepts,
 * plainly stated since this phase's spec calls for documenting WebM's
 * faststart-equivalent behavior: the resulting file has **no stored overall
 * duration** (the `Segment.Info.Duration` element is omitted outright, not
 * merely deferred) and degraded global seeking, matching how a live stream
 * being muxed as it arrives cannot know its own eventual duration in
 * advance either. `muxToWebmBuffer`/`muxToWebmBlob` do not have this
 * limitation, since holding the file in memory already implies random
 * access. Callers on this path that need a reported duration should track
 * `durationInFrames`/`fps` themselves rather than rely on the container.
 *
 * `audio` is optional; see `muxToWebmBuffer`'s doc for its optionality
 * rationale.
 */
export async function muxToWebmStream(
  chunks: AsyncGenerator<EncodedChunkResult>,
  options: MuxWebmOptions,
  firstChunkCodec: string,
  destination: NodeWritableLike | WebWritableStreamLike,
  audio?: MuxWebmAudioTrackOptions,
): Promise<void> {
  const target = new WebmStreamTarget({
    onData: toSequentialOnData(destination),
  });
  const muxer = new WebmMuxer({
    target,
    streaming: true,
    video: {
      codec: toWebmVideoCodec(firstChunkCodec),
      width: options.width,
      height: options.height,
      frameRate: options.fps,
    },
    ...(audio !== undefined && {
      audio: {
        codec: toWebmAudioCodec(audio.codec),
        numberOfChannels: audio.numberOfChannels,
        sampleRate: audio.sampleRate,
      },
    }),
  });

  await feedChunksIntoMuxer(muxer, chunks, audio);
}
