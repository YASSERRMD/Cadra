import { describe, expect, it } from "vitest";

import { readWebmSegmentInfo, WebmParseError } from "./mux-validate-webm.js";

/**
 * Encodes `value` as a Matroska/EBML size VINT of exactly `widthBytes`
 * bytes (marker bit set at the appropriate leading position, remaining
 * bits holding `value`), the same "leading 1 bit position determines
 * width" convention `mux-validate-webm.ts`'s own `decodeVint` decodes (see
 * its doc). Only ever called with a `widthBytes` large enough to hold
 * `value` in this test file's fixtures.
 */
function encodeSizeVint(value: number, widthBytes: 1 | 2 | 3 | 4): Uint8Array {
  const bytes = new Uint8Array(widthBytes);
  let remaining = value;
  for (let i = widthBytes - 1; i >= 0; i -= 1) {
    bytes[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  const markerBit = 0x80 >> (widthBytes - 1);
  bytes[0] = (bytes[0] ?? 0) | markerBit;
  return bytes;
}

/** Encodes `id` (an already-marker-bit-included raw ID value, e.g. `0x4489`) as its big-endian byte sequence. */
function encodeElementId(id: number, widthBytes: 1 | 2 | 3 | 4): Uint8Array {
  const bytes = new Uint8Array(widthBytes);
  let remaining = id;
  for (let i = widthBytes - 1; i >= 0; i -= 1) {
    bytes[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return bytes;
}

/** Concatenates every `Uint8Array` in `parts` into one buffer. */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}

/** Builds one EBML element: `id` bytes + a declared-size VINT (`sizeWidthBytes` wide) + `payload`. */
function buildElement(
  id: Uint8Array,
  payload: Uint8Array,
  sizeWidthBytes: 1 | 2 | 3 | 4 = 1,
): Uint8Array {
  return concatBytes([id, encodeSizeVint(payload.byteLength, sizeWidthBytes), payload]);
}

/** A 4-byte big-endian unsigned integer payload, Matroska's encoding for a small uint element like TimestampScale. */
function uintPayload(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

/** An 8-byte IEEE754 big-endian double payload, matching EBMLFloat64's encoding for Duration. */
function float64Payload(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return bytes;
}

const SEGMENT_ID = encodeElementId(0x18538067, 4);
const INFO_ID = encodeElementId(0x1549a966, 4);
const TIMESTAMP_SCALE_ID = encodeElementId(0x2ad7b1, 3);
const DURATION_ID = encodeElementId(0x4489, 2);

/** Builds a minimal `Segment > Info > [TimestampScale?, Duration?]` EBML file. */
function buildMinimalWebm(options: { timestampScale?: number; duration?: number }): Uint8Array {
  const infoChildren: Uint8Array[] = [];
  if (options.timestampScale !== undefined) {
    infoChildren.push(buildElement(TIMESTAMP_SCALE_ID, uintPayload(options.timestampScale)));
  }
  if (options.duration !== undefined) {
    infoChildren.push(buildElement(DURATION_ID, float64Payload(options.duration), 1));
  }
  const infoPayload = concatBytes(infoChildren);
  const info = buildElement(INFO_ID, infoPayload, 2);
  const segment = buildElement(SEGMENT_ID, info, 4);
  return segment;
}

describe("readWebmSegmentInfo", () => {
  it("reads an explicit TimestampScale and Duration", () => {
    const bytes = buildMinimalWebm({ timestampScale: 1_000_000, duration: 3000 });
    expect(readWebmSegmentInfo(bytes)).toEqual({ timestampScale: 1_000_000, duration: 3000 });
  });

  it("reads a non-default TimestampScale (e.g. one nanosecond-per-tick)", () => {
    const bytes = buildMinimalWebm({ timestampScale: 1, duration: 42 });
    expect(readWebmSegmentInfo(bytes)).toEqual({ timestampScale: 1, duration: 42 });
  });

  it("defaults TimestampScale to 1,000,000 when the element is omitted, per the Matroska spec", () => {
    const bytes = buildMinimalWebm({ duration: 3000 });
    expect(readWebmSegmentInfo(bytes)).toEqual({ timestampScale: 1_000_000, duration: 3000 });
  });

  it("reports duration: undefined when the Duration element is absent (streaming: true's documented behavior)", () => {
    const bytes = buildMinimalWebm({ timestampScale: 1_000_000 });
    expect(readWebmSegmentInfo(bytes)).toEqual({ timestampScale: 1_000_000, duration: undefined });
  });

  it("accepts a Uint8Array with a non-zero byteOffset (a view into a larger buffer)", () => {
    const inner = buildMinimalWebm({ timestampScale: 1_000_000, duration: 3000 });
    const padded = new Uint8Array(inner.byteLength + 16);
    padded.set(inner, 16);
    const view = new Uint8Array(padded.buffer, 16, inner.byteLength);
    expect(readWebmSegmentInfo(view)).toEqual({ timestampScale: 1_000_000, duration: 3000 });
  });

  it("finds Info even when Segment itself declares unknown size (streaming: true's Segment header)", () => {
    const infoPayload = concatBytes([buildElement(TIMESTAMP_SCALE_ID, uintPayload(1_000_000))]);
    const info = buildElement(INFO_ID, infoPayload, 2);
    // A 1-byte unknown-size marker (0xFF: every content bit set) in place
    // of Segment's usual declared size, matching webm-muxer's own
    // streaming: true Segment header (see mux-validate-webm.ts's top-level
    // doc for why this parser must specifically handle it).
    const unknownSizeSegment = concatBytes([SEGMENT_ID, Uint8Array.of(0xff), info]);
    expect(readWebmSegmentInfo(unknownSizeSegment)).toEqual({
      timestampScale: 1_000_000,
      duration: undefined,
    });
  });

  it("throws WebmParseError when there is no top-level Segment element", () => {
    const bytes = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x80); // Unrelated EBML header element ID, empty payload.
    expect(() => readWebmSegmentInfo(bytes)).toThrow(WebmParseError);
    expect(() => readWebmSegmentInfo(bytes)).toThrow(/no top-level "Segment" element/);
  });

  it("throws WebmParseError when Segment has no Info element inside it", () => {
    const emptySegment = buildElement(SEGMENT_ID, new Uint8Array(0), 4);
    expect(() => readWebmSegmentInfo(emptySegment)).toThrow(/no "Info" element/);
  });

  it("throws WebmParseError on a truncated VINT (declares a width wider than the remaining bytes)", () => {
    // 0x20 has its leading 1 bit in the third position, declaring a 3-byte
    // VINT, but only 1 byte is actually present.
    const bytes = Uint8Array.of(0x20);
    expect(() => readWebmSegmentInfo(bytes)).toThrow(/truncated VINT/);
  });

  it("throws WebmParseError when a Duration element's payload is not exactly 8 bytes", () => {
    const infoPayload = buildElement(DURATION_ID, uintPayload(3000), 1); // 4-byte payload, not 8.
    const info = buildElement(INFO_ID, infoPayload, 2);
    const segment = buildElement(SEGMENT_ID, info, 4);
    expect(() => readWebmSegmentInfo(segment)).toThrow(/expected an 8-byte float payload/);
  });
});
