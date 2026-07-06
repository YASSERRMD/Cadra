/**
 * `EncodedChunkResult.metadata`/the codec probed by `encodeFrames` only ever
 * carries a WebCodecs codec string (e.g. `"av01.0.08M.08"`, matching
 * `DEFAULT_CODEC_PREFERENCES`), but `mp4-muxer`'s `VideoOptions.codec` wants
 * its own short enum (`'av1' | 'vp9' | 'avc' | 'hevc'`) and `webm-muxer`'s
 * `video.codec` wants a Matroska codec ID string (`'V_AV1'`, `'V_VP9'`,
 * `'V_MPEG4/ISO/AVC'`, per matroska.org/technical/codec_specs.html). Neither
 * muxer derives its own enum from the WebCodecs string, so this module is
 * the single place that bridges the two: adding a new entry to
 * `DEFAULT_CODEC_PREFERENCES` (or accepting a caller-supplied one) only
 * requires a new case here, not a change scattered across both mux-mp4.ts
 * and mux-webm.ts.
 *
 * Matched by prefix (`codec.startsWith(...)`) rather than exact string
 * equality: WebCodecs codec strings encode profile/level/tier/bit-depth
 * after the codec family prefix (see `codec-probe.ts`'s own doc for the
 * format of each), and every value in that trailing detail is irrelevant to
 * which container-level codec family a chunk belongs to.
 */

/** mp4-muxer's `VideoOptions.codec` enum. */
export type Mp4VideoCodec = "avc" | "hevc" | "vp9" | "av1";

/** webm-muxer's Matroska video codec ID string. */
export type WebmVideoCodec = "V_AV1" | "V_VP9" | "V_VP8" | "V_MPEG4/ISO/AVC" | "V_MPEGH/ISO/HEVC";

/** Thrown when a WebCodecs codec string does not match any known family prefix. */
export class UnsupportedMuxCodecError extends Error {
  constructor(codec: string) {
    super(
      `Cannot mux codec "${codec}": no known WebCodecs codec string prefix (av01, vp09, vp08, avc1/av1C, hvc1/hev1) matched it.`,
    );
    this.name = "UnsupportedMuxCodecError";
  }
}

/**
 * Recognized WebCodecs codec string prefixes, paired with both target
 * muxers' equivalents, ordered by family (AV1, VP9, VP8, AVC, HEVC). Kept as
 * one ordered list (rather than two independent lookups) so the two muxers'
 * mappings can never silently drift apart for a given WebCodecs family.
 */
const CODEC_FAMILY_TABLE: ReadonlyArray<{
  prefixes: readonly string[];
  mp4: Mp4VideoCodec;
  webm: WebmVideoCodec;
}> = [
  { prefixes: ["av01"], mp4: "av1", webm: "V_AV1" },
  { prefixes: ["vp09"], mp4: "vp9", webm: "V_VP9" },
  { prefixes: ["vp08"], mp4: "vp9", webm: "V_VP8" },
  { prefixes: ["avc1", "avc3"], mp4: "avc", webm: "V_MPEG4/ISO/AVC" },
  { prefixes: ["hvc1", "hev1"], mp4: "hevc", webm: "V_MPEGH/ISO/HEVC" },
];

/**
 * VP8 has no MP4 mapping in `mp4-muxer`'s enum (VP8-in-MP4 is not a
 * standardized combination the way VP8-in-WebM is), so muxing a VP8 chunk to
 * MP4 specifically is rejected here rather than silently mislabeled as VP9.
 */
export class Vp8NotSupportedInMp4Error extends Error {
  constructor() {
    super(
      "Cannot mux a VP8-encoded chunk into an MP4 container: VP8-in-MP4 is not a standardized combination. Use the WebM muxer for VP8 output, or encode with VP9/AV1/H.264 for MP4 output.",
    );
    this.name = "Vp8NotSupportedInMp4Error";
  }
}

function findCodecFamily(codec: string): (typeof CODEC_FAMILY_TABLE)[number] {
  const family = CODEC_FAMILY_TABLE.find((entry) =>
    entry.prefixes.some((prefix) => codec.startsWith(prefix)),
  );
  if (family === undefined) {
    throw new UnsupportedMuxCodecError(codec);
  }
  return family;
}

/**
 * Maps a WebCodecs codec string to mp4-muxer's `VideoOptions.codec` enum.
 *
 * @throws {UnsupportedMuxCodecError} if `codec` matches no known family.
 * @throws {Vp8NotSupportedInMp4Error} if `codec` is VP8 (see its own doc).
 */
export function toMp4VideoCodec(codec: string): Mp4VideoCodec {
  const family = findCodecFamily(codec);
  if (family.webm === "V_VP8") {
    throw new Vp8NotSupportedInMp4Error();
  }
  return family.mp4;
}

/**
 * Maps a WebCodecs codec string to webm-muxer's Matroska codec ID string.
 *
 * @throws {UnsupportedMuxCodecError} if `codec` matches no known family.
 */
export function toWebmVideoCodec(codec: string): WebmVideoCodec {
  return findCodecFamily(codec).webm;
}

/** mp4-muxer's `AudioOptions.codec` enum. */
export type Mp4AudioCodec = "aac" | "opus";

/** webm-muxer's Matroska audio codec ID string. */
export type WebmAudioCodec = "A_OPUS" | "A_AAC";

/** Thrown when a WebCodecs audio codec string does not match any known family. */
export class UnsupportedMuxAudioCodecError extends Error {
  constructor(codec: string) {
    super(
      `Cannot mux audio codec "${codec}": no known WebCodecs audio codec string prefix (mp4a, opus) matched it.`,
    );
    this.name = "UnsupportedMuxAudioCodecError";
  }
}

/**
 * Recognized WebCodecs audio codec string prefixes, paired with both
 * target muxers' equivalents. Mirrors `CODEC_FAMILY_TABLE`'s video-side
 * shape, but audio codec choice is container-driven rather than a single
 * shared preference order (see `audio-codec-probe.ts`'s own doc): AAC only
 * ever targets MP4, Opus only ever targets WebM in this package's own
 * `encodeAudio` (`DEFAULT_AUDIO_CODEC_PREFERENCES`), so unlike the video
 * table, this one is not consulted to pick a container-appropriate codec,
 * only to map an already-chosen one to each muxer's own enum/string.
 */
const AUDIO_CODEC_FAMILY_TABLE: ReadonlyArray<{
  prefixes: readonly string[];
  mp4: Mp4AudioCodec | undefined;
  webm: WebmAudioCodec | undefined;
}> = [
  { prefixes: ["mp4a"], mp4: "aac", webm: "A_AAC" },
  { prefixes: ["opus"], mp4: "opus", webm: "A_OPUS" },
];

function findAudioCodecFamily(codec: string): (typeof AUDIO_CODEC_FAMILY_TABLE)[number] {
  const family = AUDIO_CODEC_FAMILY_TABLE.find((entry) =>
    entry.prefixes.some((prefix) => codec.startsWith(prefix)),
  );
  if (family === undefined) {
    throw new UnsupportedMuxAudioCodecError(codec);
  }
  return family;
}

/**
 * Maps a WebCodecs audio codec string to mp4-muxer's `AudioOptions.codec`
 * enum.
 *
 * @throws {UnsupportedMuxAudioCodecError} if `codec` matches no known family.
 * @throws {UnsupportedMuxAudioCodecError} if the matched family has no MP4
 *   mapping (Opus-in-MP4, while technically registered by some tooling, is
 *   not what this package's own `encodeAudio` ever produces for an MP4
 *   target: `DEFAULT_AUDIO_CODEC_PREFERENCES` only ever probes AAC for
 *   `"mp4"`, so reaching this branch means a caller passed a
 *   caller-supplied codec string this package does not expect).
 */
export function toMp4AudioCodec(codec: string): Mp4AudioCodec {
  const family = findAudioCodecFamily(codec);
  if (family.mp4 === undefined) {
    throw new UnsupportedMuxAudioCodecError(codec);
  }
  return family.mp4;
}

/**
 * Maps a WebCodecs audio codec string to webm-muxer's Matroska audio codec
 * ID string.
 *
 * @throws {UnsupportedMuxAudioCodecError} if `codec` matches no known
 *   family, or the matched family has no WebM mapping.
 */
export function toWebmAudioCodec(codec: string): WebmAudioCodec {
  const family = findAudioCodecFamily(codec);
  if (family.webm === undefined) {
    throw new UnsupportedMuxAudioCodecError(codec);
  }
  return family.webm;
}
