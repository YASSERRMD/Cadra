import { describe, expect, it } from "vitest";

import {
  type CodecPreference,
  type CodecProbeTarget,
  DEFAULT_CODEC_PREFERENCES,
  NoSupportedCodecError,
  probeSupportedCodec,
} from "./codec-probe.js";
import type { IsConfigSupportedFn } from "./video-encoder-factory.js";

const target: CodecProbeTarget = { width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30 };

/** Builds a fake `isConfigSupported` reporting only `supportedCodecs` as supported, recording every call's config. */
function createFakeIsConfigSupported(supportedCodecs: readonly string[]): {
  isConfigSupported: IsConfigSupportedFn;
  calls: VideoEncoderConfig[];
} {
  const calls: VideoEncoderConfig[] = [];
  const isConfigSupported: IsConfigSupportedFn = async (config) => {
    calls.push(config);
    return { config, supported: supportedCodecs.includes(config.codec) };
  };
  return { isConfigSupported, calls };
}

describe("DEFAULT_CODEC_PREFERENCES", () => {
  it("is ordered AV1, then VP9, then H.264", () => {
    expect(DEFAULT_CODEC_PREFERENCES.map((preference) => preference.label)).toEqual([
      "AV1",
      "VP9",
      "H.264",
    ]);
  });

  it("uses well-formed WebCodecs codec strings for each entry", () => {
    const codecs = DEFAULT_CODEC_PREFERENCES.map((preference) => preference.codec);
    expect(codecs).toEqual(["av01.0.08M.08", "vp09.00.10.08", "avc1.42001f"]);
    // Format sanity checks per codec family, not just literal equality:
    // av01.<profile>.<level><tier>.<bitdepth>
    expect(codecs[0]).toMatch(/^av01\.\d\.\d{2}[MH]\.\d{2}$/);
    // vp09.<profile>.<level>.<bitdepth>
    expect(codecs[1]).toMatch(/^vp09\.\d{2}\.\d{2}\.\d{2}$/);
    // avc1.<6 hex digits: profile_idc, constraint flags, level_idc>
    expect(codecs[2]).toMatch(/^avc1\.[0-9a-fA-F]{6}$/);
  });
});

describe("probeSupportedCodec: selection order", () => {
  it("selects the first supported codec in preference order when all are supported", async () => {
    const { isConfigSupported, calls } = createFakeIsConfigSupported([
      "av01.0.08M.08",
      "vp09.00.10.08",
      "avc1.42001f",
    ]);

    const config = await probeSupportedCodec(DEFAULT_CODEC_PREFERENCES, target, isConfigSupported);

    expect(config.codec).toBe("av01.0.08M.08");
    // Only the first (AV1) is ever probed once it is found supported: no
    // reason to keep checking further down the preference list.
    expect(calls).toHaveLength(1);
  });

  it("falls through to the second preference when the first is unsupported", async () => {
    const { isConfigSupported, calls } = createFakeIsConfigSupported(["vp09.00.10.08"]);

    const config = await probeSupportedCodec(DEFAULT_CODEC_PREFERENCES, target, isConfigSupported);

    expect(config.codec).toBe("vp09.00.10.08");
    expect(calls.map((call) => call.codec)).toEqual(["av01.0.08M.08", "vp09.00.10.08"]);
  });

  it("falls through to the last preference when only it is supported", async () => {
    const { isConfigSupported, calls } = createFakeIsConfigSupported(["avc1.42001f"]);

    const config = await probeSupportedCodec(DEFAULT_CODEC_PREFERENCES, target, isConfigSupported);

    expect(config.codec).toBe("avc1.42001f");
    expect(calls.map((call) => call.codec)).toEqual([
      "av01.0.08M.08",
      "vp09.00.10.08",
      "avc1.42001f",
    ]);
  });

  it("passes width/height/bitrate/framerate through unchanged on every probed config", async () => {
    const { isConfigSupported, calls } = createFakeIsConfigSupported(["avc1.42001f"]);

    await probeSupportedCodec(DEFAULT_CODEC_PREFERENCES, target, isConfigSupported);

    for (const call of calls) {
      expect(call.width).toBe(target.width);
      expect(call.height).toBe(target.height);
      expect(call.bitrate).toBe(target.bitrate);
      expect(call.framerate).toBe(target.framerate);
    }
  });

  it("respects a caller-supplied custom preference list instead of the default", async () => {
    const customPreferences: CodecPreference[] = [
      { label: "Custom", codec: "vp09.00.10.08" },
      { label: "AV1", codec: "av01.0.08M.08" },
    ];
    const { isConfigSupported, calls } = createFakeIsConfigSupported([
      "av01.0.08M.08",
      "vp09.00.10.08",
    ]);

    const config = await probeSupportedCodec(customPreferences, target, isConfigSupported);

    // "Custom" (vp09) is listed first in this caller's own preference order,
    // so it wins even though av01 is also supported.
    expect(config.codec).toBe("vp09.00.10.08");
    expect(calls).toHaveLength(1);
  });
});

describe("probeSupportedCodec: no supported codec", () => {
  it("throws NoSupportedCodecError when none of the preferences are supported", async () => {
    const { isConfigSupported } = createFakeIsConfigSupported([]);

    await expect(
      probeSupportedCodec(DEFAULT_CODEC_PREFERENCES, target, isConfigSupported),
    ).rejects.toThrow(NoSupportedCodecError);
  });

  it("probes every preference exactly once before giving up", async () => {
    const { isConfigSupported, calls } = createFakeIsConfigSupported([]);

    await expect(
      probeSupportedCodec(DEFAULT_CODEC_PREFERENCES, target, isConfigSupported),
    ).rejects.toThrow();

    expect(calls.map((call) => call.codec)).toEqual([
      "av01.0.08M.08",
      "vp09.00.10.08",
      "avc1.42001f",
    ]);
  });

  it("includes every tried codec's label and string in the error message", async () => {
    const { isConfigSupported } = createFakeIsConfigSupported([]);

    await expect(
      probeSupportedCodec(DEFAULT_CODEC_PREFERENCES, target, isConfigSupported),
    ).rejects.toThrow(
      /AV1 \(av01\.0\.08M\.08\).*VP9 \(vp09\.00\.10\.08\).*H\.264 \(avc1\.42001f\)/s,
    );
  });
});
