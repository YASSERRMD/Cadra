import { describe, expect, it } from "vitest";

import { DEFAULT_CODEC_PREFERENCES } from "./codec-probe.js";
import type { EncodedChunkResult } from "./encode-frames.js";
import { UnsupportedMuxCodecError, Vp8NotSupportedInMp4Error } from "./mux-codec-mapping.js";
import { muxToMp4Blob, muxToMp4Buffer, muxToMp4Stream } from "./mux-mp4.js";
import type { NodeWritableLike } from "./mux-stream-target.js";
import { expectedMp4DurationTicks } from "./mux-timescale.js";
import {
  readMp4FragmentedDurationTicks,
  readMp4MovieHeader,
  readMp4TrackTimescale,
} from "./mux-validate-mp4.js";

const AV1_CODEC = DEFAULT_CODEC_PREFERENCES[0]!.codec;

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
