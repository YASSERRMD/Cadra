import { describe, expect, it } from "vitest";

import type { EncodedChunkResult } from "./encode-frames.js";
import { extractRawChunkBytes, MissingChunkDurationError } from "./mux-chunk-bytes.js";
import {
  deserializeEncodedChunkResult,
  serializeEncodedChunk,
} from "./serialized-encoded-chunk.js";

/** A fake `EncodedVideoChunk`: identity-only fields plus a real `copyTo`, mirroring `mux-chunk-bytes.test.ts`'s own `createFakeChunk`. */
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
  } as unknown as EncodedVideoChunk;
}

/** Round-trips `value` through `JSON.stringify`/`JSON.parse`, simulating the plain-data guarantee a `page.evaluate` structured-clone boundary provides (stricter than structured-clone in some ways, e.g. no `undefined` survives, but a useful stand-in that catches anything not plain-data-safe: functions, class instances, etc.). */
function roundTripThroughJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("serializeEncodedChunk", () => {
  it("extracts frame/type/timestamp/duration/data exactly as extractRawChunkBytes would", () => {
    const data = Uint8Array.of(10, 20, 30, 40);
    const chunk = createFakeChunk({ data, type: "key", timestamp: 33_333, duration: 33_333 });
    const chunkResult: EncodedChunkResult = { frame: 5, chunk, metadata: undefined };

    const serialized = serializeEncodedChunk(chunkResult);

    expect(serialized.frame).toBe(5);
    expect(serialized.type).toBe("key");
    expect(serialized.timestamp).toBe(33_333);
    expect(serialized.duration).toBe(33_333);
    expect(serialized.data).toEqual([10, 20, 30, 40]);
  });

  it("omits codec/description when metadata carries no decoderConfig", () => {
    const chunk = createFakeChunk({
      data: Uint8Array.of(1),
      type: "delta",
      timestamp: 0,
      duration: 1,
    });
    const chunkResult: EncodedChunkResult = { frame: 0, chunk, metadata: undefined };

    const serialized = serializeEncodedChunk(chunkResult);

    expect(serialized.codec).toBeUndefined();
    expect(serialized.description).toBeUndefined();
  });

  it("flattens metadata.decoderConfig.codec and description into plain fields", () => {
    const chunk = createFakeChunk({
      data: Uint8Array.of(1),
      type: "key",
      timestamp: 0,
      duration: 1,
    });
    const description = Uint8Array.of(0x01, 0x64, 0x00, 0x1f).buffer;
    const chunkResult: EncodedChunkResult = {
      frame: 0,
      chunk,
      metadata: { decoderConfig: { codec: "avc1.42001f", description } },
    };

    const serialized = serializeEncodedChunk(chunkResult);

    expect(serialized.codec).toBe("avc1.42001f");
    expect(serialized.description).toEqual([0x01, 0x64, 0x00, 0x1f]);
  });

  it("handles a description supplied as a Uint8Array view (not a bare ArrayBuffer)", () => {
    const chunk = createFakeChunk({
      data: Uint8Array.of(1),
      type: "key",
      timestamp: 0,
      duration: 1,
    });
    const description = Uint8Array.of(0xaa, 0xbb, 0xcc);
    const chunkResult: EncodedChunkResult = {
      frame: 0,
      chunk,
      metadata: { decoderConfig: { codec: "vp09.00.10.08", description } },
    };

    const serialized = serializeEncodedChunk(chunkResult);

    expect(serialized.description).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it("handles a description that is a view over a larger, offset buffer (only the view's own bytes are read)", () => {
    const chunk = createFakeChunk({
      data: Uint8Array.of(1),
      type: "key",
      timestamp: 0,
      duration: 1,
    });
    const backing = Uint8Array.of(0xff, 0xff, 0x11, 0x22, 0x33, 0xff);
    const description = new Uint8Array(backing.buffer, 2, 3);
    const chunkResult: EncodedChunkResult = {
      frame: 0,
      chunk,
      metadata: { decoderConfig: { codec: "avc1.42001f", description } },
    };

    const serialized = serializeEncodedChunk(chunkResult);

    expect(serialized.description).toEqual([0x11, 0x22, 0x33]);
  });

  it("produces a value that survives a JSON round trip unchanged (a stand-in for the real structured-clone boundary)", () => {
    const chunk = createFakeChunk({
      data: Uint8Array.of(1, 2, 3),
      type: "key",
      timestamp: 0,
      duration: 1000,
    });
    const chunkResult: EncodedChunkResult = {
      frame: 3,
      chunk,
      metadata: {
        decoderConfig: { codec: "av01.0.08M.08", description: Uint8Array.of(9, 9).buffer },
      },
    };

    const serialized = serializeEncodedChunk(chunkResult);
    const roundTripped = roundTripThroughJson(serialized);

    expect(roundTripped).toEqual(serialized);
  });

  it("propagates MissingChunkDurationError for a null-duration chunk, matching extractRawChunkBytes", () => {
    const chunk = createFakeChunk({
      data: Uint8Array.of(1),
      type: "key",
      timestamp: 0,
      duration: null,
    });
    const chunkResult: EncodedChunkResult = { frame: 7, chunk, metadata: undefined };

    expect(() => serializeEncodedChunk(chunkResult)).toThrow(MissingChunkDurationError);
  });
});

describe("deserializeEncodedChunkResult", () => {
  it("reconstructs a chunk whose copyTo/byteLength/type/timestamp/duration match the original", () => {
    const data = Uint8Array.of(7, 8, 9);
    const original = createFakeChunk({ data, type: "delta", timestamp: 12_345, duration: 6789 });
    const chunkResult: EncodedChunkResult = { frame: 2, chunk: original, metadata: undefined };

    const serialized = serializeEncodedChunk(chunkResult);
    const reconstructed = deserializeEncodedChunkResult(serialized);

    expect(reconstructed.frame).toBe(2);
    expect(reconstructed.chunk.type).toBe("delta");
    expect(reconstructed.chunk.timestamp).toBe(12_345);
    expect(reconstructed.chunk.duration).toBe(6789);
    expect(reconstructed.chunk.byteLength).toBe(3);

    const destination = new Uint8Array(3);
    reconstructed.chunk.copyTo(destination);
    expect(destination).toEqual(data);
  });

  it("round-trips through extractRawChunkBytes identically to the original chunk", () => {
    const data = Uint8Array.of(100, 101, 102, 103);
    const original = createFakeChunk({ data, type: "key", timestamp: 0, duration: 33_333 });
    const chunkResult: EncodedChunkResult = { frame: 0, chunk: original, metadata: undefined };

    const serialized = serializeEncodedChunk(chunkResult);
    const reconstructed = deserializeEncodedChunkResult(serialized);
    const rawFromOriginal = extractRawChunkBytes(original, 0);
    const rawFromReconstructed = extractRawChunkBytes(reconstructed.chunk, 0);

    expect(rawFromReconstructed).toEqual(rawFromOriginal);
  });

  it("reconstructs metadata.decoderConfig.codec/description exactly when present", () => {
    const chunk = createFakeChunk({
      data: Uint8Array.of(1),
      type: "key",
      timestamp: 0,
      duration: 1,
    });
    const chunkResult: EncodedChunkResult = {
      frame: 0,
      chunk,
      metadata: {
        decoderConfig: { codec: "avc1.42001f", description: Uint8Array.of(1, 2, 3).buffer },
      },
    };

    const serialized = serializeEncodedChunk(chunkResult);
    const reconstructed = deserializeEncodedChunkResult(serialized);

    expect(reconstructed.metadata?.decoderConfig?.codec).toBe("avc1.42001f");
    expect(
      new Uint8Array(reconstructed.metadata?.decoderConfig?.description as ArrayBuffer),
    ).toEqual(Uint8Array.of(1, 2, 3));
  });

  it("reconstructs undefined metadata when no codec was present, never inventing an empty decoderConfig", () => {
    const chunk = createFakeChunk({
      data: Uint8Array.of(1),
      type: "delta",
      timestamp: 0,
      duration: 1,
    });
    const chunkResult: EncodedChunkResult = { frame: 0, chunk, metadata: undefined };

    const serialized = serializeEncodedChunk(chunkResult);
    const reconstructed = deserializeEncodedChunkResult(serialized);

    expect(reconstructed.metadata).toBeUndefined();
  });

  it("reconstructs metadata.decoderConfig with a codec but no description when description was absent", () => {
    const chunk = createFakeChunk({
      data: Uint8Array.of(1),
      type: "key",
      timestamp: 0,
      duration: 1,
    });
    const chunkResult: EncodedChunkResult = {
      frame: 0,
      chunk,
      metadata: { decoderConfig: { codec: "avc1.42001f" } },
    };

    const serialized = serializeEncodedChunk(chunkResult);
    const reconstructed = deserializeEncodedChunkResult(serialized);

    expect(reconstructed.metadata?.decoderConfig?.codec).toBe("avc1.42001f");
    expect(reconstructed.metadata?.decoderConfig?.description).toBeUndefined();
  });

  it("survives a full serialize -> JSON round trip -> deserialize chain, exactly matching a direct serialize -> deserialize", () => {
    const chunk = createFakeChunk({
      data: Uint8Array.of(4, 5, 6),
      type: "key",
      timestamp: 500,
      duration: 999,
    });
    const chunkResult: EncodedChunkResult = {
      frame: 9,
      chunk,
      metadata: {
        decoderConfig: { codec: "vp09.00.10.08", description: Uint8Array.of(42).buffer },
      },
    };

    const serialized = serializeEncodedChunk(chunkResult);
    const viaJson = deserializeEncodedChunkResult(roundTripThroughJson(serialized));
    const direct = deserializeEncodedChunkResult(serialized);

    expect(extractRawChunkBytes(viaJson.chunk, 9)).toEqual(extractRawChunkBytes(direct.chunk, 9));
    expect(viaJson.metadata).toEqual(direct.metadata);
  });
});
