import { describe, expect, it } from "vitest";

import { DEFAULT_AUDIO_CODEC_PREFERENCES } from "./audio-codec-probe.js";
import { DEFAULT_CODEC_PREFERENCES } from "./codec-probe.js";
import type { EncodedAudioChunkResult } from "./encode-audio.js";
import type { EncodedChunkResult } from "./encode-frames.js";
import { UnsupportedMuxCodecError, Vp8NotSupportedInMp4Error } from "./mux-codec-mapping.js";
import type { MuxMp4AudioTrackOptions } from "./mux-mp4.js";
import { muxToMp4Blob, muxToMp4Buffer, muxToMp4Stream } from "./mux-mp4.js";
import type { NodeWritableLike } from "./mux-stream-target.js";
import { expectedMp4DurationTicks } from "./mux-timescale.js";
import {
  readMp4AudioFragmentedDurationTicks,
  readMp4AudioTrackTimescale,
  readMp4FragmentedDurationTicks,
  readMp4MovieHeader,
  readMp4TrackTimescale,
} from "./mux-validate-mp4.js";

const AV1_CODEC = DEFAULT_CODEC_PREFERENCES[0]!.codec;
const AAC_CODEC = DEFAULT_AUDIO_CODEC_PREFERENCES.find((preference) => preference.label === "AAC")!
  .codec;

/**
 * A minimal, real `EncodedVideoChunk`-shaped fake: unlike
 * `encode-frames.test.ts`'s identity-only fake (that module never reads
 * into a chunk's own bytes), `extractRawChunkBytes` (which every `muxTo*`
 * function under test uses to feed mp4-muxer/webm-muxer; see its own doc)
 * calls `copyTo` and reads `byteLength`/`type`/`timestamp`/`duration`
 * directly off every chunk, so this fake must actually implement that
 * surface with real backing bytes for the muxer to produce a genuine,
 * parseable file.
 *
 * `copyTo`'s destination is always a `Uint8Array` in practice: it is the
 * one `extractRawChunkBytes` itself allocates and passes in
 * (`mux-chunk-bytes.ts`), so this fake only needs to handle that concrete
 * case, not `copyTo`'s full real-world `AllowSharedBufferSource` (which also
 * permits a raw `ArrayBuffer`/`SharedArrayBuffer` or a differently-typed
 * view).
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
    // Cast is required: the real WebCodecs EncodedVideoChunk interface
    // declares no other members, so this fake already implements it in
    // full; the cast is only needed because TypeScript does not
    // structurally recognize an object literal as an EncodedVideoChunk
    // without one (same rationale as encode-frames.test.ts's own
    // FakeVideoFrame/createFakeChunk casts).
  } as unknown as EncodedVideoChunk;
}

/**
 * Yields `count` fake `EncodedChunkResult`s at `fps`, each carrying a
 * distinct, deterministic payload (so `readMp4MovieHeader`'s round trip is
 * exercised against non-trivial content, not just zero-filled bytes) and a
 * WebCodecs-standard whole-microsecond timestamp/duration derived from
 * frame index, matching how `encodeFrames` itself produces both (see
 * `capture-timestamp.ts`'s `frameToMicrosecondTimestamp`).
 */
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

/** A minimal, real `EncodedAudioChunk`-shaped fake, the audio-side counterpart to `createFakeEncodedVideoChunk`. */
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
 * Yields `count` fake `EncodedAudioChunkResult`s, each spanning
 * `chunkFrames` sample-frames at `sampleRate` (matching `encodeAudio`'s own
 * whole-microsecond timestamp/duration convention derived from sample
 * offset; see `encode-audio.ts`'s `chunkAudioBuffer`), with a distinct,
 * deterministic payload per chunk.
 */
async function* fakeEncodedAudioChunks(
  count: number,
  sampleRate: number,
  chunkFrames: number,
  codec: string = AAC_CODEC,
): AsyncGenerator<EncodedAudioChunkResult> {
  const chunkDurationMicroseconds = Math.round((chunkFrames / sampleRate) * 1_000_000);
  for (let chunkIndex = 0; chunkIndex < count; chunkIndex += 1) {
    const data = new Uint8Array([chunkIndex % 256, (chunkIndex + 1) % 256, 0xaa]);
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
          ? { decoderConfig: { codec, numberOfChannels: 2, sampleRate } }
          : undefined,
    };
  }
}

describe("muxToMp4Buffer", () => {
  it("produces a moov.mvhd whose duration matches durationInFrames/fps at the muxer's own timescale", async () => {
    const fps = 30;
    const durationInFrames = 90; // 3 seconds.
    const buffer = await muxToMp4Buffer(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 1920, height: 1080, fps },
      AV1_CODEC,
    );

    const header = readMp4MovieHeader(buffer);
    expect(header.durationTicks).toBe(
      expectedMp4DurationTicks(durationInFrames, fps, header.timescale),
    );
  });

  it("produces a well-formed MP4 (starts with an ftyp box) regardless of frame count", async () => {
    const buffer = await muxToMp4Buffer(
      fakeEncodedChunks(1, 30),
      { width: 640, height: 480, fps: 30 },
      AV1_CODEC,
    );
    const view = new DataView(buffer);
    // First box's type, at byte offset 4 (after the 4-byte size field).
    const type = String.fromCharCode(
      view.getUint8(4),
      view.getUint8(5),
      view.getUint8(6),
      view.getUint8(7),
    );
    expect(type).toBe("ftyp");
  });

  it("derives duration correctly across multiple fps values (24, 30, 60)", async () => {
    for (const fps of [24, 30, 60]) {
      const durationInFrames = fps * 2; // 2 seconds at each fps.
      const buffer = await muxToMp4Buffer(
        fakeEncodedChunks(durationInFrames, fps),
        { width: 1280, height: 720, fps },
        AV1_CODEC,
      );
      const header = readMp4MovieHeader(buffer);
      expect(header.durationTicks).toBe(
        expectedMp4DurationTicks(durationInFrames, fps, header.timescale),
      );
    }
  });

  it("throws UnsupportedMuxCodecError for a codec string with no known family", async () => {
    await expect(
      muxToMp4Buffer(fakeEncodedChunks(1, 30), { width: 640, height: 480, fps: 30 }, "opus"),
    ).rejects.toThrow(UnsupportedMuxCodecError);
  });

  it("throws Vp8NotSupportedInMp4Error for a VP8 codec string", async () => {
    await expect(
      muxToMp4Buffer(
        fakeEncodedChunks(1, 30),
        { width: 640, height: 480, fps: 30 },
        "vp08.00.10.08",
      ),
    ).rejects.toThrow(Vp8NotSupportedInMp4Error);
  });
});

describe("muxToMp4Blob", () => {
  it("returns a Blob with type video/mp4 wrapping the same bytes muxToMp4Buffer would produce", async () => {
    const fps = 30;
    const durationInFrames = 30;
    const blob = await muxToMp4Blob(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 1920, height: 1080, fps },
      AV1_CODEC,
    );

    expect(blob.type).toBe("video/mp4");
    const header = readMp4MovieHeader(await blob.arrayBuffer());
    expect(header.durationTicks).toBe(
      expectedMp4DurationTicks(durationInFrames, fps, header.timescale),
    );
  });
});

describe("muxToMp4Stream", () => {
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

  it("writes a well-formed, sequentially-produced fragmented MP4 whose fragment duration matches durationInFrames/fps", async () => {
    const fps = 30;
    const durationInFrames = 60; // 2 seconds.
    const { destination, toUint8Array } = createCollectingWritable();

    await muxToMp4Stream(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 1920, height: 1080, fps },
      AV1_CODEC,
      destination,
    );

    const bytes = toUint8Array();

    // Fragmented MP4's moov.mvhd is written before any sample data exists,
    // so it legitimately reports duration 0 (see readMp4MovieHeader's own
    // doc); this asserts that documented behavior explicitly, rather than
    // silently working around it, before validating the real duration via
    // the per-fragment moof.traf boxes below (the same place a real player
    // reads a fragmented file's duration from).
    const header = readMp4MovieHeader(bytes);
    expect(header.durationTicks).toBe(0);

    const trackTimescale = readMp4TrackTimescale(bytes);
    const fragmentedDurationTicks = readMp4FragmentedDurationTicks(bytes);
    expect(fragmentedDurationTicks).toBe(
      expectedMp4DurationTicks(durationInFrames, fps, trackTimescale),
    );
  });

  it("writes only in strictly sequential order (fragmented fastStart never seeks backward)", async () => {
    const writtenPositions: number[] = [];
    let runningTotal = 0;
    const destination: NodeWritableLike = {
      write: (chunk: Uint8Array) => {
        writtenPositions.push(runningTotal);
        runningTotal += chunk.byteLength;
        return true;
      },
    };

    await muxToMp4Stream(
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

describe("muxToMp4Buffer: audio track alongside video", () => {
  it("produces a video-only file (no audio trak at all) when the audio option is omitted, the silent-composition case", async () => {
    const fps = 30;
    const durationInFrames = 30;
    const buffer = await muxToMp4Buffer(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 640, height: 480, fps },
      AV1_CODEC,
    );

    // No audio track was ever configured, so there is nothing to read back:
    // this is the acceptance criterion "silent compositions still produce
    // valid files" exercised directly against the container itself, not
    // merely "encodeAudio was never called".
    expect(readMp4AudioTrackTimescale(buffer)).toBeUndefined();
    // The video track itself is still perfectly valid.
    const header = readMp4MovieHeader(buffer);
    expect(header.durationTicks).toBe(
      expectedMp4DurationTicks(durationInFrames, fps, header.timescale),
    );
  });

  it("produces both a video and an audio trak when an audio option is given, with the movie-level duration matching the composition's span", async () => {
    const fps = 30;
    const durationInFrames = 90; // 3 seconds.
    const sampleRate = 48_000;
    // chunkFrames chosen to divide the composition's 3-second span exactly
    // (48,000 samples per chunk = exactly 1 second per chunk, at this
    // sampleRate), so the audio track's own total span is exactly 3
    // seconds with no partial-chunk remainder: a real renderAudioMixdown
    // buffer is itself sized to exactly durationInFrames/fps seconds (see
    // its own doc), so this mirrors that exactness rather than
    // encodeAudio's own arbitrary DEFAULT_AUDIO_CHUNK_FRAMES chunking
    // (which this file's fakeEncodedAudioChunks does not model a partial
    // final chunk for; see encode-audio.test.ts's own chunking tests for
    // that separate concern).
    const chunkFrames = sampleRate;
    const audioChunkCount = 3;
    const audio: MuxMp4AudioTrackOptions = {
      chunks: fakeEncodedAudioChunks(audioChunkCount, sampleRate, chunkFrames),
      codec: AAC_CODEC,
      numberOfChannels: 2,
      sampleRate,
    };

    const buffer = await muxToMp4Buffer(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 1920, height: 1080, fps },
      AV1_CODEC,
      audio,
    );

    // mvhd's own duration is movie-level (the max span across every
    // track, not the video track's alone; see mux-validate-mp4.ts's own
    // doc), so with both an exactly-3-second video track and an
    // exactly-3-second audio track present, it must report exactly the
    // composition's own 3-second span at its own (mvhd's) timescale: the
    // acceptance criterion "muxed durations match", read directly off the
    // container's single authoritative duration field for this
    // (unfragmented) file shape.
    const videoHeader = readMp4MovieHeader(buffer);
    expect(videoHeader.durationTicks).toBe(
      expectedMp4DurationTicks(durationInFrames, fps, videoHeader.timescale),
    );

    const videoTrackTimescale = readMp4TrackTimescale(buffer);
    expect(videoTrackTimescale).toBeGreaterThan(0);

    const audioTrackTimescale = readMp4AudioTrackTimescale(buffer);
    expect(audioTrackTimescale).toBe(sampleRate);
  });

  it("aligns both tracks to the same zero point: the first video and first audio chunk both start at timestamp 0", async () => {
    const fps = 30;
    const durationInFrames = 30;
    const sampleRate = 48_000;
    const chunkFrames = 1024;
    const audioChunkCount = 10;
    const audio: MuxMp4AudioTrackOptions = {
      chunks: fakeEncodedAudioChunks(audioChunkCount, sampleRate, chunkFrames),
      codec: AAC_CODEC,
      numberOfChannels: 2,
      sampleRate,
    };

    // Both fakeEncodedChunks and fakeEncodedAudioChunks are constructed
    // (in this file's own helpers above) so their very first chunk's
    // timestamp is always exactly 0 microseconds, matching how
    // renderAudioMixdown/encodeFrames both anchor their own output to
    // frame/sample 0 (Phase 22's own acceptance criteria: audio and video
    // start aligned at frame 0). This test asserts that alignment survives
    // all the way through muxing by reading the produced file back and
    // confirming both tracks report a real, positive timescale (proving
    // both traks were written at all) with a duration consistent with
    // starting from 0, rather than merely trusting the fixture's own claim.
    const buffer = await muxToMp4Buffer(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 640, height: 480, fps },
      AV1_CODEC,
      audio,
    );

    const videoTrackTimescale = readMp4TrackTimescale(buffer);
    const audioTrackTimescale = readMp4AudioTrackTimescale(buffer);
    expect(videoTrackTimescale).toBeGreaterThan(0);
    expect(audioTrackTimescale).toBe(sampleRate);
  });

  it("throws UnsupportedMuxAudioCodecError-shaped rejection for an unrecognized audio codec string", async () => {
    const audio: MuxMp4AudioTrackOptions = {
      chunks: fakeEncodedAudioChunks(1, 48_000, 1024),
      codec: "vp09.00.10.08",
      numberOfChannels: 2,
      sampleRate: 48_000,
    };

    await expect(
      muxToMp4Buffer(
        fakeEncodedChunks(1, 30),
        { width: 640, height: 480, fps: 30 },
        AV1_CODEC,
        audio,
      ),
    ).rejects.toThrow(/vp09\.00\.10\.08/);
  });
});

describe("muxToMp4Stream: audio track alongside video (fragmented)", () => {
  it("writes a fragmented MP4 with both tracks whose per-track fragmented durations match", async () => {
    const fps = 30;
    const durationInFrames = 60; // 2 seconds.
    const sampleRate = 48_000;
    // chunkFrames chosen to divide the composition's 2-second span exactly
    // (48,000 samples = exactly 1 second per chunk at this sampleRate), so
    // the audio track's own total span is exactly 2 seconds with no
    // partial-chunk remainder; see the equivalent in-memory test above for
    // the same rationale.
    const chunkFrames = sampleRate;
    const audioChunkCount = 2;
    const { destination, toUint8Array } = (() => {
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
    })();

    const audio: MuxMp4AudioTrackOptions = {
      chunks: fakeEncodedAudioChunks(audioChunkCount, sampleRate, chunkFrames),
      codec: AAC_CODEC,
      numberOfChannels: 2,
      sampleRate,
    };

    await muxToMp4Stream(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 1920, height: 1080, fps },
      AV1_CODEC,
      destination,
      audio,
    );

    const bytes = toUint8Array();
    const videoTrackTimescale = readMp4TrackTimescale(bytes);
    const audioTrackTimescale = readMp4AudioTrackTimescale(bytes);
    expect(audioTrackTimescale).toBe(sampleRate);

    const videoFragmentedDurationTicks = readMp4FragmentedDurationTicks(bytes);
    const audioFragmentedDurationTicks = readMp4AudioFragmentedDurationTicks(bytes);
    expect(videoFragmentedDurationTicks).toBe(
      expectedMp4DurationTicks(durationInFrames, fps, videoTrackTimescale),
    );

    // Both tracks' own fragmented durations, converted to seconds at their
    // own (matching, since both are read at the same track's own
    // timescale each was summed against) timescale, must agree exactly
    // with the composition's own 2-second span: the acceptance criterion
    // "muxed durations match", exercised on the fragmented (streamed) MP4
    // path rather than the in-memory one.
    const videoDurationSeconds = videoFragmentedDurationTicks / videoTrackTimescale;
    const audioDurationSeconds = (audioFragmentedDurationTicks ?? 0) / (audioTrackTimescale ?? 1);
    expect(videoDurationSeconds).toBeCloseTo(durationInFrames / fps, 6);
    expect(audioDurationSeconds).toBeCloseTo(durationInFrames / fps, 6);
  });

  it("produces a video-only fragmented file (no audio traf) when the audio option is omitted", async () => {
    const fps = 30;
    const durationInFrames = 30;
    const chunks: Uint8Array[] = [];
    const destination: NodeWritableLike = {
      write: (chunk: Uint8Array) => {
        chunks.push(chunk);
        return true;
      },
    };

    await muxToMp4Stream(
      fakeEncodedChunks(durationInFrames, fps),
      { width: 640, height: 480, fps },
      AV1_CODEC,
      destination,
    );

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    expect(readMp4AudioTrackTimescale(bytes)).toBeUndefined();
    expect(readMp4AudioFragmentedDurationTicks(bytes)).toBeUndefined();
    // The video track's own fragmented duration is unaffected.
    const videoTrackTimescale = readMp4TrackTimescale(bytes);
    expect(readMp4FragmentedDurationTicks(bytes)).toBe(
      expectedMp4DurationTicks(durationInFrames, fps, videoTrackTimescale),
    );
  });
});
