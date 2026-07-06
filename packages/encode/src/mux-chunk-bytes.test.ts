import { describe, expect, it } from "vitest";

import {
  extractRawAudioChunkBytes,
  extractRawChunkBytes,
  MissingAudioChunkDurationError,
  MissingChunkDurationError,
} from "./mux-chunk-bytes.js";

/** A fake `EncodedVideoChunk`: identity-only fields plus a real `copyTo`, enough to exercise `extractRawChunkBytes` without a real WebCodecs environment. */
function createFakeChunk(options: {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number | null;
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

describe("extractRawChunkBytes", () => {
  it("copies the chunk's bytes out via copyTo into a freshly allocated Uint8Array", () => {
    const data = Uint8Array.of(1, 2, 3, 4, 5);
    const chunk = createFakeChunk({ data, type: "key", timestamp: 0, duration: 33_333 });

    const raw = extractRawChunkBytes(chunk, 0);

    expect(raw.data).toEqual(data);
    // Freshly allocated, not merely returning the same reference: mutating
    // the source `data` afterward must not retroactively change `raw.data`.
    expect(raw.data).not.toBe(data);
  });

  it("passes through type, timestamp, and duration unchanged", () => {
    const chunk = createFakeChunk({
      data: Uint8Array.of(0xff),
      type: "delta",
      timestamp: 66_667,
      duration: 33_333,
    });

    const raw = extractRawChunkBytes(chunk, 2);

    expect(raw.type).toBe("delta");
    expect(raw.timestamp).toBe(66_667);
    expect(raw.duration).toBe(33_333);
  });

  it("does not mutate the source data if the caller later mutates the returned array", () => {
    const data = Uint8Array.of(9, 9, 9);
    const chunk = createFakeChunk({ data, type: "key", timestamp: 0, duration: 1 });

    const raw = extractRawChunkBytes(chunk, 0);
    raw.data[0] = 255;

    expect(data[0]).toBe(9);
  });

  it("throws MissingChunkDurationError when duration is null", () => {
    const chunk = createFakeChunk({
      data: Uint8Array.of(1),
      type: "key",
      timestamp: 0,
      duration: null,
    });

    expect(() => extractRawChunkBytes(chunk, 5)).toThrow(MissingChunkDurationError);
    expect(() => extractRawChunkBytes(chunk, 5)).toThrow(/frame 5/);
  });

  it("does not call copyTo when duration is null (fails before touching the chunk's bytes)", () => {
    let copyToCalled = false;
    const chunk = {
      byteLength: 1,
      type: "key",
      timestamp: 0,
      duration: null,
      copyTo: () => {
        copyToCalled = true;
      },
      // Cast rationale: same as this file's own createFakeChunk.
    } as unknown as EncodedVideoChunk;

    expect(() => extractRawChunkBytes(chunk, 0)).toThrow(MissingChunkDurationError);
    expect(copyToCalled).toBe(false);
  });
});

/** A fake `EncodedAudioChunk`: identity-only fields plus a real `copyTo`, the audio-side counterpart to this file's own `createFakeChunk`. */
function createFakeAudioChunk(options: {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number | null;
}): EncodedAudioChunk {
  return {
    byteLength: options.data.byteLength,
    type: options.type,
    timestamp: options.timestamp,
    duration: options.duration,
    copyTo: (destination: Uint8Array) => {
      destination.set(options.data);
    },
    // Cast rationale: same as this file's own createFakeChunk.
  } as unknown as EncodedAudioChunk;
}

describe("extractRawAudioChunkBytes", () => {
  it("copies the chunk's bytes out via copyTo into a freshly allocated Uint8Array", () => {
    const data = Uint8Array.of(10, 20, 30);
    const chunk = createFakeAudioChunk({ data, type: "key", timestamp: 0, duration: 21_333 });

    const raw = extractRawAudioChunkBytes(chunk, 0);

    expect(raw.data).toEqual(data);
    expect(raw.data).not.toBe(data);
  });

  it("passes through type, timestamp, and duration unchanged", () => {
    const chunk = createFakeAudioChunk({
      data: Uint8Array.of(0x11),
      type: "delta",
      timestamp: 42_666,
      duration: 21_333,
    });

    const raw = extractRawAudioChunkBytes(chunk, 3);

    expect(raw.type).toBe("delta");
    expect(raw.timestamp).toBe(42_666);
    expect(raw.duration).toBe(21_333);
  });

  it("does not mutate the source data if the caller later mutates the returned array", () => {
    const data = Uint8Array.of(7, 7, 7);
    const chunk = createFakeAudioChunk({ data, type: "key", timestamp: 0, duration: 1 });

    const raw = extractRawAudioChunkBytes(chunk, 0);
    raw.data[0] = 255;

    expect(data[0]).toBe(7);
  });

  it("throws MissingAudioChunkDurationError when duration is null", () => {
    const chunk = createFakeAudioChunk({
      data: Uint8Array.of(1),
      type: "key",
      timestamp: 0,
      duration: null,
    });

    expect(() => extractRawAudioChunkBytes(chunk, 5)).toThrow(MissingAudioChunkDurationError);
    expect(() => extractRawAudioChunkBytes(chunk, 5)).toThrow(/chunk 5/);
  });

  it("does not call copyTo when duration is null (fails before touching the chunk's bytes)", () => {
    let copyToCalled = false;
    const chunk = {
      byteLength: 1,
      type: "key",
      timestamp: 0,
      duration: null,
      copyTo: () => {
        copyToCalled = true;
      },
      // Cast rationale: same as this file's own createFakeAudioChunk.
    } as unknown as EncodedAudioChunk;

    expect(() => extractRawAudioChunkBytes(chunk, 0)).toThrow(MissingAudioChunkDurationError);
    expect(copyToCalled).toBe(false);
  });
});
