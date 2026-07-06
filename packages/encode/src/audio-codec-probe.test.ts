import { describe, expect, it } from "vitest";

import {
  type AudioCodecPreference,
  type AudioCodecProbeTarget,
  DEFAULT_AUDIO_CODEC_PREFERENCES,
  NoSupportedAudioCodecError,
  probeSupportedAudioCodec,
} from "./audio-codec-probe.js";
import type { IsAudioConfigSupportedFn } from "./audio-encoder-factory.js";

const target: AudioCodecProbeTarget = { numberOfChannels: 2, sampleRate: 48_000, bitrate: 128_000 };

/** Builds a fake `isConfigSupported` reporting only `supportedCodecs` as supported, recording every call's config. */
function createFakeIsConfigSupported(supportedCodecs: readonly string[]): {
  isConfigSupported: IsAudioConfigSupportedFn;
  calls: AudioEncoderConfig[];
} {
  const calls: AudioEncoderConfig[] = [];
  const isConfigSupported: IsAudioConfigSupportedFn = async (config) => {
    calls.push(config);
    return { config, supported: supportedCodecs.includes(config.codec) };
  };
  return { isConfigSupported, calls };
}

describe("DEFAULT_AUDIO_CODEC_PREFERENCES", () => {
  it("has one AAC entry targeting mp4 and one Opus entry targeting webm", () => {
    expect(DEFAULT_AUDIO_CODEC_PREFERENCES).toEqual([
      { label: "AAC", codec: "mp4a.40.2", container: "mp4" },
      { label: "Opus", codec: "opus", container: "webm" },
    ]);
  });
});

describe("probeSupportedAudioCodec: selection order", () => {
  it("selects the AAC preference when filtered to the mp4 container and it is supported", async () => {
    const mp4Preferences = DEFAULT_AUDIO_CODEC_PREFERENCES.filter(
      (preference) => preference.container === "mp4",
    );
    const { isConfigSupported, calls } = createFakeIsConfigSupported(["mp4a.40.2"]);

    const config = await probeSupportedAudioCodec(mp4Preferences, target, isConfigSupported);

    expect(config.codec).toBe("mp4a.40.2");
    expect(calls).toHaveLength(1);
  });

  it("selects the Opus preference when filtered to the webm container and it is supported", async () => {
    const webmPreferences = DEFAULT_AUDIO_CODEC_PREFERENCES.filter(
      (preference) => preference.container === "webm",
    );
    const { isConfigSupported, calls } = createFakeIsConfigSupported(["opus"]);

    const config = await probeSupportedAudioCodec(webmPreferences, target, isConfigSupported);

    expect(config.codec).toBe("opus");
    expect(calls).toHaveLength(1);
  });

  it("passes numberOfChannels/sampleRate/bitrate through unchanged on every probed config", async () => {
    const { isConfigSupported, calls } = createFakeIsConfigSupported(["mp4a.40.2"]);

    await probeSupportedAudioCodec(
      DEFAULT_AUDIO_CODEC_PREFERENCES.filter((preference) => preference.container === "mp4"),
      target,
      isConfigSupported,
    );

    for (const call of calls) {
      expect(call.numberOfChannels).toBe(target.numberOfChannels);
      expect(call.sampleRate).toBe(target.sampleRate);
      expect(call.bitrate).toBe(target.bitrate);
    }
  });

  it("respects a caller-supplied custom preference list instead of the default", async () => {
    const customPreferences: AudioCodecPreference[] = [
      { label: "Custom Opus", codec: "opus", container: "mp4" },
    ];
    const { isConfigSupported, calls } = createFakeIsConfigSupported(["opus"]);

    const config = await probeSupportedAudioCodec(customPreferences, target, isConfigSupported);

    expect(config.codec).toBe("opus");
    expect(calls).toHaveLength(1);
  });
});

describe("probeSupportedAudioCodec: no supported codec", () => {
  it("throws NoSupportedAudioCodecError when none of the preferences are supported", async () => {
    const { isConfigSupported } = createFakeIsConfigSupported([]);

    await expect(
      probeSupportedAudioCodec(DEFAULT_AUDIO_CODEC_PREFERENCES, target, isConfigSupported),
    ).rejects.toThrow(NoSupportedAudioCodecError);
  });

  it("includes every tried codec's label and string in the error message", async () => {
    const { isConfigSupported } = createFakeIsConfigSupported([]);

    await expect(
      probeSupportedAudioCodec(DEFAULT_AUDIO_CODEC_PREFERENCES, target, isConfigSupported),
    ).rejects.toThrow(/AAC \(mp4a\.40\.2\).*Opus \(opus\)/s);
  });
});
