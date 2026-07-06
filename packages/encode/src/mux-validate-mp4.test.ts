import { describe, expect, it } from "vitest";

import {
  Mp4ParseError,
  readMp4AudioTrackTimescale,
  readMp4MovieHeader,
  readMp4TrackTimescale,
} from "./mux-validate-mp4.js";

/** Writes a 4-byte big-endian ASCII box type at `offset` into `bytes`. */
function writeAscii4(bytes: Uint8Array, offset: number, type: string): void {
  for (let i = 0; i < 4; i += 1) {
    bytes[offset + i] = type.charCodeAt(i);
  }
}

/**
 * Builds a minimal, hand-constructed ISO BMFF box tree for unit-testing
 * `mux-validate-mp4.ts` directly against known byte layouts, independent of
 * whatever a real mp4-muxer version happens to emit (`mux-mp4.test.ts`
 * already covers the "real muxer output round-trips correctly" case; this
 * file's job is edge cases a real muxer never produces, like malformed or
 * unusual-but-spec-legal input).
 *
 * `version` selects between `mvhd`/`mdhd`'s 32-bit (0) and 64-bit (1) time
 * field encoding (see `readMp4MovieHeader`'s own doc for the two layouts);
 * `mux-mp4.test.ts`'s real-muxer-output tests only ever exercise version 0
 * (mp4-muxer only emits version 1 once a creation time or duration exceeds
 * 32 bits, which no test composition here reaches), so version 1 is only
 * covered here, via this hand-built fixture.
 *
 * When `trackTimescale` is given, the constructed `trak` also carries a
 * minimal `mdia.hdlr` box (`componentSubtype` defaulting to `"vide"` via
 * `handlerType`): every real MP4 (muxer-produced or otherwise) has one, and
 * `readMp4TrackTimescale`/`readMp4AudioTrackTimescale` disambiguate `trak`s
 * by this handler type (see `mux-validate-mp4.ts`'s own doc), so this
 * fixture must include it to stay representative of a real file's shape.
 */
function buildMinimalMp4(options: {
  version: 0 | 1;
  timescale: number;
  durationTicks: number;
  trackTimescale?: number;
  handlerType?: "vide" | "soun";
}): ArrayBuffer {
  const timeFieldSize = options.version === 1 ? 8 : 4;
  // mvhd payload: version(1) + flags(3) + creationTime + modificationTime + timescale(4) + duration.
  const mvhdPayloadSize = 4 + timeFieldSize * 2 + 4 + timeFieldSize;
  const mvhdSize = 8 + mvhdPayloadSize;

  const hasTrak = options.trackTimescale !== undefined;
  const handlerType = options.handlerType ?? "vide";
  // hdlr payload: version(1) + flags(3) + componentType(4, "mhlr") + componentSubtype(4) + manufacturer(4) + flags(4) + flagsMask(4) + name(1, empty null-terminated string).
  const hdlrPayloadSize = 4 + 4 + 4 + 4 + 4 + 4 + 1;
  const hdlrSize = hasTrak ? 8 + hdlrPayloadSize : 0;
  const mdhdPayloadSize = hasTrak ? 4 + timeFieldSize * 2 + 4 : 0;
  const mdhdSize = hasTrak ? 8 + mdhdPayloadSize : 0;
  const mdiaSize = hasTrak ? 8 + mdhdSize + hdlrSize : 0;
  const trakSize = hasTrak ? 8 + mdiaSize : 0;

  const moovPayloadSize = mvhdSize + trakSize;
  const moovSize = 8 + moovPayloadSize;

  const buffer = new ArrayBuffer(moovSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  let offset = 0;
  view.setUint32(offset, moovSize, false);
  writeAscii4(bytes, offset + 4, "moov");
  offset += 8;

  const mvhdStart = offset;
  view.setUint32(mvhdStart, mvhdSize, false);
  writeAscii4(bytes, mvhdStart + 4, "mvhd");
  let mvhdField = mvhdStart + 8;
  view.setUint8(mvhdField, options.version); // version
  view.setUint8(mvhdField + 1, 0); // flags byte 1
  view.setUint8(mvhdField + 2, 0); // flags byte 2
  view.setUint8(mvhdField + 3, 0); // flags byte 3
  mvhdField += 4;
  mvhdField += timeFieldSize; // creationTime, left as 0
  mvhdField += timeFieldSize; // modificationTime, left as 0
  view.setUint32(mvhdField, options.timescale, false);
  mvhdField += 4;
  if (options.version === 1) {
    // durationTicks fits comfortably in the low 32 bits for every test
    // fixture this file builds, so the high word is always 0.
    view.setUint32(mvhdField, 0, false);
    view.setUint32(mvhdField + 4, options.durationTicks, false);
  } else {
    view.setUint32(mvhdField, options.durationTicks, false);
  }
  offset += mvhdSize;

  if (hasTrak) {
    const trakStart = offset;
    view.setUint32(trakStart, trakSize, false);
    writeAscii4(bytes, trakStart + 4, "trak");

    const mdiaStart = trakStart + 8;
    view.setUint32(mdiaStart, mdiaSize, false);
    writeAscii4(bytes, mdiaStart + 4, "mdia");

    const mdhdStart = mdiaStart + 8;
    view.setUint32(mdhdStart, mdhdSize, false);
    writeAscii4(bytes, mdhdStart + 4, "mdhd");
    let mdhdField = mdhdStart + 8;
    view.setUint8(mdhdField, options.version);
    view.setUint8(mdhdField + 1, 0);
    view.setUint8(mdhdField + 2, 0);
    view.setUint8(mdhdField + 3, 0);
    mdhdField += 4;
    mdhdField += timeFieldSize;
    mdhdField += timeFieldSize;

    view.setUint32(mdhdField, options.trackTimescale!, false);

    const hdlrStart = mdhdStart + mdhdSize;
    view.setUint32(hdlrStart, hdlrSize, false);
    writeAscii4(bytes, hdlrStart + 4, "hdlr");
    let hdlrField = hdlrStart + 8;
    view.setUint8(hdlrField, 0); // version
    view.setUint8(hdlrField + 1, 0); // flags byte 1
    view.setUint8(hdlrField + 2, 0); // flags byte 2
    view.setUint8(hdlrField + 3, 0); // flags byte 3
    hdlrField += 4;
    writeAscii4(bytes, hdlrField, "mhlr"); // componentType
    hdlrField += 4;
    writeAscii4(bytes, hdlrField, handlerType); // componentSubtype
    // Remaining fields (manufacturer/flags/flagsMask/name) left as 0.

    offset += trakSize;
  }

  return buffer;
}

describe("readMp4MovieHeader", () => {
  it("reads timescale and durationTicks from a version-0 (32-bit) mvhd box", () => {
    const buffer = buildMinimalMp4({ version: 0, timescale: 1000, durationTicks: 3000 });
    expect(readMp4MovieHeader(buffer)).toEqual({ timescale: 1000, durationTicks: 3000 });
  });

  it("reads timescale and durationTicks from a version-1 (64-bit time fields) mvhd box", () => {
    const buffer = buildMinimalMp4({ version: 1, timescale: 90000, durationTicks: 270000 });
    expect(readMp4MovieHeader(buffer)).toEqual({ timescale: 90000, durationTicks: 270000 });
  });

  it("accepts a Uint8Array with a non-zero byteOffset (a view into a larger buffer)", () => {
    const inner = buildMinimalMp4({ version: 0, timescale: 1000, durationTicks: 3000 });
    const padded = new Uint8Array(inner.byteLength + 16);
    padded.set(new Uint8Array(inner), 16);
    const view = new Uint8Array(padded.buffer, 16, inner.byteLength);
    expect(readMp4MovieHeader(view)).toEqual({ timescale: 1000, durationTicks: 3000 });
  });

  it("throws Mp4ParseError when there is no top-level moov box", () => {
    const bytes = new Uint8Array(16);
    writeAscii4(bytes, 4, "free");
    new DataView(bytes.buffer).setUint32(0, 16, false);
    expect(() => readMp4MovieHeader(bytes.buffer)).toThrow(Mp4ParseError);
    expect(() => readMp4MovieHeader(bytes.buffer)).toThrow(/no top-level "moov" box/);
  });

  it("throws Mp4ParseError when moov has no mvhd box inside it", () => {
    const bytes = new Uint8Array(8);
    writeAscii4(bytes, 4, "moov");
    new DataView(bytes.buffer).setUint32(0, 8, false);
    expect(() => readMp4MovieHeader(bytes.buffer)).toThrow(/no "mvhd" box/);
  });

  it("throws Mp4ParseError on a truncated box header (fewer than 8 bytes)", () => {
    const bytes = new Uint8Array(4);
    expect(() => readMp4MovieHeader(bytes.buffer)).toThrow(Mp4ParseError);
    expect(() => readMp4MovieHeader(bytes.buffer)).toThrow(/truncated box header/);
  });

  it("throws Mp4ParseError for a size-0 box nested inside another box (only valid at the top level)", () => {
    // A 16-byte "moov" box (declaring its own size correctly) containing a
    // nested "free" box that claims size 0 ("extends to end of file"); one
    // trailing byte after moov's declared end makes the file's total length
    // (17) genuinely larger than moov's own boxEnd (16), so this size-0
    // box's containerEnd (16, moov's boxEnd) provably differs from the real
    // file end (17), the actual condition readBoxHeader checks. Without
    // that trailing byte, a moov box sized to exactly fill the buffer would
    // make containerEnd equal view.byteLength by coincidence, masking the
    // distinction this test means to exercise.
    const bytes = new Uint8Array(17);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 16, false);
    writeAscii4(bytes, 4, "moov");
    view.setUint32(8, 0, false); // size 0, "extends to end of file"
    writeAscii4(bytes, 12, "free");
    expect(() => readMp4MovieHeader(bytes.buffer)).toThrow(/declares size 0/);
  });
});

describe("readMp4TrackTimescale", () => {
  it("reads the track-level mdhd.timescale, distinct from mvhd's movie-level timescale", () => {
    const buffer = buildMinimalMp4({
      version: 0,
      timescale: 1000,
      durationTicks: 3000,
      trackTimescale: 30000,
    });
    expect(readMp4TrackTimescale(buffer)).toBe(30000);
  });

  it("reads a version-1 mdhd's timescale the same way as version-0", () => {
    const buffer = buildMinimalMp4({
      version: 1,
      timescale: 1000,
      durationTicks: 3000,
      trackTimescale: 60000,
    });
    expect(readMp4TrackTimescale(buffer)).toBe(60000);
  });

  it("throws Mp4ParseError when moov has no trak box at all", () => {
    const buffer = buildMinimalMp4({ version: 0, timescale: 1000, durationTicks: 3000 });
    expect(() => readMp4TrackTimescale(buffer)).toThrow(/no video "trak"/);
  });

  it("throws Mp4ParseError when moov has a trak but it is not the video handler type", () => {
    const buffer = buildMinimalMp4({
      version: 0,
      timescale: 1000,
      durationTicks: 3000,
      trackTimescale: 48000,
      handlerType: "soun",
    });
    expect(() => readMp4TrackTimescale(buffer)).toThrow(/no video "trak"/);
  });
});

describe("readMp4AudioTrackTimescale", () => {
  it("reads the audio track's mdhd.timescale when its hdlr componentSubtype is soun", () => {
    const buffer = buildMinimalMp4({
      version: 0,
      timescale: 1000,
      durationTicks: 3000,
      trackTimescale: 48000,
      handlerType: "soun",
    });
    expect(readMp4AudioTrackTimescale(buffer)).toBe(48000);
  });

  it("returns undefined when the only trak is a video track (no audio track present)", () => {
    const buffer = buildMinimalMp4({
      version: 0,
      timescale: 1000,
      durationTicks: 3000,
      trackTimescale: 30000,
      handlerType: "vide",
    });
    expect(readMp4AudioTrackTimescale(buffer)).toBeUndefined();
  });

  it("returns undefined (not a throw) when moov has no trak box at all", () => {
    const buffer = buildMinimalMp4({ version: 0, timescale: 1000, durationTicks: 3000 });
    expect(readMp4AudioTrackTimescale(buffer)).toBeUndefined();
  });
});
