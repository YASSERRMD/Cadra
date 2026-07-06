import type { IsConfigSupportedFn } from "./video-encoder-factory.js";

/**
 * One entry in a codec preference list: a human-readable `label` (for error
 * messages) plus the actual WebCodecs `codec` string that goes into
 * `VideoEncoderConfig.codec`.
 */
export interface CodecPreference {
  /** Human-readable name for error messages and diagnostics, e.g. "AV1". */
  label: string;
  /** WebCodecs codec string, e.g. `"av01.0.08M.08"`. */
  codec: string;
}

/**
 * Default codec preference list, in the order `probeSupportedCodec` tries
 * them: AV1 first (best compression efficiency at a given bitrate, worth
 * trying first when hardware/software support exists), then VP9 (widely
 * supported, royalty-free, good efficiency), then H.264 (universal decode
 * support, the safest fallback when neither of the above is available).
 *
 * Each string is a standard, commonly-documented example for its codec
 * family (not an arbitrary guess):
 * - `av01.0.08M.08`: AV1 Main profile (0), level 4.0 (08), Main tier (M),
 *   8-bit (08). This is the example used throughout MDN's WebCodecs docs.
 * - `vp09.00.10.08`: VP9 profile 0, level 1.0 (10), 8-bit (08). Also MDN's
 *   standard VP9 example.
 * - `avc1.42001f`: H.264 Baseline profile (0x42), no constraint flags (00),
 *   level 3.1 (0x1f). The canonical baseline example used across the
 *   WebCodecs samples repo and W3C spec examples.
 */
export const DEFAULT_CODEC_PREFERENCES: readonly CodecPreference[] = [
  { label: "AV1", codec: "av01.0.08M.08" },
  { label: "VP9", codec: "vp09.00.10.08" },
  { label: "H.264", codec: "avc1.42001f" },
];

/** The non-codec parts of a `VideoEncoderConfig` a probe needs to check support against. */
export type CodecProbeTarget = Pick<
  VideoEncoderConfig,
  "width" | "height" | "bitrate" | "framerate"
>;

/** Thrown by `probeSupportedCodec` when none of `preferences` are supported. */
export class NoSupportedCodecError extends Error {
  constructor(preferences: readonly CodecPreference[]) {
    const tried = preferences
      .map((preference) => `${preference.label} (${preference.codec})`)
      .join(", ");
    super(
      `encodeFrames: none of the configured codec preferences are supported in this environment. Tried: ${tried}.`,
    );
    this.name = "NoSupportedCodecError";
  }
}

/**
 * Probes `preferences` in order via `isConfigSupported`, returning the full
 * `VideoEncoderConfig` for the first one reported as supported against
 * `target`'s resolution/bitrate/framerate.
 *
 * Deliberately picks the first supported entry rather than the "best"
 * available one by some other metric: `preferences` is already ordered by
 * the caller's preference (see `DEFAULT_CODEC_PREFERENCES`'s doc for the
 * rationale behind its own order), so first-supported-wins is exactly
 * "honor the caller's stated preference, do not silently substitute
 * something they did not ask for."
 *
 * @throws {NoSupportedCodecError} if no entry in `preferences` is supported.
 */
export async function probeSupportedCodec(
  preferences: readonly CodecPreference[],
  target: CodecProbeTarget,
  isConfigSupported: IsConfigSupportedFn,
): Promise<VideoEncoderConfig> {
  for (const preference of preferences) {
    const config: VideoEncoderConfig = { codec: preference.codec, ...target };
    const support = await isConfigSupported(config);
    if (support.supported === true) {
      return config;
    }
  }

  throw new NoSupportedCodecError(preferences);
}
