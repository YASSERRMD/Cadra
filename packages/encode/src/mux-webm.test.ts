import { describe, expect, it } from "vitest";

import { DEFAULT_CODEC_PREFERENCES } from "./codec-probe.js";
import type { EncodedChunkResult } from "./encode-frames.js";
import { UnsupportedMuxCodecError } from "./mux-codec-mapping.js";
import type { NodeWritableLike } from "./mux-stream-target.js";
import {
  expectedWebmDurationTicks,
  expectedWebmMuxerDurationTicksFromLastChunkTimestamp,
  WEBM_TIMESTAMP_SCALE_NANOSECONDS,
} from "./mux-timescale.js";
import { readWebmSegmentInfo } from "./mux-validate-webm.js";
import { muxToWebmBlob, muxToWebmBuffer, muxToWebmStream } from "./mux-webm.js";

const AV1_CODEC = DEFAULT_CODEC_PREFERENCES[0]!.codec;

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
