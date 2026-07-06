/**
 * A minimal, standards-conforming ISO BMFF (MP4) box parser, just deep
 * enough to read back the numbers this phase's acceptance criteria care
 * about: the movie-level timescale and duration stored in the `moov.mvhd`
 * box, plus (for a fragmented MP4, see `readMp4FragmentedDurationTicks`'s
 * own doc for why this is a second, separate function) the total duration
 * derived from every `moof.traf`'s `tfhd`/`trun` boxes. Deliberately not a
 * general-purpose MP4 parser (no sample tables, no codec configuration
 * records): its only job is to let a test assert that what a real player
 * would read back as "this file's duration and fps" matches what was fed
 * into the muxer, without needing a real player available in this
 * sandboxed environment (this phase's spec calls for exactly this kind of
 * container-level validator).
 *
 * Box layout follows ISO/IEC 14496-12 section 4.2 exactly (not anything
 * mp4-muxer-specific): `size(u32 BE) + type(4 ascii bytes) + payload`,
 * where `size === 1` means an 8-byte "largesize" `u64 BE` immediately
 * follows `type` instead, and `size === 0` means "this box extends to the
 * end of the file/its parent" (used for the final top-level `mdat` box on
 * an unfragmented file, so this parser must handle it rather than assume
 * every box declares a real size). A "full box" (`mvhd`/`tfhd`/`trun`
 * included) additionally prefixes its own payload with
 * `version(u8) + flags(u24 BE)` ahead of the version/flags-specific fields
 * this parser reads.
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

/** Coerces `bytes` (however a caller happened to receive them) to a `DataView` spanning exactly its bytes, not a copy. */
function toDataView(bytes: ArrayBuffer | Uint8Array): DataView {
  return bytes instanceof Uint8Array
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new DataView(bytes);
}

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
 * Same traversal as `findChildBox`, but collects every direct child
 * matching `type` instead of stopping at the first: needed for `moof`,
 * which (unlike `moov`/`mvhd`, always singular) appears once per fragment,
 * so a fragmented file has as many top-level `moof` boxes as fragments.
 */
function findAllChildBoxes(view: DataView, start: number, end: number, type: string): BoxHeader[] {
  const matches: BoxHeader[] = [];
  let offset = start;
  while (offset < end) {
    const header = readBoxHeader(view, offset, end);
    if (header.type === type) {
      matches.push(header);
    }
    offset = header.boxEnd;
  }
  return matches;
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
 * A fragmented MP4 (`muxToMp4Stream`'s `fastStart: 'fragmented'`; see its
 * own doc) legitimately reports `durationTicks: 0` here: its `moov` box is
 * written before any sample data (that is precisely what lets it avoid
 * seeking backward, the whole point of choosing it for a sequential-write
 * target), so the real total duration is not yet known at the point `moov`
 * is written, and lives in the per-fragment `moof.traf.tfhd`/`trun` boxes
 * instead. Use `readMp4FragmentedDurationTicks` for that file shape.
 *
 * @throws {Mp4ParseError} if `bytes` is not well-formed, or has no
 *   `moov.mvhd` box.
 */
export function readMp4MovieHeader(bytes: ArrayBuffer | Uint8Array): Mp4MovieHeader {
  const view = toDataView(bytes);

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

/**
 * A `moov.trak`'s media handler type, read from `mdia.hdlr`'s
 * `componentSubtype` field (`"vide"` for a video track, `"soun"` for an
 * audio track; per ISO/IEC 14496-12 section 8.4.3, and matching
 * mp4-muxer's own `hdlr` box construction, which writes exactly one of
 * these two 4-character codes). This is the standards-correct way to tell
 * a `trak`'s media type apart: a real player disambiguates tracks the same
 * way, rather than assuming a fixed array position.
 */
export type Mp4TrackHandlerType = "vide" | "soun";

/**
 * Reads one `trak`'s `mdia.hdlr` box's `componentSubtype` (the 4 ASCII
 * bytes at a fixed offset past `hdlr`'s full-box header and its first
 * 4-byte component-type field; see mp4-muxer's own `hdlr` construction,
 * which always writes a classic-QuickTime-style `hdlr` with a fixed
 * `"mhlr"` component type ahead of the actual subtype this function reads).
 *
 * @throws {Mp4ParseError} if `trak` has no `mdia.hdlr` box.
 */
function readTrakHandlerType(view: DataView, trak: BoxHeader): string {
  const mdia = findChildBox(view, trak.payloadStart, trak.boxEnd, "mdia");
  if (mdia === undefined) {
    throw new Mp4ParseError('no "mdia" box found inside "trak"');
  }
  const hdlr = findChildBox(view, mdia.payloadStart, mdia.boxEnd, "hdlr");
  if (hdlr === undefined) {
    throw new Mp4ParseError('no "hdlr" box found inside "mdia"');
  }
  // version(u8) + flags(u24) + componentType(4 ascii bytes, always "mhlr"
  // in mp4-muxer's own hdlr construction) precede componentSubtype.
  const componentSubtypeOffset = hdlr.payloadStart + 4 + 4;
  return readAscii4(view, componentSubtypeOffset);
}

/**
 * Finds the first `moov.trak` whose `mdia.hdlr` component subtype matches
 * `handlerType` (`"vide"` or `"soun"`), returning its `BoxHeader`, or
 * `undefined` if no `trak` has that handler type (e.g. `"soun"` on a
 * video-only file).
 *
 * @throws {Mp4ParseError} if `bytes` is not well-formed, or has no
 *   top-level `moov` box.
 */
function findTrakByHandlerType(
  view: DataView,
  handlerType: Mp4TrackHandlerType,
): BoxHeader | undefined {
  const moov = findChildBox(view, 0, view.byteLength, "moov");
  if (moov === undefined) {
    throw new Mp4ParseError('no top-level "moov" box found');
  }
  const traks = findAllChildBoxes(view, moov.payloadStart, moov.boxEnd, "trak");
  return traks.find((trak) => readTrakHandlerType(view, trak) === handlerType);
}

/**
 * Reads one `trak`'s `mdia.mdhd.timescale`: the track-level timescale
 * `tfhd`/`trun` fragment durations are expressed in (see
 * `readMp4FragmentedDurationTicks`'s own doc), distinct from `mvhd`'s
 * movie-level timescale (`readMp4MovieHeader`'s `timescale`, always
 * mp4-muxer's fixed `GLOBAL_TIMESCALE` of 1000). `mdhd`'s payload layout
 * is identical to `mvhd`'s (`version(u8) + flags(u24)` then
 * creation/modification time at `timeFieldSize` each, then a plain u32
 * `timescale`), since both are "full boxes" following the same
 * ISO/IEC 14496-12 8.4.2/8.2.2 shape.
 */
function readTrakTimescale(view: DataView, trak: BoxHeader): number {
  const mdia = findChildBox(view, trak.payloadStart, trak.boxEnd, "mdia");
  if (mdia === undefined) {
    throw new Mp4ParseError('no "mdia" box found inside "trak"');
  }
  const mdhd = findChildBox(view, mdia.payloadStart, mdia.boxEnd, "mdhd");
  if (mdhd === undefined) {
    throw new Mp4ParseError('no "mdhd" box found inside "mdia"');
  }

  const version = view.getUint8(mdhd.payloadStart);
  const timeFieldSize = version === 1 ? 8 : 4;
  const timescaleOffset = mdhd.payloadStart + 4 + timeFieldSize * 2;
  return view.getUint32(timescaleOffset, false);
}

/**
 * Reads the first video track's `moov.trak.mdia.mdhd.timescale` (this
 * package's own muxing output always has at most one video track and at
 * most one audio track; see `readMp4AudioTrackTimescale` for the
 * audio-side counterpart).
 *
 * On a file muxed before this phase (video-only, with no `hdlr` box
 * disambiguation ever needed since there was only ever one `trak`), this
 * reads that sole `trak`'s handler type and, since it is always `"vide"`,
 * behaves exactly as before. On a file with both tracks, this specifically
 * finds the `"vide"`-handled `trak`, not merely the first one positionally
 * (mp4-muxer always writes video before audio when both are present, but
 * this function does not rely on that ordering, matching how a real player
 * would disambiguate tracks).
 *
 * @throws {Mp4ParseError} if `bytes` is not well-formed, or is missing a
 *   video `moov.trak.mdia.mdhd`.
 */
export function readMp4TrackTimescale(bytes: ArrayBuffer | Uint8Array): number {
  const view = toDataView(bytes);
  const trak = findTrakByHandlerType(view, "vide");
  if (trak === undefined) {
    throw new Mp4ParseError('no video "trak" (mdia.hdlr componentSubtype "vide") found in "moov"');
  }
  return readTrakTimescale(view, trak);
}

/**
 * Reads the audio track's `moov.trak.mdia.mdhd.timescale`, the audio-side
 * counterpart to `readMp4TrackTimescale`. `undefined` when the file has no
 * audio track at all (a video-only file, this phase's own "silent
 * composition" case), distinguishing that legitimate, expected state from
 * a genuinely malformed file.
 *
 * @throws {Mp4ParseError} if `bytes` is not well-formed.
 */
export function readMp4AudioTrackTimescale(bytes: ArrayBuffer | Uint8Array): number | undefined {
  const view = toDataView(bytes);
  const trak = findTrakByHandlerType(view, "soun");
  return trak === undefined ? undefined : readTrakTimescale(view, trak);
}

/**
 * Reads one `trak`'s `tkhd.trackId`: `version(u8) + flags(u24)` then
 * creation/modification time at `timeFieldSize` each (same version-driven
 * widening `mvhd`/`mdhd` use), then a plain u32 `trackId`, per
 * ISO/IEC 14496-12 section 8.3.2. This is the same `trackId` mp4-muxer
 * stamps into each `moof.traf.tfhd.trackId` for that track's fragments (see
 * `readMp4FragmentedDurationTicks`'s own doc), letting a fragmented file's
 * `traf`s be attributed back to the correct track.
 *
 * @throws {Mp4ParseError} if `trak` has no `tkhd` box.
 */
function readTrakId(view: DataView, trak: BoxHeader): number {
  const tkhd = findChildBox(view, trak.payloadStart, trak.boxEnd, "tkhd");
  if (tkhd === undefined) {
    throw new Mp4ParseError('no "tkhd" box found inside "trak"');
  }
  const version = view.getUint8(tkhd.payloadStart);
  const timeFieldSize = version === 1 ? 8 : 4;
  const trackIdOffset = tkhd.payloadStart + 4 + timeFieldSize * 2;
  return view.getUint32(trackIdOffset, false);
}

/**
 * `tfhd`'s (full box) fixed-layout fields this parser reads, present
 * whenever `flags` has all of `defaultSampleDurationPresent` (`0x000008`)
 * and `defaultSampleSizePresent` (`0x000010`) set, per ISO/IEC 14496-12
 * section 8.8.7: `trackId(u32) + [baseDataOffset(u64) if 0x000001] +
 * [sampleDescriptionIndex(u32) if 0x000002] + defaultSampleDuration(u32) +
 * defaultSampleSize(u32) + ...`. This parser only supports the specific bit
 * combination `muxToMp4Stream`'s fragmented output always sets (duration
 * and size present, base-data-offset and sample-description-index both
 * absent), which is exactly what every `tfhd` this validator ever
 * encounters has, since this package's own muxing is the only producer of
 * files this validator reads.
 */
const TFHD_DEFAULT_SAMPLE_DURATION_PRESENT = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE_PRESENT = 0x000010;
const TFHD_BASE_DATA_OFFSET_PRESENT = 0x000001;
const TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT = 0x000002;

/** `trun`'s (full box) flag bits this parser needs to interpret its fixed-vs-per-sample field layout, per ISO/IEC 14496-12 section 8.8.8. */
const TRUN_DATA_OFFSET_PRESENT = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS_PRESENT = 0x000004;
const TRUN_SAMPLE_DURATION_PRESENT = 0x000100;
const TRUN_SAMPLE_SIZE_PRESENT = 0x000200;
const TRUN_SAMPLE_FLAGS_PRESENT = 0x000400;
const TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS_PRESENT = 0x000800;

/** Reads a full box's `version(u8)`/`flags(u24 BE)` header, returning `flags` and the offset immediately past them. */
function readFullBoxVersionAndFlags(
  view: DataView,
  payloadStart: number,
): { version: number; flags: number; fieldsStart: number } {
  const version = view.getUint8(payloadStart);
  const flags =
    (view.getUint8(payloadStart + 1) << 16) |
    (view.getUint8(payloadStart + 2) << 8) |
    view.getUint8(payloadStart + 3);
  return { version, flags, fieldsStart: payloadStart + 4 };
}

/**
 * Reads one `traf`'s total sample duration (in the track's timescale
 * ticks): `tfhd`'s default sample duration, times however many of `trun`'s
 * samples do not carry their own explicit duration, plus the sum of every
 * sample that does carry one. In practice (this package's own muxing
 * output; see `TFHD_DEFAULT_SAMPLE_DURATION_PRESENT`'s doc for why this is
 * a safe assumption here specifically) every sample in a `traf` this
 * parser reads has an identical duration and `trun` omits per-sample
 * durations entirely, but the explicit-duration branch is still implemented
 * (not just assumed away) since a non-uniform-duration composition (e.g. a
 * partial final fragment) is a real case, not just a hypothetical one.
 *
 * @throws {Mp4ParseError} if `tfhd`'s flags do not match
 *   `TFHD_DEFAULT_SAMPLE_DURATION_PRESENT` (this parser's one supported
 *   shape; see that constant's own doc).
 */
function readTrafDurationTicks(view: DataView, traf: BoxHeader): number {
  const tfhd = findChildBox(view, traf.payloadStart, traf.boxEnd, "tfhd");
  if (tfhd === undefined) {
    throw new Mp4ParseError('no "tfhd" box found inside "traf"');
  }
  const tfhdHeader = readFullBoxVersionAndFlags(view, tfhd.payloadStart);
  const requiredFlags = TFHD_DEFAULT_SAMPLE_DURATION_PRESENT | TFHD_DEFAULT_SAMPLE_SIZE_PRESENT;
  if ((tfhdHeader.flags & requiredFlags) !== requiredFlags) {
    throw new Mp4ParseError(
      `"tfhd" box has unsupported flags 0x${tfhdHeader.flags.toString(16)}: this parser only supports default-sample-duration-present and default-sample-size-present both set`,
    );
  }
  if (
    (tfhdHeader.flags & TFHD_BASE_DATA_OFFSET_PRESENT) !== 0 ||
    (tfhdHeader.flags & TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT) !== 0
  ) {
    throw new Mp4ParseError(
      `"tfhd" box has unsupported flags 0x${tfhdHeader.flags.toString(16)}: this parser does not support base-data-offset-present or sample-description-index-present`,
    );
  }
  // trackId(u32) immediately follows version/flags, then
  // defaultSampleDuration(u32) (base-data-offset and
  // sample-description-index are both confirmed absent above, so no other
  // optional field sits between them).
  const defaultSampleDuration = view.getUint32(tfhdHeader.fieldsStart + 4, false);

  const trun = findChildBox(view, traf.payloadStart, traf.boxEnd, "trun");
  if (trun === undefined) {
    throw new Mp4ParseError('no "trun" box found inside "traf"');
  }
  const trunHeader = readFullBoxVersionAndFlags(view, trun.payloadStart);
  if ((trunHeader.flags & TRUN_DATA_OFFSET_PRESENT) === 0) {
    throw new Mp4ParseError(
      `"trun" box has unsupported flags 0x${trunHeader.flags.toString(16)}: this parser requires data-offset-present`,
    );
  }
  const sampleCount = view.getUint32(trunHeader.fieldsStart, false);
  let sampleFieldsOffset = trunHeader.fieldsStart + 4; // Past sampleCount.
  sampleFieldsOffset += 4; // dataOffset(u32), always present per the check above.
  if ((trunHeader.flags & TRUN_FIRST_SAMPLE_FLAGS_PRESENT) !== 0) {
    sampleFieldsOffset += 4;
  }

  const sampleDurationPresent = (trunHeader.flags & TRUN_SAMPLE_DURATION_PRESENT) !== 0;
  const sampleSizePresent = (trunHeader.flags & TRUN_SAMPLE_SIZE_PRESENT) !== 0;
  const sampleFlagsPresent = (trunHeader.flags & TRUN_SAMPLE_FLAGS_PRESENT) !== 0;
  const sampleCompositionTimeOffsetsPresent =
    (trunHeader.flags & TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS_PRESENT) !== 0;
  const perSampleFieldSize =
    (sampleDurationPresent ? 4 : 0) +
    (sampleSizePresent ? 4 : 0) +
    (sampleFlagsPresent ? 4 : 0) +
    (sampleCompositionTimeOffsetsPresent ? 4 : 0);

  if (!sampleDurationPresent) {
    // Every sample in this traf shares tfhd's default duration.
    return defaultSampleDuration * sampleCount;
  }

  let totalDuration = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    totalDuration += view.getUint32(sampleFieldsOffset + i * perSampleFieldSize, false);
  }
  return totalDuration;
}

/**
 * Reads one `traf`'s `tfhd.trackId`: the first field immediately following
 * `tfhd`'s `version(u8)+flags(u24)` header, per ISO/IEC 14496-12 section
 * 8.8.7. Used to attribute a `moof`'s `traf` boxes back to the specific
 * `trak` (found via `tkhd.trackId`; see `readTrakId`) they belong to, once a
 * fragmented file has more than one track's fragments interleaved within
 * the same `moof`.
 */
function readTrafTrackId(view: DataView, traf: BoxHeader): number {
  const tfhd = findChildBox(view, traf.payloadStart, traf.boxEnd, "tfhd");
  if (tfhd === undefined) {
    throw new Mp4ParseError('no "tfhd" box found inside "traf"');
  }
  const tfhdHeader = readFullBoxVersionAndFlags(view, tfhd.payloadStart);
  return view.getUint32(tfhdHeader.fieldsStart, false);
}

/**
 * Sums the total sample duration (track timescale ticks; same unit
 * `readMp4MovieHeader`'s `durationTicks` would use in an unfragmented file)
 * across every top-level `moof.traf` belonging to `trackId` in a
 * fragmented MP4, i.e. the fragmented-file counterpart to
 * `readMp4MovieHeader`'s `durationTicks` (see its own doc for why a
 * fragmented file's `mvhd.duration` is `0` and cannot be used directly).
 * This is the same computation a real player performs to report a
 * fragmented file's duration: fragmented MP4 has no single authoritative
 * duration field, precisely because it is designed to be
 * playable/appendable before the whole file (and thus the whole duration)
 * exists.
 *
 * `trackId` disambiguates which track's `traf` to sum when a `moof` carries
 * fragments for more than one track (mp4-muxer always writes one `traf`
 * per track per `moof`, video first when both are present; see
 * `readMp4FragmentedDurationTicks`/`readMp4AudioFragmentedDurationTicks`,
 * which resolve the correct `trackId` via `tkhd` before calling this).
 *
 * @throws {Mp4ParseError} if `bytes` is not well-formed, no `moof` carries
 *   a `traf` for `trackId`, or the fragment boxes do not match the
 *   specific shape this parser supports (see `readTrafDurationTicks`'s own
 *   doc).
 */
function sumFragmentedDurationTicksForTrack(view: DataView, trackId: number): number {
  const moofs = findAllChildBoxes(view, 0, view.byteLength, "moof");
  if (moofs.length === 0) {
    throw new Mp4ParseError('no top-level "moof" box found');
  }

  let totalDurationTicks = 0;
  let matchedAnyTraf = false;
  for (const moof of moofs) {
    const trafs = findAllChildBoxes(view, moof.payloadStart, moof.boxEnd, "traf");
    const traf = trafs.find((candidate) => readTrafTrackId(view, candidate) === trackId);
    if (traf === undefined) {
      continue;
    }
    matchedAnyTraf = true;
    totalDurationTicks += readTrafDurationTicks(view, traf);
  }

  if (!matchedAnyTraf) {
    throw new Mp4ParseError(`no "traf" box found for track id ${trackId} in any "moof"`);
  }
  return totalDurationTicks;
}

/**
 * Sums the total sample duration across every top-level `moof.traf`
 * belonging to the video track in a fragmented MP4. See
 * `sumFragmentedDurationTicksForTrack`'s own doc for the underlying
 * computation; this resolves the video track's `trackId` (via `moov.trak`'s
 * `hdlr` componentSubtype `"vide"`, then that same `trak`'s own `tkhd`)
 * before summing.
 *
 * @throws {Mp4ParseError} if `bytes` is not well-formed, has no video
 *   `trak`, or the fragment boxes do not match the specific shape this
 *   parser supports (see `readTrafDurationTicks`'s own doc).
 */
export function readMp4FragmentedDurationTicks(bytes: ArrayBuffer | Uint8Array): number {
  const view = toDataView(bytes);
  const trak = findTrakByHandlerType(view, "vide");
  if (trak === undefined) {
    throw new Mp4ParseError('no video "trak" (mdia.hdlr componentSubtype "vide") found in "moov"');
  }
  const trackId = readTrakId(view, trak);
  return sumFragmentedDurationTicksForTrack(view, trackId);
}

/**
 * Sums the total sample duration across every top-level `moof.traf`
 * belonging to the audio track in a fragmented MP4, the audio-side
 * counterpart to `readMp4FragmentedDurationTicks`. `undefined` when the
 * file has no audio track at all (a video-only file, this phase's own
 * "silent composition" case), distinguishing that legitimate, expected
 * state from a genuinely malformed file.
 *
 * @throws {Mp4ParseError} if `bytes` is not well-formed, or the fragment
 *   boxes do not match the specific shape this parser supports (see
 *   `readTrafDurationTicks`'s own doc).
 */
export function readMp4AudioFragmentedDurationTicks(
  bytes: ArrayBuffer | Uint8Array,
): number | undefined {
  const view = toDataView(bytes);
  const trak = findTrakByHandlerType(view, "soun");
  if (trak === undefined) {
    return undefined;
  }
  const trackId = readTrakId(view, trak);
  return sumFragmentedDurationTicksForTrack(view, trackId);
}
