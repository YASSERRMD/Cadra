import { frameToTime } from "@cadra/core";
import { describe, expect, it, vi } from "vitest";

import type {
  DecodeVideo,
  LoadVideoDependencies,
  SampleAtTimestamp,
  SampleVideoFrameDependencies,
  VideoSource,
} from "./video-loader.js";
import { loadVideo, sampleVideoFrame } from "./video-loader.js";

function createFakeVideoSource(label: string): VideoSource {
  return { label };
}

function createFakeSampledFrame(label: string): ImageBitmap {
  return { label } as unknown as ImageBitmap;
}

describe("loadVideo", () => {
  it("fetches bytes, then decodes them into a seekable source", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const source = createFakeVideoSource("decoded-source");
    const callOrder: string[] = [];
    const deps: LoadVideoDependencies = {
      fetchBytes: vi.fn(async () => {
        callOrder.push("fetchBytes");
        return bytes;
      }),
      decodeVideo: vi.fn(async () => {
        callOrder.push("decodeVideo");
        return source;
      }) as unknown as DecodeVideo,
    };

    const result = await loadVideo("https://example.test/clip.mp4", deps);

    expect(callOrder).toEqual(["fetchBytes", "decodeVideo"]);
    expect(result.source).toBe(source);
    expect(typeof result.hash).toBe("string");
  });

  it("produces the same hash for byte-identical video content from different urls", async () => {
    const bytes = new Uint8Array([42, 42, 42]);
    const depsA: LoadVideoDependencies = {
      fetchBytes: vi.fn().mockResolvedValue(bytes),
      decodeVideo: vi.fn().mockResolvedValue(createFakeVideoSource("a")) as unknown as DecodeVideo,
    };
    const depsB: LoadVideoDependencies = {
      fetchBytes: vi.fn().mockResolvedValue(bytes),
      decodeVideo: vi.fn().mockResolvedValue(createFakeVideoSource("b")) as unknown as DecodeVideo,
    };

    const resultA = await loadVideo("https://example.test/a.mp4", depsA);
    const resultB = await loadVideo("https://example.test/b.mp4", depsB);

    expect(resultA.hash).toBe(resultB.hash);
  });

  it("propagates a decodeVideo rejection", async () => {
    const failure = new Error("unsupported codec");
    const deps: LoadVideoDependencies = {
      fetchBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
      decodeVideo: vi.fn().mockRejectedValue(failure) as unknown as DecodeVideo,
    };

    await expect(loadVideo("https://example.test/clip.mp4", deps)).rejects.toThrow(failure);
  });
});

describe("sampleVideoFrame", () => {
  it("computes the timestamp from frame/fps using frameToTime and calls sampleAtTimestamp with it", async () => {
    const source = createFakeVideoSource("source");
    const sampled = createFakeSampledFrame("frame-45");
    const sampleAtTimestamp = vi.fn().mockResolvedValue(sampled) as unknown as SampleAtTimestamp;
    const deps: SampleVideoFrameDependencies = { sampleAtTimestamp };

    const result = await sampleVideoFrame(source, 45, 30, deps);

    // frame 45 at 30fps: 1.5s exactly. The orchestration must derive this
    // via frameToTime rather than any independent, possibly-diverging
    // computation, so this asserts against frameToTime's own output, not a
    // hardcoded literal.
    const expectedTimestamp = frameToTime(45, 30);
    expect(sampleAtTimestamp).toHaveBeenCalledWith(source, expectedTimestamp);
    expect(sampleAtTimestamp).toHaveBeenCalledTimes(1);
    expect(result).toBe(sampled);
  });

  it("computes distinct timestamps for distinct frames at the same fps", async () => {
    const source = createFakeVideoSource("source");
    const sampleAtTimestamp = vi
      .fn()
      .mockResolvedValue(createFakeSampledFrame("x")) as unknown as SampleAtTimestamp;
    const deps: SampleVideoFrameDependencies = { sampleAtTimestamp };

    await sampleVideoFrame(source, 0, 24, deps);
    await sampleVideoFrame(source, 24, 24, deps);
    await sampleVideoFrame(source, 48, 24, deps);

    expect(sampleAtTimestamp).toHaveBeenNthCalledWith(1, source, 0);
    expect(sampleAtTimestamp).toHaveBeenNthCalledWith(2, source, 1);
    expect(sampleAtTimestamp).toHaveBeenNthCalledWith(3, source, 2);
  });

  it("is deterministic: the same frame/fps pair always requests the same timestamp", async () => {
    const source = createFakeVideoSource("source");
    const sampleAtTimestampMock = vi.fn().mockResolvedValue(createFakeSampledFrame("x"));
    const deps: SampleVideoFrameDependencies = {
      sampleAtTimestamp: sampleAtTimestampMock as unknown as SampleAtTimestamp,
    };

    await sampleVideoFrame(source, 100, 23.976, deps);
    await sampleVideoFrame(source, 100, 23.976, deps);

    const [firstCallArgs, secondCallArgs] = sampleAtTimestampMock.mock.calls as Array<
      [VideoSource, number]
    >;
    expect(firstCallArgs?.[1]).toBe(secondCallArgs?.[1]);
  });

  it("never derives the timestamp from a real-time playback clock: only frame and fps are consulted", async () => {
    // There is no wall-clock input to this function at all (no Date.now,
    // no video-element currentTime read); this test documents that
    // guarantee by confirming the result depends purely on its (frame, fps)
    // arguments across repeated calls, matching sampleVideoFrame's module
    // doc. Real video-element real-time seeking cannot be exercised in this
    // headless environment, so this is the feasible proxy for it here.
    const source = createFakeVideoSource("source");
    const sampleAtTimestampMock = vi.fn().mockResolvedValue(createFakeSampledFrame("x"));
    const deps: SampleVideoFrameDependencies = {
      sampleAtTimestamp: sampleAtTimestampMock as unknown as SampleAtTimestamp,
    };

    await sampleVideoFrame(source, 10, 30, deps);
    const [, firstTimestamp] = sampleAtTimestampMock.mock.calls[0] as [VideoSource, number];

    await new Promise((resolve) => setTimeout(resolve, 5));
    await sampleVideoFrame(source, 10, 30, deps);
    const [, secondTimestamp] = sampleAtTimestampMock.mock.calls[1] as [VideoSource, number];

    expect(firstTimestamp).toBe(secondTimestamp);
  });

  it("propagates a sampleAtTimestamp rejection", async () => {
    const failure = new Error("seek out of range");
    const sampleAtTimestamp = vi.fn().mockRejectedValue(failure) as unknown as SampleAtTimestamp;
    const deps: SampleVideoFrameDependencies = { sampleAtTimestamp };

    await expect(sampleVideoFrame(createFakeVideoSource("s"), 1, 30, deps)).rejects.toThrow(
      failure,
    );
  });
});
