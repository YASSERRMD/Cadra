import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getGlobalIsConfigSupported,
  getGlobalVideoEncoderConstructor,
} from "./video-encoder-factory.js";

describe("getGlobalVideoEncoderConstructor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns undefined when VideoEncoder is undefined (this Node/Vitest environment's real state)", () => {
    expect(getGlobalVideoEncoderConstructor()).toBeUndefined();
  });

  it("returns the stubbed global VideoEncoder constructor when present", () => {
    class FakeVideoEncoder {}
    vi.stubGlobal("VideoEncoder", FakeVideoEncoder);
    expect(getGlobalVideoEncoderConstructor()).toBe(FakeVideoEncoder);
  });
});

describe("getGlobalIsConfigSupported", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns undefined when VideoEncoder is undefined (this Node/Vitest environment's real state)", () => {
    expect(getGlobalIsConfigSupported()).toBeUndefined();
  });

  it("returns a callable bound to the stubbed global VideoEncoder.isConfigSupported when present", async () => {
    const isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    class FakeVideoEncoder {
      static isConfigSupported = isConfigSupported;
    }
    vi.stubGlobal("VideoEncoder", FakeVideoEncoder);

    const bound = getGlobalIsConfigSupported();
    expect(bound).toBeDefined();
    const config: VideoEncoderConfig = { codec: "avc1.42001f", width: 1920, height: 1080 };
    await bound?.(config);
    expect(isConfigSupported).toHaveBeenCalledWith(config);
  });
});
