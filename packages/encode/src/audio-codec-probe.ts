import type { IsAudioConfigSupportedFn } from "./audio-encoder-factory.js";

/**
 * One entry in an audio codec preference list: a human-readable `label`
 * (for error messages) plus the actual WebCodecs `codec` string that goes
 * into `AudioEncoderConfig.codec`. Mirrors `codec-probe.ts`'s
 * `CodecPreference`.
 */
export interface AudioCodecPreference {
  /** Human-readable name for error messages and diagnostics, e.g. "AAC". */
  label: string;
  /** WebCodecs codec string, e.g. `"mp4a.40.2"`. */
  codec: string;
  /** Which container this codec targets: `"mp4"` for AAC, `"webm"` for Opus. */
  container: "mp4" | "webm";
}

/**
 * Default audio codec preference list: AAC for MP4 output, Opus for WebM
 * output. Unlike `DEFAULT_CODEC_PREFERENCES` (video's single ordered list
 * tried in order regardless of target container), audio codec choice is
 * container-driven, not a quality/efficiency preference order: MP4 does not
 * support Opus and WebM does not support AAC in the combinations this
 * package's muxers target (see `mux-codec-mapping.ts`'s own audio mapping),
 * so `probeSupportedAudioCodec` is always called with the single entry
 * matching the target container, not the whole list at once.
 *
 * - `mp4a.40.2`: MPEG-4 AAC-LC (Low Complexity), the standard, most
 *   widely-supported AAC profile, and the exact string used throughout
 *   MDN's WebCodecs AAC examples.
 * - `opus`: the WebCodecs codec string for Opus (Opus has no
 *   profile/level suffix the way AVC/HEVC do; the bare string is the
 *   complete, standard identifier per the WebCodecs codec registry).
 */
export const DEFAULT_AUDIO_CODEC_PREFERENCES: readonly AudioCodecPreference[] = [
  { label: "AAC", codec: "mp4a.40.2", container: "mp4" },
  { label: "Opus", codec: "opus", container: "webm" },
];

/** The non-codec parts of an `AudioEncoderConfig` a probe needs to check support against. */
export type AudioCodecProbeTarget = Pick<
  AudioEncoderConfig,
  "numberOfChannels" | "sampleRate" | "bitrate"
>;

/** Thrown by `probeSupportedAudioCodec` when none of `preferences` are supported. */
export class NoSupportedAudioCodecError extends Error {
  constructor(preferences: readonly AudioCodecPreference[]) {
    const tried = preferences
      .map((preference) => `${preference.label} (${preference.codec})`)
      .join(", ");
    super(
      `encodeAudio: none of the configured audio codec preferences are supported in this environment. Tried: ${tried}.`,
    );
    this.name = "NoSupportedAudioCodecError";
  }
}

/**
 * Probes `preferences` in order via `isConfigSupported`, returning the full
 * `AudioEncoderConfig` for the first one reported as supported against
 * `target`'s channel count/sample rate/bitrate. Mirrors
 * `codec-probe.ts`'s `probeSupportedCodec`: first-supported-wins, honoring
 * the caller's stated preference order rather than substituting a "better"
 * unrequested codec.
 *
 * @throws {NoSupportedAudioCodecError} if no entry in `preferences` is supported.
 */
export async function probeSupportedAudioCodec(
  preferences: readonly AudioCodecPreference[],
  target: AudioCodecProbeTarget,
  isConfigSupported: IsAudioConfigSupportedFn,
): Promise<AudioEncoderConfig> {
  for (const preference of preferences) {
    const config: AudioEncoderConfig = { codec: preference.codec, ...target };
    const support = await isConfigSupported(config);
    if (support.supported === true) {
      return config;
    }
  }

  throw new NoSupportedAudioCodecError(preferences);
}
