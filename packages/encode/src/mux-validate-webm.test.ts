import { describe, expect, it } from "vitest";

import {
  readWebmSegmentInfo,
  readWebmTrackLastBlockEndTimestamp,
  WebmParseError,
} from "./mux-validate-webm.js";

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

const TRACKS_ID = encodeElementId(0x1654ae6b, 4);
const TRACK_ENTRY_ID = encodeElementId(0xae, 1);
const TRACK_NUMBER_ID = encodeElementId(0xd7, 1);
const TRACK_TYPE_ID = encodeElementId(0x83, 1);
const CLUSTER_ID = encodeElementId(0x1f43b675, 4);
const CLUSTER_TIMESTAMP_ID = encodeElementId(0xe7, 1);
const BLOCK_GROUP_ID = encodeElementId(0xa0, 1);
const BLOCK_ID = encodeElementId(0xa1, 1);
const BLOCK_DURATION_ID = encodeElementId(0x9b, 1);

/** A 1-byte big-endian unsigned integer payload, Matroska's smallest uint encoding (e.g. for TrackNumber/TrackType). */
function uint8Payload(value: number): Uint8Array {
  return Uint8Array.of(value);
}

/**
 * Builds one `TrackEntry`'s payload: `TrackNumber` + `TrackType` (Matroska
 * value `1` for video, `2` for audio, matching webm-muxer's own fixed
 * `VIDEO_TRACK_TYPE`/`AUDIO_TRACK_TYPE`), enough for
 * `findWebmTrackNumberByType`'s own lookup.
 */
function buildTrackEntry(trackNumber: number, trackType: 1 | 2): Uint8Array {
  return buildElement(
    TRACK_ENTRY_ID,
    concatBytes([
      buildElement(TRACK_NUMBER_ID, uint8Payload(trackNumber)),
      buildElement(TRACK_TYPE_ID, uint8Payload(trackType)),
    ]),
  );
}

/**
 * Builds one `Block`/`SimpleBlock`-shaped binary prelude: a 1-byte VINT
 * track number (`0x80 | trackNumber`, valid only for track numbers 1-127,
 * every track number this test file or webm-muxer itself ever uses), a
 * signed 16-bit big-endian timestamp relative to the enclosing `Cluster`'s
 * own base `Timestamp`, and a single flags byte (left as 0, unused by
 * `readWebmTrackLastBlockEndTimestamp`), followed by `payload` (arbitrary
 * placeholder sample bytes).
 */
function buildBlockPrelude(
  trackNumber: number,
  relativeTimestamp: number,
  payload: Uint8Array = Uint8Array.of(0xff),
): Uint8Array {
  const prelude = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(prelude.buffer);
  view.setUint8(0, 0x80 | trackNumber);
  view.setInt16(1, relativeTimestamp, false);
  view.setUint8(3, 0); // flags
  prelude.set(payload, 4);
  return prelude;
}

/**
 * Builds one `Cluster`'s payload: its own base `Timestamp`, plus one
 * `BlockGroup` (`Block` + `BlockDuration`) per entry in `blocks`.
 */
function buildCluster(
  clusterTimestamp: number,
  blocks: ReadonlyArray<{ trackNumber: number; relativeTimestamp: number; durationTicks: number }>,
): Uint8Array {
  const children: Uint8Array[] = [
    buildElement(CLUSTER_TIMESTAMP_ID, uintPayload(clusterTimestamp)),
  ];
  for (const block of blocks) {
    const blockPayload = buildBlockPrelude(block.trackNumber, block.relativeTimestamp);
    const blockGroupPayload = concatBytes([
      buildElement(BLOCK_ID, blockPayload, 2),
      buildElement(BLOCK_DURATION_ID, uintPayload(block.durationTicks), 1),
    ]);
    children.push(buildElement(BLOCK_GROUP_ID, blockGroupPayload, 2));
  }
  return concatBytes(children);
}

/**
 * Builds a minimal `Segment > [Tracks, Info, Cluster...]` EBML file: one
 * `TrackEntry` per entry in `tracks`, one `Cluster` per entry in
 * `clusters`, and a fixed `Info` carrying only `TimestampScale` (this
 * fixture builder's own tests do not exercise `Duration` itself; see
 * `buildMinimalWebm` above for that).
 */
function buildWebmWithTracksAndClusters(options: {
  tracks: ReadonlyArray<{ trackNumber: number; trackType: 1 | 2 }>;
  clusters: ReadonlyArray<Uint8Array>;
}): Uint8Array {
  const tracksPayload = concatBytes(
    options.tracks.map((track) => buildTrackEntry(track.trackNumber, track.trackType)),
  );
  const tracks = buildElement(TRACKS_ID, tracksPayload, 2);

  const infoPayload = buildElement(TIMESTAMP_SCALE_ID, uintPayload(1_000_000));
  const info = buildElement(INFO_ID, infoPayload, 2);

  const clusterElements = options.clusters.map((clusterPayload) =>
    buildElement(CLUSTER_ID, clusterPayload, 4),
  );

  const segmentPayload = concatBytes([tracks, info, ...clusterElements]);
  return buildElement(SEGMENT_ID, segmentPayload, 4);
}

describe("readWebmTrackLastBlockEndTimestamp", () => {
  it("finds the video track's last block end timestamp (clusterTimestamp + relativeTimestamp + blockDuration)", () => {
    const cluster = buildCluster(0, [{ trackNumber: 1, relativeTimestamp: 100, durationTicks: 33 }]);
    const bytes = buildWebmWithTracksAndClusters({
      tracks: [{ trackNumber: 1, trackType: 1 }],
      clusters: [cluster],
    });

    expect(readWebmTrackLastBlockEndTimestamp(bytes, "video")).toBe(100 + 33);
  });

  it("finds the audio track's own last block end timestamp, independent of the video track's", () => {
    const cluster = buildCluster(0, [
      { trackNumber: 1, relativeTimestamp: 0, durationTicks: 33 },
      { trackNumber: 2, relativeTimestamp: 0, durationTicks: 20 },
    ]);
    const bytes = buildWebmWithTracksAndClusters({
      tracks: [
        { trackNumber: 1, trackType: 1 },
        { trackNumber: 2, trackType: 2 },
      ],
      clusters: [cluster],
    });

    expect(readWebmTrackLastBlockEndTimestamp(bytes, "video")).toBe(33);
    expect(readWebmTrackLastBlockEndTimestamp(bytes, "audio")).toBe(20);
  });

  it("takes the maximum end timestamp across multiple clusters/blocks for the same track", () => {
    const clusterA = buildCluster(0, [{ trackNumber: 1, relativeTimestamp: 0, durationTicks: 33 }]);
    const clusterB = buildCluster(1000, [
      { trackNumber: 1, relativeTimestamp: 0, durationTicks: 33 },
    ]);
    const bytes = buildWebmWithTracksAndClusters({
      tracks: [{ trackNumber: 1, trackType: 1 }],
      clusters: [clusterA, clusterB],
    });

    // Cluster B's block ends at 1000 + 0 + 33 = 1033, later than cluster A's
    // 0 + 0 + 33 = 33.
    expect(readWebmTrackLastBlockEndTimestamp(bytes, "video")).toBe(1033);
  });

  it("adds the cluster's own base timestamp to each block's relative timestamp", () => {
    const cluster = buildCluster(5000, [
      { trackNumber: 1, relativeTimestamp: 250, durationTicks: 33 },
    ]);
    const bytes = buildWebmWithTracksAndClusters({
      tracks: [{ trackNumber: 1, trackType: 1 }],
      clusters: [cluster],
    });

    expect(readWebmTrackLastBlockEndTimestamp(bytes, "video")).toBe(5000 + 250 + 33);
  });

  it("returns undefined when no track of the requested type exists (a video-only file has no audio track)", () => {
    const cluster = buildCluster(0, [{ trackNumber: 1, relativeTimestamp: 0, durationTicks: 33 }]);
    const bytes = buildWebmWithTracksAndClusters({
      tracks: [{ trackNumber: 1, trackType: 1 }],
      clusters: [cluster],
    });

    expect(readWebmTrackLastBlockEndTimestamp(bytes, "audio")).toBeUndefined();
  });

  it("throws WebmParseError when Segment has no Tracks element", () => {
    const info = buildElement(INFO_ID, buildElement(TIMESTAMP_SCALE_ID, uintPayload(1_000_000)), 2);
    const segment = buildElement(SEGMENT_ID, info, 4);
    expect(() => readWebmTrackLastBlockEndTimestamp(segment, "video")).toThrow(/no "Tracks" element/);
  });

  it("throws WebmParseError when Segment has no Cluster element", () => {
    const tracksPayload = buildTrackEntry(1, 1);
    const tracks = buildElement(TRACKS_ID, tracksPayload, 2);
    const info = buildElement(INFO_ID, buildElement(TIMESTAMP_SCALE_ID, uintPayload(1_000_000)), 2);
    const segment = buildElement(SEGMENT_ID, concatBytes([tracks, info]), 4);
    expect(() => readWebmTrackLastBlockEndTimestamp(segment, "video")).toThrow(/no "Cluster" element/);
  });
});
