import { ArrayBufferTarget, Muxer as WebmMuxer, StreamTarget as WebmStreamTarget } from "webm-muxer";

import type { EncodedChunkResult } from "./encode-frames.js";
import { extractRawChunkBytes } from "./mux-chunk-bytes.js";
import { toWebmVideoCodec } from "./mux-codec-mapping.js";
import type { NodeWritableLike, WebWritableStreamLike } from "./mux-stream-target.js";
import { toSequentialOnData } from "./mux-stream-target.js";

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
 * Consumes `chunks` (Phase 20's `encodeFrames` output) into `muxer` in
 * arrival order, then finalizes. Shared by every `muxToWebm*` entry point
 * below so the actual chunk-feeding loop has exactly one implementation.
 *
 * Uses `addVideoChunkRaw` rather than `addVideoChunk`: see
 * `mux-chunk-bytes.ts`'s own doc for why (in short, `addVideoChunk`
 * requires a real `instanceof EncodedVideoChunk`, which only a genuine
 * WebCodecs-capable environment provides). Unlike mp4-muxer's
 * `addVideoChunkRaw`, webm-muxer's version takes no explicit `duration`
 * argument (Matroska has no per-sample duration field the way an MP4 sample
 * table does; a track's overall duration comes from its blocks'
 * timestamps), so `extractRawChunkBytes`'s `duration` field is read (and
 * validated non-null) but not threaded through here.
 */
async function feedChunksIntoMuxer(
  muxer: WebmMuxer<ArrayBufferTarget | WebmStreamTarget>,
  chunks: AsyncGenerator<EncodedChunkResult>,
): Promise<void> {
  for await (const { frame, chunk, metadata } of chunks) {
    const raw = extractRawChunkBytes(chunk, frame);
    muxer.addVideoChunkRaw(raw.data, raw.type, raw.timestamp, metadata);
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
 */
export async function muxToWebmBuffer(
  chunks: AsyncGenerator<EncodedChunkResult>,
  options: MuxWebmOptions,
  firstChunkCodec: string,
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
  });

  await feedChunksIntoMuxer(muxer, chunks);
  return target.buffer;
}

/**
 * Muxes `chunks` into a WebM file and returns it as a `Blob`
 * (`video/webm`), ready to be wrapped in `URL.createObjectURL` for a browser
 * download link or `<video>` source.
 */
export async function muxToWebmBlob(
  chunks: AsyncGenerator<EncodedChunkResult>,
  options: MuxWebmOptions,
  firstChunkCodec: string,
): Promise<Blob> {
  const buffer = await muxToWebmBuffer(chunks, options, firstChunkCodec);
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
 */
export async function muxToWebmStream(
  chunks: AsyncGenerator<EncodedChunkResult>,
  options: MuxWebmOptions,
  firstChunkCodec: string,
  destination: NodeWritableLike | WebWritableStreamLike,
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
  });

  await feedChunksIntoMuxer(muxer, chunks);
}
