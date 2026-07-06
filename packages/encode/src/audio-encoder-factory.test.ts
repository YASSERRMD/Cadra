import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getGlobalAudioEncoderConstructor,
  getGlobalIsAudioConfigSupported,
} from "./audio-encoder-factory.js";

describe("getGlobalAudioEncoderConstructor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns undefined when AudioEncoder is undefined (this Node/Vitest environment's real state)", () => {
    expect(getGlobalAudioEncoderConstructor()).toBeUndefined();
  });

  it("returns the stubbed global AudioEncoder constructor when present", () => {
    class FakeAudioEncoder {}
    vi.stubGlobal("AudioEncoder", FakeAudioEncoder);
    expect(getGlobalAudioEncoderConstructor()).toBe(FakeAudioEncoder);
  });
});

describe("getGlobalIsAudioConfigSupported", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns undefined when AudioEncoder is undefined (this Node/Vitest environment's real state)", () => {
    expect(getGlobalIsAudioConfigSupported()).toBeUndefined();
  });

  it("returns a callable bound to the stubbed global AudioEncoder.isConfigSupported when present", async () => {
    const isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    class FakeAudioEncoder {
      static isConfigSupported = isConfigSupported;
    }
    vi.stubGlobal("AudioEncoder", FakeAudioEncoder);

    const bound = getGlobalIsAudioConfigSupported();
    expect(bound).toBeDefined();
    const config: AudioEncoderConfig = { codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 48_000 };
    await bound?.(config);
    expect(isConfigSupported).toHaveBeenCalledWith(config);
  });
});
