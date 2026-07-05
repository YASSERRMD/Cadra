import { describe, expect, it, vi } from "vitest";

import type { DecodeAudio, LoadAudioDependencies } from "./audio-loader.js";
import { loadAudio } from "./audio-loader.js";

function createFakeAudioBuffer(label: string): AudioBuffer {
  return { label } as unknown as AudioBuffer;
}

describe("loadAudio", () => {
  it("fetches bytes, then decodes them into an audio buffer", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const buffer = createFakeAudioBuffer("decoded-buffer");
    const callOrder: string[] = [];
    const deps: LoadAudioDependencies = {
      fetchBytes: vi.fn(async () => {
        callOrder.push("fetchBytes");
        return bytes;
      }),
      decodeAudio: vi.fn(async () => {
        callOrder.push("decodeAudio");
        return buffer;
      }) as unknown as DecodeAudio,
    };

    const result = await loadAudio("https://example.test/track.mp3", deps);

    expect(callOrder).toEqual(["fetchBytes", "decodeAudio"]);
    expect(result.buffer).toBe(buffer);
    expect(typeof result.hash).toBe("string");
  });

  it("produces the same hash for byte-identical audio content", async () => {
    const bytes = new Uint8Array([9, 9, 9, 9]);
    const depsA: LoadAudioDependencies = {
      fetchBytes: vi.fn().mockResolvedValue(bytes),
      decodeAudio: vi.fn().mockResolvedValue(createFakeAudioBuffer("a")) as unknown as DecodeAudio,
    };
    const depsB: LoadAudioDependencies = {
      fetchBytes: vi.fn().mockResolvedValue(bytes),
      decodeAudio: vi.fn().mockResolvedValue(createFakeAudioBuffer("b")) as unknown as DecodeAudio,
    };

    const resultA = await loadAudio("https://example.test/a.mp3", depsA);
    const resultB = await loadAudio("https://example.test/b.mp3", depsB);

    expect(resultA.hash).toBe(resultB.hash);
  });

  it("propagates a decodeAudio rejection", async () => {
    const failure = new Error("unsupported audio format");
    const deps: LoadAudioDependencies = {
      fetchBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
      decodeAudio: vi.fn().mockRejectedValue(failure) as unknown as DecodeAudio,
    };

    await expect(loadAudio("https://example.test/track.mp3", deps)).rejects.toThrow(failure);
  });
});
