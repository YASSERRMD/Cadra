import { afterEach, describe, expect, it, vi } from "vitest";

import { detectWebCodecsSupport, getGlobalVideoFrameConstructor } from "./video-frame-factory.js";

describe("detectWebCodecsSupport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when VideoFrame is undefined (this Node/Vitest environment's real state)", () => {
    expect(detectWebCodecsSupport()).toBe(false);
  });

  it("returns true when VideoFrame is stubbed as a global", () => {
    vi.stubGlobal("VideoFrame", class {});
    expect(detectWebCodecsSupport()).toBe(true);
  });
});

describe("getGlobalVideoFrameConstructor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns undefined when VideoFrame is undefined (this Node/Vitest environment's real state)", () => {
    expect(getGlobalVideoFrameConstructor()).toBeUndefined();
  });

  it("returns the stubbed global VideoFrame constructor when present", () => {
    class FakeVideoFrame {}
    vi.stubGlobal("VideoFrame", FakeVideoFrame);
    expect(getGlobalVideoFrameConstructor()).toBe(FakeVideoFrame);
  });
});
