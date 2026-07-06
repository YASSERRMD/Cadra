import { describe, expect, it } from "vitest";

import { DEFAULT_AUDIO_CODEC_PREFERENCES } from "./audio-codec-probe.js";
import { DEFAULT_CODEC_PREFERENCES } from "./codec-probe.js";
import {
  toMp4AudioCodec,
  toMp4VideoCodec,
  toWebmAudioCodec,
  toWebmVideoCodec,
  UnsupportedMuxAudioCodecError,
  UnsupportedMuxCodecError,
  Vp8NotSupportedInMp4Error,
} from "./mux-codec-mapping.js";

describe("toMp4VideoCodec", () => {
  it("maps every DEFAULT_CODEC_PREFERENCES entry (AV1, VP9, H.264) to its mp4-muxer enum value", () => {
    const [av1, vp9, h264] = DEFAULT_CODEC_PREFERENCES;
    expect(toMp4VideoCodec(av1!.codec)).toBe("av1");
    expect(toMp4VideoCodec(vp9!.codec)).toBe("vp9");
    expect(toMp4VideoCodec(h264!.codec)).toBe("avc");
  });

  it("maps an avc3 (in-band parameter sets) codec string to 'avc', same as avc1", () => {
    expect(toMp4VideoCodec("avc3.42001f")).toBe("avc");
  });

  it("maps hvc1/hev1 (HEVC) codec strings to 'hevc'", () => {
    expect(toMp4VideoCodec("hvc1.1.6.L93.B0")).toBe("hevc");
    expect(toMp4VideoCodec("hev1.1.6.L93.B0")).toBe("hevc");
  });

  it("throws Vp8NotSupportedInMp4Error for a VP8 codec string", () => {
    expect(() => toMp4VideoCodec("vp08.00.10.08")).toThrow(Vp8NotSupportedInMp4Error);
  });

  it("throws UnsupportedMuxCodecError for an unrecognized codec string", () => {
    expect(() => toMp4VideoCodec("opus")).toThrow(UnsupportedMuxCodecError);
    expect(() => toMp4VideoCodec("opus")).toThrow(/opus/);
  });
});

describe("toWebmVideoCodec", () => {
  it("maps every DEFAULT_CODEC_PREFERENCES entry (AV1, VP9, H.264) to its Matroska codec ID", () => {
    const [av1, vp9, h264] = DEFAULT_CODEC_PREFERENCES;
    expect(toWebmVideoCodec(av1!.codec)).toBe("V_AV1");
    expect(toWebmVideoCodec(vp9!.codec)).toBe("V_VP9");
    expect(toWebmVideoCodec(h264!.codec)).toBe("V_MPEG4/ISO/AVC");
  });

  it("maps a VP8 codec string to 'V_VP8' (unlike toMp4VideoCodec, this is a supported combination)", () => {
    expect(toWebmVideoCodec("vp08.00.10.08")).toBe("V_VP8");
  });

  it("maps hvc1/hev1 (HEVC) codec strings to 'V_MPEGH/ISO/HEVC'", () => {
    expect(toWebmVideoCodec("hvc1.1.6.L93.B0")).toBe("V_MPEGH/ISO/HEVC");
    expect(toWebmVideoCodec("hev1.1.6.L93.B0")).toBe("V_MPEGH/ISO/HEVC");
  });

  it("throws UnsupportedMuxCodecError for an unrecognized codec string", () => {
    expect(() => toWebmVideoCodec("opus")).toThrow(UnsupportedMuxCodecError);
  });
});

describe("toMp4AudioCodec", () => {
  it("maps the AAC entry from DEFAULT_AUDIO_CODEC_PREFERENCES to mp4-muxer's 'aac'", () => {
    const aac = DEFAULT_AUDIO_CODEC_PREFERENCES.find((preference) => preference.label === "AAC");
    expect(toMp4AudioCodec(aac!.codec)).toBe("aac");
  });

  it("maps an 'opus' codec string to mp4-muxer's 'opus'", () => {
    expect(toMp4AudioCodec("opus")).toBe("opus");
  });

  it("throws UnsupportedMuxAudioCodecError for an unrecognized codec string", () => {
    expect(() => toMp4AudioCodec("av01.0.08M.08")).toThrow(UnsupportedMuxAudioCodecError);
    expect(() => toMp4AudioCodec("av01.0.08M.08")).toThrow(/av01\.0\.08M\.08/);
  });
});

describe("toWebmAudioCodec", () => {
  it("maps the Opus entry from DEFAULT_AUDIO_CODEC_PREFERENCES to webm-muxer's 'A_OPUS'", () => {
    const opus = DEFAULT_AUDIO_CODEC_PREFERENCES.find((preference) => preference.label === "Opus");
    expect(toWebmAudioCodec(opus!.codec)).toBe("A_OPUS");
  });

  it("maps a 'mp4a.40.2' (AAC) codec string to webm-muxer's 'A_AAC'", () => {
    expect(toWebmAudioCodec("mp4a.40.2")).toBe("A_AAC");
  });

  it("throws UnsupportedMuxAudioCodecError for an unrecognized codec string", () => {
    expect(() => toWebmAudioCodec("vp09.00.10.08")).toThrow(UnsupportedMuxAudioCodecError);
  });
});
