import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultOfflineAudioContextLike } from "./offline-audio-context-like.js";

describe("createDefaultOfflineAudioContextLike", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("constructs a real OfflineAudioContext with the given channel count, length, and sample rate", () => {
    const constructorCalls: Array<{
      numberOfChannels: number;
      length: number;
      sampleRate: number;
    }> = [];

    class FakeOfflineAudioContext {
      constructor(numberOfChannels: number, length: number, sampleRate: number) {
        constructorCalls.push({ numberOfChannels, length, sampleRate });
      }
    }
    vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);

    const context = createDefaultOfflineAudioContextLike({
      numberOfChannels: 2,
      length: 48_000,
      sampleRate: 48_000,
    });

    expect(context).toBeInstanceOf(FakeOfflineAudioContext);
    expect(constructorCalls).toEqual([{ numberOfChannels: 2, length: 48_000, sampleRate: 48_000 }]);
  });
});
