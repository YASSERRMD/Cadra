/**
 * A minimal, standards-conforming EBML/Matroska parser, just deep enough to
 * read back the two numbers this phase's acceptance criteria care about:
 * `Segment.Info.TimestampScale` and `Segment.Info.Duration`. Mirrors
 * `mux-validate-mp4.ts`'s scope and rationale (see its own doc): not a
 * general-purpose Matroska parser, just enough to let a test assert
 * container-level duration/timescale without a real player.
 *
 * EBML element layout follows the Matroska/EBML spec exactly (not anything
 * webm-muxer-specific): `elementID (VINT) + size (VINT) + payload`. Both
 * `elementID` and `size` use the same variable-width-integer encoding: the
 * position of the leading `1` bit within the first byte determines the
 * total width in bytes (1-8), and that leading marker bit is included as
 * part of the raw ID value (ID constants like `Duration = 0x4489` already
 * carry it) but excluded from a decoded `size` value (a size VINT's marker
 * bit is stripped before interpreting the remaining bits as the actual
 * length). `size` additionally has an "unknown size" convention (every
 * content bit set to 1, e.g. a 1-byte size of `0xFF`), used for streamed
 * elements whose length was not known when their header was written; this
 * parser only descends into `Segment`/`Info`, neither of which webm-muxer
 * ever writes with unknown size (only `Segment` itself can be, in
 * `streaming: true` mode, and this parser's `Segment` handling special
 * cases exactly that by scanning for `Info` rather than trusting a
 * declared end offset).
 */

/** Matroska EBML element IDs this parser looks for, as raw ID values (marker bit included, see this module's own doc). */
const ELEMENT_ID = {
  segment: 0x18538067,
  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  cluster: 0x1f43b675,
  timestamp: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  blockDuration: 0x9b,
} as const;

/**
 * Matroska `TrackEntry.TrackType` values this parser distinguishes: `1` for
 * video, `2` for audio, matching both the Matroska spec and webm-muxer's own
 * fixed `VIDEO_TRACK_TYPE`/`AUDIO_TRACK_TYPE` constants.
 */
const TRACK_TYPE_VIDEO = 1;
const TRACK_TYPE_AUDIO = 2;

/** Segment-level timing metadata read back out of a WebM/Matroska file's `Segment.Info`. */
export interface WebmSegmentInfo {
  /** `Info.TimestampScale`: nanoseconds per timestamp tick (Matroska's default is 1,000,000, i.e. millisecond ticks). */
  timestampScale: number;
  /**
   * `Info.Duration`, in `timestampScale` ticks, or `undefined` when the
   * `Duration` element is absent (as `muxToWebmStream`'s `streaming: true`
   * mode deliberately produces; see its own doc). Modeled as optional
   * rather than defaulting to 0 or throwing: an absent `Duration` is a
   * distinct, valid, and documented state a caller needs to be able to
   * distinguish from "duration is exactly zero."
   */
  duration: number | undefined;
}

/** Thrown when `readWebmSegmentInfo` cannot find a `Segment.Info` element, or the bytes are not well-formed EBML. */
export class WebmParseError extends Error {
  constructor(message: string) {
    super(`WebmParseError: ${message}`);
    this.name = "WebmParseError";
  }
}

/** Marks "unknown size" (every content bit of the size VINT set to 1), see this module's own top-level doc. */
const UNKNOWN_SIZE = -1;

/** One decoded VINT: its numeric `value` (marker bit already stripped) and how many bytes it occupied. */
interface DecodedVint {
  value: number;
  widthBytes: number;
}

/**
 * Decodes one EBML variable-width integer starting at `offset`, returning
 * both its value and width in bytes. `stripMarkerBit` is `false` for
 * element IDs (the marker bit is part of the ID's identity) and `true` for
 * sizes (the marker bit is not part of the length value itself).
 *
 * @throws {WebmParseError} if the byte at `offset` is `0x00` (no bit set
 *   anywhere in the first byte, meaning a width wider than the 8 bytes this
 *   parser supports, which never occurs in any element this parser reads)
 *   or reading `widthBytes` would run past `end`.
 */
function decodeVint(
  view: DataView,
  offset: number,
  end: number,
  stripMarkerBit: boolean,
): DecodedVint {
  if (offset >= end) {
    throw new WebmParseError(`truncated VINT at offset ${offset}: no bytes remain`);
  }

  const firstByte = view.getUint8(offset);
  if (firstByte === 0) {
    throw new WebmParseError(`unsupported VINT at offset ${offset}: width exceeds 8 bytes`);
  }

  let widthBytes = 1;
  let marker = 0x80;
  while ((firstByte & marker) === 0) {
    widthBytes += 1;
    marker >>= 1;
  }

  if (offset + widthBytes > end) {
    throw new WebmParseError(
      `truncated VINT at offset ${offset}: declares width ${widthBytes} past available bytes`,
    );
  }

  // "All content bits set to 1" is the unknown-size sentinel; checked
  // before marker-bit stripping since it must be recognized regardless of
  // whether this call strips the marker bit for a size or keeps it for an ID.
  let allContentBitsSet = (firstByte & ~marker & 0xff) === (0xff & ~marker & 0xff);
  let value = stripMarkerBit ? firstByte & ~marker & 0xff : firstByte;
  for (let i = 1; i < widthBytes; i += 1) {
    const byte = view.getUint8(offset + i);
    if (byte !== 0xff) {
      allContentBitsSet = false;
    }
    value = value * 256 + byte;
  }

  if (stripMarkerBit && allContentBitsSet) {
    return { value: UNKNOWN_SIZE, widthBytes };
  }
  return { value, widthBytes };
}

/** One EBML element's header, as `readElementHeader` parses it. */
interface ElementHeader {
  id: number;
  /** Offset of this element's payload, immediately after its ID and size VINTs. */
  payloadStart: number;
  /**
   * Offset immediately past this element's last payload byte, or
   * `UNKNOWN_SIZE` if this element declared unknown size (see this module's
   * top-level doc; only ever encountered on `Segment` itself, in practice).
   */
  payloadEnd: number;
}

function readElementHeader(view: DataView, offset: number, containerEnd: number): ElementHeader {
  const id = decodeVint(view, offset, containerEnd, false);
  const size = decodeVint(view, offset + id.widthBytes, containerEnd, true);
  const payloadStart = offset + id.widthBytes + size.widthBytes;
  const payloadEnd = size.value === UNKNOWN_SIZE ? UNKNOWN_SIZE : payloadStart + size.value;
  return { id: id.value, payloadStart, payloadEnd };
}

/**
 * Scans direct children of `[start, end)` for the first element matching
 * `id`. Mirrors `mux-validate-mp4.ts`'s `findChildBox` (see its own doc for
 * why this does not recurse automatically), with one addition: `end` may
 * itself be `UNKNOWN_SIZE`, in which case this function scans until it hits
 * `hardEnd` (the whole buffer's length) instead, since an unknown-size
 * parent has no declared end to stop at other than the file itself (this
 * parser never nests two unknown-size elements, so one `hardEnd` fallback
 * suffices).
 */
function findChildElement(
  view: DataView,
  start: number,
  end: number,
  hardEnd: number,
  id: number,
): ElementHeader | undefined {
  const scanEnd = end === UNKNOWN_SIZE ? hardEnd : end;
  let offset = start;
  while (offset < scanEnd) {
    const header = readElementHeader(view, offset, scanEnd);
    if (header.id === id) {
      return header;
    }
    if (header.payloadEnd === UNKNOWN_SIZE) {
      // An unknown-size element with more unknown-size siblings after it
      // would make "where does the next sibling start" ambiguous; not a
      // case this parser's inputs (Segment/Info) ever produce, since only
      // one top-level Segment exists per file.
      throw new WebmParseError(
        `element 0x${header.id.toString(16)} at offset ${offset} has unknown size but is not the outermost element being scanned; cannot locate its end`,
      );
    }
    offset = header.payloadEnd;
  }
  return undefined;
}

/**
 * Same traversal as `findChildElement`, but collects every direct child
 * matching `id` instead of stopping at the first: needed for `Cluster`
 * (one per group of blocks written) and `TrackEntry`/`BlockGroup` (one per
 * track). Mirrors `mux-validate-mp4.ts`'s `findAllChildBoxes`.
 */
function findAllChildElements(
  view: DataView,
  start: number,
  end: number,
  hardEnd: number,
  id: number,
): ElementHeader[] {
  const scanEnd = end === UNKNOWN_SIZE ? hardEnd : end;
  const matches: ElementHeader[] = [];
  let offset = start;
  while (offset < scanEnd) {
    const header = readElementHeader(view, offset, scanEnd);
    if (header.id === id) {
      matches.push(header);
    }
    if (header.payloadEnd === UNKNOWN_SIZE) {
      throw new WebmParseError(
        `element 0x${header.id.toString(16)} at offset ${offset} has unknown size but is not the outermost element being scanned; cannot locate its end`,
      );
    }
    offset = header.payloadEnd;
  }
  return matches;
}

/**
 * Reads an 8-byte IEEE754 big-endian double at `offset`, the encoding
 * `EBMLFloat64` (both muxers' shared internal representation for
 * `Duration`) always uses; per the EBML spec a float element's size
 * determines whether it holds a 4-byte or 8-byte float, and both target
 * muxers always choose 8-byte for `Duration`, so this parser does not
 * generalize to the 4-byte case.
 *
 * @throws {WebmParseError} if `header`'s payload is not exactly 8 bytes.
 */
function readFloat64Element(view: DataView, header: ElementHeader): number {
  const length = header.payloadEnd - header.payloadStart;
  if (length !== 8) {
    throw new WebmParseError(
      `expected an 8-byte float payload for element 0x${header.id.toString(16)}, found ${length} bytes`,
    );
  }
  return view.getFloat64(header.payloadStart, false);
}

/**
 * Reads a big-endian unsigned integer element of `header`'s declared
 * length (1-8 bytes; Matroska unsigned-integer elements are variable-width,
 * unlike EBML VINTs, with no marker bit to strip).
 */
function readUintElement(view: DataView, header: ElementHeader): number {
  const length = header.payloadEnd - header.payloadStart;
  let value = 0;
  for (let i = 0; i < length; i += 1) {
    value = value * 256 + view.getUint8(header.payloadStart + i);
  }
  return value;
}

/**
 * Parses `bytes` (a full WebM/Matroska file, as produced by
 * `muxToWebmBuffer`/`muxToWebmBlob`) just far enough to read back
 * `Segment.Info.TimestampScale` and `Segment.Info.Duration`.
 *
 * @throws {WebmParseError} if `bytes` is not well-formed, or has no
 *   `Segment.Info` element (an `Info` element is mandatory in every valid
 *   Matroska file, so its absence indicates malformed input rather than a
 *   legitimately-absent-but-valid case, unlike `Duration` within it).
 */
export function readWebmSegmentInfo(bytes: ArrayBuffer | Uint8Array): WebmSegmentInfo {
  const view =
    bytes instanceof Uint8Array
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new DataView(bytes);

  const segment = findChildElement(view, 0, view.byteLength, view.byteLength, ELEMENT_ID.segment);
  if (segment === undefined) {
    throw new WebmParseError('no top-level "Segment" element found');
  }

  const info = findChildElement(
    view,
    segment.payloadStart,
    segment.payloadEnd,
    view.byteLength,
    ELEMENT_ID.info,
  );
  if (info === undefined) {
    throw new WebmParseError('no "Info" element found inside "Segment"');
  }

  const timestampScaleElement = findChildElement(
    view,
    info.payloadStart,
    info.payloadEnd,
    view.byteLength,
    ELEMENT_ID.timestampScale,
  );
  // Matroska defines TimestampScale's default as 1,000,000 (nanosecond
  // ticks) when the element itself is omitted, per the spec; both target
  // muxers always write it explicitly, but a validator built to the actual
  // Matroska spec (rather than only these two muxers' current behavior)
  // should honor the documented default rather than treat its absence as
  // an error.
  const timestampScale =
    timestampScaleElement === undefined ? 1_000_000 : readUintElement(view, timestampScaleElement);

  const durationElement = findChildElement(
    view,
    info.payloadStart,
    info.payloadEnd,
    view.byteLength,
    ELEMENT_ID.duration,
  );
  const duration =
    durationElement === undefined ? undefined : readFloat64Element(view, durationElement);

  return { timestampScale, duration };
}

/**
 * A Matroska `TrackEntry.TrackType` value this parser distinguishes: `1`
 * for video, `2` for audio, per the Matroska spec and matching
 * webm-muxer's own fixed track-type constants.
 */
export type WebmTrackType = "video" | "audio";

function trackTypeToMatroskaValue(trackType: WebmTrackType): number {
  return trackType === "video" ? TRACK_TYPE_VIDEO : TRACK_TYPE_AUDIO;
}

/**
 * Finds `Segment.Tracks`, then the `TrackNumber` of the first `TrackEntry`
 * whose `TrackType` matches `trackType` (`"video"` -> Matroska value `1`,
 * `"audio"` -> `2`). Returns `undefined` when no such `TrackEntry` exists
 * (e.g. `"audio"` on a video-only file, this phase's own "silent
 * composition" case).
 *
 * Unlike MP4's `hdlr`-based `findTrakByHandlerType` (which returns a whole
 * `BoxHeader` to descend into further), this returns just the numeric
 * `TrackNumber`: Matroska blocks (`SimpleBlock`/`Block`) reference their
 * track only by that number (see `readBlockPrelude`'s own doc), not by any
 * structural link back to a `TrackEntry`, so the number itself is the only
 * thing a block-scanning caller needs.
 *
 * @throws {WebmParseError} if `bytes` is not well-formed, or has no
 *   `Segment.Tracks` element (mandatory in every valid Matroska file).
 */
function findWebmTrackNumberByType(
  view: DataView,
  segment: ElementHeader,
  trackType: WebmTrackType,
): number | undefined {
  const tracks = findChildElement(
    view,
    segment.payloadStart,
    segment.payloadEnd,
    view.byteLength,
    ELEMENT_ID.tracks,
  );
  if (tracks === undefined) {
    throw new WebmParseError('no "Tracks" element found inside "Segment"');
  }

  const trackEntries = findAllChildElements(
    view,
    tracks.payloadStart,
    tracks.payloadEnd,
    view.byteLength,
    ELEMENT_ID.trackEntry,
  );

  const matroskaTrackType = trackTypeToMatroskaValue(trackType);
  for (const trackEntry of trackEntries) {
    const trackTypeElement = findChildElement(
      view,
      trackEntry.payloadStart,
      trackEntry.payloadEnd,
      view.byteLength,
      ELEMENT_ID.trackType,
    );
    if (trackTypeElement === undefined) {
      continue;
    }
    if (readUintElement(view, trackTypeElement) !== matroskaTrackType) {
      continue;
    }
    const trackNumberElement = findChildElement(
      view,
      trackEntry.payloadStart,
      trackEntry.payloadEnd,
      view.byteLength,
      ELEMENT_ID.trackNumber,
    );
    if (trackNumberElement === undefined) {
      continue;
    }
    return readUintElement(view, trackNumberElement);
  }
  return undefined;
}

/** One `SimpleBlock`/`Block` element's decoded prelude: which track it belongs to, and its timestamp relative to its parent `Cluster`'s own base `Timestamp`. */
interface BlockPrelude {
  trackNumber: number;
  relativeTimestamp: number;
}

/**
 * Decodes a `SimpleBlock`/`Block` element's binary prelude: a VINT-encoded
 * track number, immediately followed by a signed 16-bit big-endian
 * timestamp relative to the enclosing `Cluster`'s own `Timestamp`, then a
 * single flags byte (unused here), per the Matroska spec's Block Structure
 * section. Every track number webm-muxer itself ever writes (`1` for
 * video, `2` for audio; see `VIDEO_TRACK_NUMBER`/`AUDIO_TRACK_NUMBER` in
 * its own source) fits in a single-byte VINT, so this parser does not
 * generalize to a multi-byte track number VINT.
 */
function readBlockPrelude(view: DataView, payloadStart: number): BlockPrelude {
  const trackNumber = decodeVint(view, payloadStart, payloadStart + 8, true).value;
  const relativeTimestamp = view.getInt16(payloadStart + 1, false);
  return { trackNumber, relativeTimestamp };
}

/**
 * Finds the largest end timestamp (`clusterTimestamp + relativeTimestamp +
 * blockDuration`, in `Segment.Info.TimestampScale` ticks) across every
 * `Cluster`'s `BlockGroup.Block` (and bare `SimpleBlock`, included for
 * completeness even though this package's own muxing always produces a
 * `BlockGroup` with an explicit `BlockDuration`; see `mux-webm.ts`'s own
 * doc for why every chunk this package feeds a muxer always carries a
 * duration) belonging to `trackNumber`.
 *
 * This is the Matroska-side counterpart to MP4's
 * `sumFragmentedDurationTicksForTrack`: unlike MP4 (where `mdhd.duration`
 * gives each track an authoritative, pre-summed value), Matroska has no
 * per-track duration element at all (only `Segment.Info.Duration`, a
 * single file-wide value derived from whichever track's last block ends
 * latest; see `mux-webm.ts`'s own top-level doc for webm-muxer's exact
 * "highest timestamp seen so far" semantics), so a per-track duration must
 * be reconstructed directly from that track's own blocks.
 *
 * A `SimpleBlock` (no `BlockDuration` available) contributes only its own
 * start timestamp, not a duration-extended end timestamp: this parser has
 * no way to know a bare `SimpleBlock`'s own duration (Matroska does not
 * store one for that element kind), so a caller comparing this end
 * timestamp against another track's should expect this function to
 * underreport for a file mixing `SimpleBlock` samples; not a concern for
 * this package's own muxing output, which always uses `BlockGroup`.
 *
 * @throws {WebmParseError} if `bytes` is not well-formed, or the `Segment`
 *   has no `Cluster` elements.
 */
function findLastBlockEndTimestampForTrack(
  view: DataView,
  segment: ElementHeader,
  trackNumber: number,
): number {
  const clusters = findAllChildElements(
    view,
    segment.payloadStart,
    segment.payloadEnd,
    view.byteLength,
    ELEMENT_ID.cluster,
  );
  if (clusters.length === 0) {
    throw new WebmParseError('no "Cluster" element found inside "Segment"');
  }

  let lastEndTimestamp: number | undefined;

  for (const cluster of clusters) {
    const timestampElement = findChildElement(
      view,
      cluster.payloadStart,
      cluster.payloadEnd,
      view.byteLength,
      ELEMENT_ID.timestamp,
    );
    if (timestampElement === undefined) {
      throw new WebmParseError('no "Timestamp" element found inside "Cluster"');
    }
    const clusterTimestamp = readUintElement(view, timestampElement);

    const blockGroups = findAllChildElements(
      view,
      cluster.payloadStart,
      cluster.payloadEnd,
      view.byteLength,
      ELEMENT_ID.blockGroup,
    );
    for (const blockGroup of blockGroups) {
      const block = findChildElement(
        view,
        blockGroup.payloadStart,
        blockGroup.payloadEnd,
        view.byteLength,
        ELEMENT_ID.block,
      );
      if (block === undefined) {
        throw new WebmParseError('no "Block" element found inside "BlockGroup"');
      }
      const prelude = readBlockPrelude(view, block.payloadStart);
      if (prelude.trackNumber !== trackNumber) {
        continue;
      }
      const blockDurationElement = findChildElement(
        view,
        blockGroup.payloadStart,
        blockGroup.payloadEnd,
        view.byteLength,
        ELEMENT_ID.blockDuration,
      );
      const blockDuration =
        blockDurationElement === undefined ? 0 : readUintElement(view, blockDurationElement);
      const endTimestamp = clusterTimestamp + prelude.relativeTimestamp + blockDuration;
      lastEndTimestamp =
        lastEndTimestamp === undefined ? endTimestamp : Math.max(lastEndTimestamp, endTimestamp);
    }

    const simpleBlocks = findAllChildElements(
      view,
      cluster.payloadStart,
      cluster.payloadEnd,
      view.byteLength,
      ELEMENT_ID.simpleBlock,
    );
    for (const simpleBlock of simpleBlocks) {
      const prelude = readBlockPrelude(view, simpleBlock.payloadStart);
      if (prelude.trackNumber !== trackNumber) {
        continue;
      }
      // No BlockDuration available for a bare SimpleBlock; see this
      // function's own doc for why this only contributes a start
      // timestamp, not a duration-extended end timestamp.
      const endTimestamp = clusterTimestamp + prelude.relativeTimestamp;
      lastEndTimestamp =
        lastEndTimestamp === undefined ? endTimestamp : Math.max(lastEndTimestamp, endTimestamp);
    }
  }

  return lastEndTimestamp ?? 0;
}

/**
 * Reads the largest end timestamp (in `Segment.Info.TimestampScale` ticks;
 * same unit `readWebmSegmentInfo`'s `duration` uses) across every block
 * belonging to the track whose `TrackType` matches `trackType` (`"video"`
 * or `"audio"`).
 *
 * `undefined` when no track of that type exists in the file (e.g.
 * `"audio"` on a video-only file, this phase's own "silent composition"
 * case), distinguishing that legitimate, expected state from a genuinely
 * malformed file. This is the Matroska-side way to answer "does this
 * track's own content span the same duration as the other track's":
 * unlike MP4 (`readMp4TrackTimescale`/`readMp4AudioTrackTimescale`, each
 * backed by that track's own authoritative `mdhd.duration`), Matroska has
 * no per-track duration field at all (see
 * `findLastBlockEndTimestampForTrack`'s own doc), so this reconstructs the
 * equivalent value directly from that track's own blocks.
 *
 * @throws {WebmParseError} if `bytes` is not well-formed.
 */
export function readWebmTrackLastBlockEndTimestamp(
  bytes: ArrayBuffer | Uint8Array,
  trackType: WebmTrackType,
): number | undefined {
  const view =
    bytes instanceof Uint8Array
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new DataView(bytes);

  const segment = findChildElement(view, 0, view.byteLength, view.byteLength, ELEMENT_ID.segment);
  if (segment === undefined) {
    throw new WebmParseError('no top-level "Segment" element found');
  }

  const trackNumber = findWebmTrackNumberByType(view, segment, trackType);
  if (trackNumber === undefined) {
    return undefined;
  }

  return findLastBlockEndTimestampForTrack(view, segment, trackNumber);
}
