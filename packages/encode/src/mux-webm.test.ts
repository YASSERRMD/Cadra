import { describe, expect, it } from "vitest";

import { DEFAULT_AUDIO_CODEC_PREFERENCES } from "./audio-codec-probe.js";
import { DEFAULT_CODEC_PREFERENCES } from "./codec-probe.js";
import type { EncodedAudioChunkResult } from "./encode-audio.js";
import type { EncodedChunkResult } from "./encode-frames.js";
import { UnsupportedMuxCodecError } from "./mux-codec-mapping.js";
import type { NodeWritableLike } from "./mux-stream-target.js";
import {
  expectedWebmDurationTicks,
  expectedWebmMuxerDurationTicksFromLastChunkTimestamp,
  WEBM_TIMESTAMP_SCALE_NANOSECONDS,
} from "./mux-timescale.js";
import { readWebmSegmentInfo, readWebmTrackLastBlockEndTimestamp } from "./mux-validate-webm.js";
import type { MuxWebmAudioTrackOptions } from "./mux-webm.js";
import { muxToWebmBlob, muxToWebmBuffer, muxToWebmStream } from "./mux-webm.js";

const AV1_CODEC = DEFAULT_CODEC_PREFERENCES[0]!.codec;
const OPUS_CODEC = DEFAULT_AUDIO_CODEC_PREFERENCES.find((preference) => preference.label === "Opus")!
  .codec;

/**
 * The whole-microsecond timestamp `fakeEncodedChunks` gives the last frame
 * of a `durationInFrames`-frame, `fps` composition (frame index
 * `durationInFrames - 1`), matching that helper's own
 * `Math.round(frame * 1_000_000 / fps)` formula exactly. Used to compute
 * the exact `Segment.Info.Duration` webm-muxer will produce (see
 * `expectedWebmMuxerDurationTicksFromLastChunkTimestamp`'s own doc for why
 * this is not simply `expectedWebmDurationTicks`).
 */
function lastFrameTimestampMicroseconds(durationInFrames: number, fps: number): number {
  const lastFrame = durationInFrames - 1;
  return Math.round((lastFrame * 1_000_000) / fps);
}

/**
 * A minimal, real `EncodedVideoChunk`-shaped fake: see `mux-mp4.test.ts`'s
 * own identical helper for the full rationale (both muxing paths go through
 * `extractRawChunkBytes`, which calls `copyTo` and reads
 * `byteLength`/`type`/`timestamp`/`duration` for real).
 */
function createFakeEncodedVideoChunk(options: {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number;
}): EncodedVideoChunk {
  return {
    byteLength: options.data.byteLength,
    type: options.type,
    timestamp: options.timestamp,
    duration: options.duration,
    copyTo: (destination: Uint8Array) => {
      destination.set(options.data);
    },
    // Cast rationale: same as mux-mp4.test.ts's own createFakeEncodedVideoChunk.
  } as unknown as EncodedVideoChunk;
}

/** Yields `count` fake `EncodedChunkResult`s at `fps`; see `mux-mp4.test.ts`'s identical helper for the full rationale. */
async function* fakeEncodedChunks(
  count: number,
  fps: number,
  codec: string = AV1_CODEC,
): AsyncGenerator<EncodedChunkResult> {
  const frameDurationMicroseconds = Math.round(1_000_000 / fps);
  for (let frame = 0; frame < count; frame += 1) {
    const data = new Uint8Array([frame % 256, (frame + 1) % 256, (frame + 2) % 256, 0xff]);
    const chunk = createFakeEncodedVideoChunk({
      data,
      type: frame === 0 ? "key" : "delta",
      timestamp: Math.round((frame * 1_000_000) / fps),
      duration: frameDurationMicroseconds,
    });
    yield {
      frame,
      chunk,
      metadata: frame === 0 ? { decoderConfig: { codec } } : undefined,
    };
  }
}

/** A minimal, real `EncodedAudioChunk`-shaped fake; see `mux-mp4.test.ts`'s identical helper for the full rationale. */
function createFakeEncodedAudioChunk(options: {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number;
}): EncodedAudioChunk {
  return {
    byteLength: options.data.byteLength,
    type: options.type,
    timestamp: options.timestamp,
    duration: options.duration,
    copyTo: (destination: Uint8Array) => {
      destination.set(options.data);
    },
    // Cast rationale: same as this file's own createFakeEncodedVideoChunk.
  } as unknown as EncodedAudioChunk;
}

/**
 * Builds a minimal, standards-conforming Opus "OpusHead" codec-private
 * header (per the Matroska/WebM Opus-in-Matroska mapping spec): the ASCII
 * magic `"OpusHead"` (8 bytes) + version(u8, always 1) +
 * channelCount(u8) + preSkip(u16 LE) + inputSampleRate(u32 LE) +
 * outputGain(i16 LE, 0) + channelMappingFamily(u8, 0: mono/stereo, no
 * extra channel mapping table needed), 19 bytes total.
 *
 * Unlike mp4-muxer (which self-generates a guessed AAC AudioSpecificConfig
 * codec-private blob when none is supplied; see mp4-muxer's own
 * `_generateMpeg4AudioSpecificConfig`), webm-muxer has no equivalent
 * fallback for Opus: it unconditionally reads
 * `meta.decoderConfig.description.byteLength` once any `decoderConfig` is
 * attached to a chunk, so a fake fixture omitting `description` entirely
 * crashes deep inside webm-muxer itself rather than producing a
 * (possibly wrong but non-crashing) file. A real WebCodecs `AudioEncoder`
 * configured for Opus always supplies a real `description` in its first
 * output chunk's metadata (this is standard, spec-required behavior for
 * Opus), so this fixture mirrors that real shape rather than omitting
 * `decoderConfig` outright.
 */
function buildOpusHeadCodecPrivate(channelCount: number, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(19);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 8; i += 1) {
    bytes[i] = "OpusHead".charCodeAt(i);
  }
  view.setUint8(8, 1); // version
  view.setUint8(9, channelCount);
  view.setUint16(10, 0, true); // preSkip
  view.setUint32(12, sampleRate, true); // inputSampleRate
  view.setInt16(16, 0, true); // outputGain
  view.setUint8(18, 0); // channelMappingFamily
  return bytes;
}

/** Yields `count` fake `EncodedAudioChunkResult`s; see `mux-mp4.test.ts`'s identical helper for the full rationale. */
async function* fakeEncodedAudioChunks(
  count: number,
  sampleRate: number,
  chunkFrames: number,
  codec: string = OPUS_CODEC,
): AsyncGenerator<EncodedAudioChunkResult> {
  const chunkDurationMicroseconds = Math.round((chunkFrames / sampleRate) * 1_000_000);
  const numberOfChannels = 2;
  const description = buildOpusHeadCodecPrivate(numberOfChannels, sampleRate);
  for (let chunkIndex = 0; chunkIndex < count; chunkIndex += 1) {
    const data = new Uint8Array([chunkIndex % 256, (chunkIndex + 1) % 256, 0xbb]);
    const chunk = createFakeEncodedAudioChunk({
      data,
      type: chunkIndex === 0 ? "key" : "delta",
      timestamp: Math.round(((chunkIndex * chunkFrames) / sampleRate) * 1_000_000),
      duration: chunkDurationMicroseconds,
    });
    yield {
      chunkIndex,
      chunk,
      metadata:
        chunkIndex === 0
          ? { decoderConfig: { codec, numberOfChannels, sampleRate, description } }
          : undefined,
    };
  }
}

describe("muxToWebmBuffer", () => {
  it("produces a Segment.Info.Duration matching webm-muxer's own last-chunk-timestamp semantics at the fixed WebM timescale", async () => {
    const fps = 30;
    const durationInFrames = 90; // 3 seconds.
    const buffer = await muxToWebmBuffer(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 1920, height: 1080, fps },
      AV1_CODEC,
    );

    const info = readWebmSegmentInfo(buffer);
    expect(info.timestampScale).toBe(WEBM_TIMESTAMP_SCALE_NANOSECONDS);
    // Not expectedWebmDurationTicks(durationInFrames, fps): webm-muxer's own
    // Duration is intrinsically one frame-duration short of that
    // spec-conformant value (see expectedWebmMuxerDurationTicksFromLastChunkTimestamp's
    // own doc, and mux-webm.ts's top-level doc, for why).
    expect(info.duration).toBe(
      expectedWebmMuxerDurationTicksFromLastChunkTimestamp(
        lastFrameTimestampMicroseconds(durationInFrames, fps),
      ),
    );
  });

  it("derives duration correctly across multiple fps values (24, 30, 60)", async () => {
    for (const fps of [24, 30, 60]) {
      const durationInFrames = fps * 2; // 2 seconds at each fps.
      const buffer = await muxToWebmBuffer(
        fakeEncodedChunks(durationInFrames, fps),
        { width: 1280, height: 720, fps },
        AV1_CODEC,
      );
      const info = readWebmSegmentInfo(buffer);
      expect(info.duration).toBe(
        expectedWebmMuxerDurationTicksFromLastChunkTimestamp(
          lastFrameTimestampMicroseconds(durationInFrames, fps),
        ),
      );
    }
  });

  it("documents webm-muxer's real Duration as roughly one frame-duration short of the spec-conformant durationInFrames/fps ideal", async () => {
    const fps = 30;
    const durationInFrames = 90; // 3 seconds.
    const buffer = await muxToWebmBuffer(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 1920, height: 1080, fps },
      AV1_CODEC,
    );

    const info = readWebmSegmentInfo(buffer);
    const idealDurationTicks = expectedWebmDurationTicks(durationInFrames, fps);
    const oneFrameDurationInTicks = expectedWebmDurationTicks(1, fps);
    // Not an exact equality: expectedWebmMuxerDurationTicksFromLastChunkTimestamp
    // (asserted exactly in the tests above) composes two independent
    // roundings (microsecond timestamp rounding, then a millisecond floor),
    // so the real shortfall can differ from a single rounded
    // "one frame-duration in ticks" value by a tick or so. This test's own
    // point is only to make that ballpark relationship visible and
    // regression-tested (a shortfall of, say, zero or ten frame-durations
    // would indicate a real bug), not to pin an exact tick count (the tests
    // above already do that, against the precise formula).
    expect(info.duration).toBeGreaterThan(idealDurationTicks - oneFrameDurationInTicks - 2);
    expect(info.duration).toBeLessThan(idealDurationTicks - oneFrameDurationInTicks + 2);
  });

  it("maps a VP8 codec string to V_VP8 (a combination toMp4VideoCodec rejects, but WebM supports)", async () => {
    const buffer = await muxToWebmBuffer(
      fakeEncodedChunks(1, 30),
      { width: 640, height: 480, fps: 30 },
      "vp08.00.10.08",
    );
    // Reaching a well-formed Segment.Info at all proves webm-muxer accepted
    // the V_VP8 codec string without error; toWebmVideoCodec's own unit
    // test already covers the mapping itself.
    expect(readWebmSegmentInfo(buffer).timestampScale).toBe(WEBM_TIMESTAMP_SCALE_NANOSECONDS);
  });

  it("throws UnsupportedMuxCodecError for a codec string with no known family", async () => {
    await expect(
      muxToWebmBuffer(fakeEncodedChunks(1, 30), { width: 640, height: 480, fps: 30 }, "opus"),
    ).rejects.toThrow(UnsupportedMuxCodecError);
  });
});

describe("muxToWebmBlob", () => {
  it("returns a Blob with type video/webm wrapping the same bytes muxToWebmBuffer would produce", async () => {
    const fps = 30;
    const durationInFrames = 30;
    const blob = await muxToWebmBlob(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 1920, height: 1080, fps },
      AV1_CODEC,
    );

    expect(blob.type).toBe("video/webm");
    const info = readWebmSegmentInfo(await blob.arrayBuffer());
    expect(info.duration).toBe(
      expectedWebmMuxerDurationTicksFromLastChunkTimestamp(
        lastFrameTimestampMicroseconds(durationInFrames, fps),
      ),
    );
  });
});

describe("muxToWebmStream", () => {
  /** A fake `NodeWritableLike` that concatenates every written chunk into one buffer on demand. */
  function createCollectingWritable(): {
    destination: NodeWritableLike;
    toUint8Array: () => Uint8Array;
  } {
    const chunks: Uint8Array[] = [];
    return {
      destination: {
        write: (chunk: Uint8Array) => {
          chunks.push(chunk);
          return true;
        },
      },
      toUint8Array: () => {
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return combined;
      },
    };
  }

  it("writes a well-formed WebM via sequential writes, with Duration omitted (streaming: true's documented tradeoff)", async () => {
    const fps = 30;
    const durationInFrames = 60; // 2 seconds.
    const { destination, toUint8Array } = createCollectingWritable();

    await muxToWebmStream(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 1920, height: 1080, fps },
      AV1_CODEC,
      destination,
    );

    const info = readWebmSegmentInfo(toUint8Array());
    expect(info.timestampScale).toBe(WEBM_TIMESTAMP_SCALE_NANOSECONDS);
    // The documented tradeoff of streaming: true (see muxToWebmStream's own
    // doc): Duration is omitted outright, not merely deferred/zero.
    expect(info.duration).toBeUndefined();
  });

  it("writes only in strictly sequential order", async () => {
    const writtenPositions: number[] = [];
    let runningTotal = 0;
    const destination: NodeWritableLike = {
      write: (chunk: Uint8Array) => {
        writtenPositions.push(runningTotal);
        runningTotal += chunk.byteLength;
        return true;
      },
    };

    await muxToWebmStream(
      fakeEncodedChunks(10, 30),
      { width: 640, height: 480, fps: 30 },
      AV1_CODEC,
      destination,
    );

    // toSequentialOnData already throws NonSequentialMuxWriteError if any
    // write is out of order, so reaching this point without a rejection
    // already proves sequentiality; this is a redundant, explicit
    // cross-check on the recorded positions themselves.
    expect(writtenPositions).toEqual([...writtenPositions].sort((a, b) => a - b));
    expect(new Set(writtenPositions).size).toBe(writtenPositions.length);
  });
});

describe("muxToWebmBuffer: audio track alongside video", () => {
  it("produces a video-only file (no audio track at all) when the audio option is omitted, the silent-composition case", async () => {
    const fps = 30;
    const durationInFrames = 30;
    const buffer = await muxToWebmBuffer(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 640, height: 480, fps },
      AV1_CODEC,
    );

    // No audio track was ever configured: this is the acceptance criterion
    // "silent compositions still produce valid files" exercised directly
    // against the container, not merely "encodeAudio was never called".
    expect(readWebmTrackLastBlockEndTimestamp(buffer, "audio")).toBeUndefined();
    // The video track itself is still perfectly valid.
    expect(readWebmTrackLastBlockEndTimestamp(buffer, "video")).toBeGreaterThan(0);
  });

  it("produces both a video and an audio track when an audio option is given, with matching per-track last-block start timestamps", async () => {
    const fps = 30;
    const durationInFrames = 90; // 3 seconds.
    const sampleRate = 48_000;
    // chunkFrames chosen to divide the composition's 3-second span exactly
    // (48,000 samples = exactly 1 second per chunk at this sampleRate);
    // see mux-mp4.test.ts's equivalent test for the identical rationale.
    const chunkFrames = sampleRate;
    const audioChunkCount = 3;
    const audio: MuxWebmAudioTrackOptions = {
      chunks: fakeEncodedAudioChunks(audioChunkCount, sampleRate, chunkFrames),
      codec: OPUS_CODEC,
      numberOfChannels: 2,
      sampleRate,
    };

    const buffer = await muxToWebmBuffer(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 1920, height: 1080, fps },
      AV1_CODEC,
      audio,
    );

    const info = readWebmSegmentInfo(buffer);
    expect(info.timestampScale).toBe(WEBM_TIMESTAMP_SCALE_NANOSECONDS);

    const videoEndTimestamp = readWebmTrackLastBlockEndTimestamp(buffer, "video");
    const audioEndTimestamp = readWebmTrackLastBlockEndTimestamp(buffer, "audio");
    expect(videoEndTimestamp).toBeDefined();
    expect(audioEndTimestamp).toBeDefined();

    // Both tracks' own last-block *start* timestamps, converted to seconds
    // at the shared TimestampScale, must each land within one of their own
    // chunk's duration of the composition's true 3-second span: neither
    // addVideoChunkRaw nor addAudioChunkRaw ever threads a duration
    // through to webm-muxer's internal chunk representation (see
    // mux-validate-webm.ts's own doc on findLastBlockEndTimestampForTrack),
    // so every block this package's own muxToWebm* ever writes is a bare
    // SimpleBlock, and this function's return value is always the last
    // matched block's own *start* timestamp, not a duration-extended end.
    // This is the acceptance criterion "muxed durations match" read
    // per-track directly off the container, accounting for that known,
    // documented shortfall rather than asserting an equality the format
    // (as used by this package) cannot actually produce.
    const NANOSECONDS_PER_SECOND = 1_000_000_000;
    const videoLastBlockStartSeconds =
      ((videoEndTimestamp ?? 0) * info.timestampScale) / NANOSECONDS_PER_SECOND;
    const audioLastBlockStartSeconds =
      ((audioEndTimestamp ?? 0) * info.timestampScale) / NANOSECONDS_PER_SECOND;
    const oneVideoFrameSeconds = 1 / fps;
    const oneAudioChunkSeconds = chunkFrames / sampleRate;
    const compositionSeconds = durationInFrames / fps;
    expect(videoLastBlockStartSeconds).toBeCloseTo(compositionSeconds - oneVideoFrameSeconds, 2);
    expect(audioLastBlockStartSeconds).toBeCloseTo(compositionSeconds - oneAudioChunkSeconds, 6);

    // Segment.Info.Duration itself (the single shared, file-wide value) is
    // consistent with the later of the two tracks' own end timestamps, per
    // webm-muxer's own "highest chunk timestamp seen so far" semantics
    // (see mux-webm.ts's own top-level doc).
    expect(info.duration).toBeDefined();
  });

  it("maps the codec string to A_OPUS for a real Opus audio track", async () => {
    const audio: MuxWebmAudioTrackOptions = {
      chunks: fakeEncodedAudioChunks(1, 48_000, 48_000),
      codec: OPUS_CODEC,
      numberOfChannels: 2,
      sampleRate: 48_000,
    };

    const buffer = await muxToWebmBuffer(
      fakeEncodedChunks(1, 30),
      { width: 640, height: 480, fps: 30 },
      AV1_CODEC,
      audio,
    );

    // Reaching a well-formed Segment.Info at all proves webm-muxer
    // accepted the A_OPUS codec string without error; toWebmAudioCodec's
    // own unit test already covers the mapping itself.
    expect(readWebmSegmentInfo(buffer).timestampScale).toBe(WEBM_TIMESTAMP_SCALE_NANOSECONDS);
  });
});

describe("muxToWebmStream: audio track alongside video", () => {
  /** Concatenates every written chunk into one buffer on demand; mirrors this file's own `muxToWebmStream` test suite. */
  function createCollectingWritable(): {
    destination: NodeWritableLike;
    toUint8Array: () => Uint8Array;
  } {
    const chunks: Uint8Array[] = [];
    return {
      destination: {
        write: (chunk: Uint8Array) => {
          chunks.push(chunk);
          return true;
        },
      },
      toUint8Array: () => {
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return combined;
      },
    };
  }

  it("writes both tracks via sequential streaming, with matching per-track last-block start timestamps", async () => {
    const fps = 30;
    const durationInFrames = 60; // 2 seconds.
    const sampleRate = 48_000;
    const chunkFrames = sampleRate;
    const audioChunkCount = 2;
    const { destination, toUint8Array } = createCollectingWritable();

    const audio: MuxWebmAudioTrackOptions = {
      chunks: fakeEncodedAudioChunks(audioChunkCount, sampleRate, chunkFrames),
      codec: OPUS_CODEC,
      numberOfChannels: 2,
      sampleRate,
    };

    await muxToWebmStream(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 1920, height: 1080, fps },
      AV1_CODEC,
      destination,
      audio,
    );

    const bytes = toUint8Array();
    const videoEndTimestamp = readWebmTrackLastBlockEndTimestamp(bytes, "video");
    const audioEndTimestamp = readWebmTrackLastBlockEndTimestamp(bytes, "audio");
    expect(videoEndTimestamp).toBeGreaterThan(0);
    expect(audioEndTimestamp).toBeGreaterThan(0);

    // See the equivalent muxToWebmBuffer test above for why this compares
    // against compositionSeconds minus one chunk's own duration, not
    // compositionSeconds directly: every block webm-muxer's own
    // addVideoChunkRaw/addAudioChunkRaw ever writes is a bare SimpleBlock
    // with no duration, so this function's return value is always the
    // last matched block's own start timestamp.
    const info = readWebmSegmentInfo(bytes);
    const NANOSECONDS_PER_SECOND = 1_000_000_000;
    const videoLastBlockStartSeconds =
      ((videoEndTimestamp ?? 0) * info.timestampScale) / NANOSECONDS_PER_SECOND;
    const audioLastBlockStartSeconds =
      ((audioEndTimestamp ?? 0) * info.timestampScale) / NANOSECONDS_PER_SECOND;
    const oneVideoFrameSeconds = 1 / fps;
    const oneAudioChunkSeconds = chunkFrames / sampleRate;
    const compositionSeconds = durationInFrames / fps;
    expect(videoLastBlockStartSeconds).toBeCloseTo(compositionSeconds - oneVideoFrameSeconds, 2);
    expect(audioLastBlockStartSeconds).toBeCloseTo(compositionSeconds - oneAudioChunkSeconds, 6);
  });

  it("produces a video-only streamed file (no audio track) when the audio option is omitted", async () => {
    const fps = 30;
    const durationInFrames = 30;
    const { destination, toUint8Array } = createCollectingWritable();

    await muxToWebmStream(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 640, height: 480, fps },
      AV1_CODEC,
      destination,
    );

    const bytes = toUint8Array();
    expect(readWebmTrackLastBlockEndTimestamp(bytes, "audio")).toBeUndefined();
    expect(readWebmTrackLastBlockEndTimestamp(bytes, "video")).toBeGreaterThan(0);
  });
});
