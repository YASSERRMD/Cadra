/**
 * A minimal, standards-conforming ISO BMFF (MP4) box parser, just deep
 * enough to read back the two numbers this phase's acceptance criteria care
 * about: the movie-level timescale and duration stored in the `moov.mvhd`
 * box. Deliberately not a general-purpose MP4 parser (no sample tables, no
 * codec configuration records): its only job is to let a test assert that
 * what a real player would read back as "this file's duration and fps"
 * matches what was fed into the muxer, without needing a real player
 * available in this sandboxed environment (this phase's spec calls for
 * exactly this kind of container-level validator).
 *
 * Box layout follows ISO/IEC 14496-12 section 4.2 exactly (not anything
 * mp4-muxer-specific): `size(u32 BE) + type(4 ascii bytes) + payload`,
 * where `size === 1` means an 8-byte "largesize" `u64 BE` immediately
 * follows `type` instead, and `size === 0` means "this box extends to the
 * end of the file/its parent" (used for the final top-level `mdat` box on
 * an unfragmented file, so this parser must handle it rather than assume
 * every box declares a real size). A "full box" (`mvhd` included)
 * additionally prefixes its own payload with `version(u8) + flags(u24 BE)`
 * ahead of the version-specific fields this parser reads.
 */

/** Movie-level timing metadata read back out of an MP4's `moov.mvhd` box. */
export interface Mp4MovieHeader {
  /** `mvhd`'s `timescale` field: ticks per second every duration in this box is expressed in. */
  timescale: number;
  /** `mvhd`'s `duration` field, in `timescale` ticks. */
  durationTicks: number;
}

/** Thrown when `readMp4MovieHeader` cannot find a `moov.mvhd` box, or the bytes are not a well-formed box stream. */
export class Mp4ParseError extends Error {
  constructor(message: string) {
    super(`Mp4ParseError: ${message}`);
    this.name = "Mp4ParseError";
  }
}

/** One box's header, as `readBoxHeader` parses it: `type`, and the byte offsets of its payload. */
interface BoxHeader {
  type: string;
  /** Offset of this box's payload, i.e. immediately after `size`/`type`/optional largesize. */
  payloadStart: number;
  /** Offset immediately past this box's last byte (payload end). */
  boxEnd: number;
}

const BOX_HEADER_MIN_SIZE = 8;
const LARGESIZE_MARKER = 1;
const EXTENDS_TO_END_MARKER = 0;

function readAscii4(view: DataView, offset: number): string {
  let result = "";
  for (let i = 0; i < 4; i += 1) {
    result += String.fromCharCode(view.getUint8(offset + i));
  }
  return result;
}

/**
 * Reads one box's header at `offset` within `view`, which must have at
 * least `BOX_HEADER_MIN_SIZE` bytes remaining (the smallest possible box:
 * a 32-bit size plus a 4-byte type, with an empty payload).
 *
 * @throws {Mp4ParseError} if `offset` does not have enough bytes remaining
 *   for even a minimal box header, or a `size === 0` "extends to end of
 *   file" box appears anywhere but the outermost level (`containerEnd`
 *   equal to `view.byteLength`), where "end" is unambiguous.
 */
function readBoxHeader(view: DataView, offset: number, containerEnd: number): BoxHeader {
  if (offset + BOX_HEADER_MIN_SIZE > containerEnd) {
    throw new Mp4ParseError(
      `truncated box header at offset ${offset}: fewer than ${BOX_HEADER_MIN_SIZE} bytes remain`,
    );
  }

  const declaredSize = view.getUint32(offset, false);
  const type = readAscii4(view, offset + 4);

  if (declaredSize === LARGESIZE_MARKER) {
    if (offset + 16 > containerEnd) {
      throw new Mp4ParseError(`truncated largesize box header at offset ${offset}`);
    }
    // Largesize is a full 64-bit big-endian integer; boxes this parser
    // reads (moov/mvhd/trak/mdia/mdhd) are always small metadata boxes far
    // under 2^53 bytes, so combining the two 32-bit halves as
    // `high * 2**32 + low` loses no precision in the range this parser
    // ever encounters, unlike a real largesize box's typical use case
    // (a multi-gigabyte mdat), which this parser never descends into.
    const high = view.getUint32(offset + 8, false);
    const low = view.getUint32(offset + 12, false);
    const size = high * 2 ** 32 + low;
    return { type, payloadStart: offset + 16, boxEnd: offset + size };
  }

  if (declaredSize === EXTENDS_TO_END_MARKER) {
    if (containerEnd !== view.byteLength) {
      throw new Mp4ParseError(
        `box "${type}" at offset ${offset} declares size 0 ("extends to end of file") while nested inside another box; only valid at the top level`,
      );
    }
    return { type, payloadStart: offset + 8, boxEnd: containerEnd };
  }

  return { type, payloadStart: offset + 8, boxEnd: offset + declaredSize };
}

/**
 * Scans the direct children of the box/file region `[start, end)` in
 * `view`, returning the first child whose type matches `type`, or
 * `undefined` if none does. Does not recurse: callers walk one level of
 * nesting at a time (`moov` then `mvhd` inside it), matching how ISO BMFF's
 * box tree is meant to be traversed (a box's type alone does not say
 * whether its payload is itself a sequence of child boxes or raw data, so a
 * generic recursive-descent-into-everything walker would need a
 * box-type-to-"is this a container" table this parser has no need for).
 */
function findChildBox(
  view: DataView,
  start: number,
  end: number,
  type: string,
): BoxHeader | undefined {
  let offset = start;
  while (offset < end) {
    const header = readBoxHeader(view, offset, end);
    if (header.type === type) {
      return header;
    }
    offset = header.boxEnd;
  }
  return undefined;
}

/**
 * Parses `bytes` (a full MP4 file, as produced by `muxToMp4Buffer`/
 * `muxToMp4Blob`) just far enough to read back `moov.mvhd`'s `timescale`
 * and `duration` fields.
 *
 * `mvhd` is a "full box": its payload starts with `version(u8)` (0 or 1,
 * selecting whether creation/modification/duration fields below are 32-bit
 * or 64-bit) and `flags(u24)`, then:
 * version 0: creationTime(u32) + modificationTime(u32) + timescale(u32) +
 *            duration(u32) + ...
 * version 1: creationTime(u64) + modificationTime(u64) + timescale(u32) +
 *            duration(u64) + ...
 * `timescale` is always a plain `u32` in both versions (only the time
 * fields around it widen), per ISO/IEC 14496-12 section 8.2.2.
 *
 * @throws {Mp4ParseError} if `bytes` is not well-formed, or has no
 *   `moov.mvhd` box.
 */
export function readMp4MovieHeader(bytes: ArrayBuffer | Uint8Array): Mp4MovieHeader {
  const view =
    bytes instanceof Uint8Array
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new DataView(bytes);

  const moov = findChildBox(view, 0, view.byteLength, "moov");
  if (moov === undefined) {
    throw new Mp4ParseError('no top-level "moov" box found');
  }

  const mvhd = findChildBox(view, moov.payloadStart, moov.boxEnd, "mvhd");
  if (mvhd === undefined) {
    throw new Mp4ParseError('no "mvhd" box found inside "moov"');
  }

  const version = view.getUint8(mvhd.payloadStart);
  const isVersion1 = version === 1;
  const timeFieldSize = isVersion1 ? 8 : 4;
  // Skip: version(1) + flags(3) + creationTime(timeFieldSize) + modificationTime(timeFieldSize).
  const timescaleOffset = mvhd.payloadStart + 4 + timeFieldSize * 2;
  const durationOffset = timescaleOffset + 4;

  const timescale = view.getUint32(timescaleOffset, false);
  const durationTicks = isVersion1
    ? // Same high/low-combining rationale as readBoxHeader's largesize case:
      // an mvhd duration in the range this codebase's compositions ever
      // reach (at most a few hours at a few thousand ticks/sec) never
      // approaches 2^53, so no precision is lost.
      view.getUint32(durationOffset, false) * 2 ** 32 + view.getUint32(durationOffset + 4, false)
    : view.getUint32(durationOffset, false);

  return { timescale, durationTicks };
}
