import type { RenderedFrame } from "@cadra/headless";
import type { PixelBuffer } from "@cadra/renderer";
import { describe, expect, it } from "vitest";

import {
  captureFrames,
  type CaptureFramesOptions,
  DEFAULT_CAPTURE_COLOR_SPACE,
} from "./capture-frames.js";
import { frameToMicrosecondTimestamp } from "./capture-timestamp.js";
import type { VideoFrameConstructor } from "./video-frame-factory.js";

/** Builds a `PixelBuffer` with deterministic, distinguishable byte content for a given frame index. */
function createPixelBuffer(frame: number, width = 4, height = 4): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  // Fill with a value derived from the frame index so buffers are
  // distinguishable across frames in assertions.
  data.fill(frame % 256);
  return { width, height, data };
}

/** Yields `count` fake `RenderedFrame`s, frame indices 0..count-1, in order. */
async function* fakeRenderedFrames(count: number): AsyncGenerator<RenderedFrame> {
  for (let frame = 0; frame < count; frame += 1) {
    yield { frame, pixels: createPixelBuffer(frame) };
  }
}

/** One constructor-call record captured by `createFakeVideoFrameConstructor`. */
interface FakeVideoFrameConstruction {
  data: AllowSharedBufferSource;
  init: VideoFrameBufferInit;
}

/**
 * A fake `VideoFrame` constructor: every instance records its constructor
 * arguments and decrements a shared live-instance counter on `.close()`,
 * so tests can assert both "what was passed to the constructor" and "no
 * leaks" (the counter returns to exactly 0 once every yielded instance is
 * closed).
 */
function createFakeVideoFrameConstructor(): {
  VideoFrameConstructor: VideoFrameConstructor;
  constructions: FakeVideoFrameConstruction[];
  liveInstanceCount: () => number;
} {
  const constructions: FakeVideoFrameConstruction[] = [];
  let liveInstances = 0;

  class FakeVideoFrame {
    readonly format: VideoPixelFormat;
    readonly codedWidth: number;
    readonly codedHeight: number;
    readonly timestamp: number;
    readonly colorSpace: VideoColorSpaceInit;
    private closed = false;

    constructor(data: AllowSharedBufferSource, init: VideoFrameBufferInit) {
      constructions.push({ data, init });
      this.format = init.format;
      this.codedWidth = init.codedWidth;
      this.codedHeight = init.codedHeight;
      this.timestamp = init.timestamp;
      this.colorSpace = init.colorSpace ?? {};
      liveInstances += 1;
    }

    close(): void {
      if (this.closed) {
        return;
      }
      this.closed = true;
      liveInstances -= 1;
    }
  }

  return {
    // Cast is required: the real WebCodecs `VideoFrame` interface declares
    // many more readonly members (codedRect, duration, visibleRect,
    // allocationSize, clone, copyTo) than this fake needs to exercise
    // captureFrames's own conversion/timestamp/lifecycle logic, which is
    // this suite's actual target, not real WebCodecs decode/encode
    // correctness.
    VideoFrameConstructor: FakeVideoFrame as unknown as VideoFrameConstructor,
    constructions,
    liveInstanceCount: () => liveInstances,
  };
}

/** Base options for `captureFrames`, with a fake WebCodecs-available constructor injected. */
function withFakeVideoFrame(overrides: Partial<CaptureFramesOptions> = {}): CaptureFramesOptions & {
  fake: ReturnType<typeof createFakeVideoFrameConstructor>;
} {
  const fake = createFakeVideoFrameConstructor();
  return {
    fps: 30,
    detectWebCodecs: () => true,
    videoFrameConstructor: fake.VideoFrameConstructor,
    fake,
    ...overrides,
  };
}

describe("captureFrames: frame count and order", () => {
  it("emits exactly durationInFrames CapturedFrames, in order", async () => {
    const durationInFrames = 7;
    const { fake: _fake, ...options } = withFakeVideoFrame();

    const captured = [];
    for await (const item of captureFrames(fakeRenderedFrames(durationInFrames), options)) {
      if (item.kind === "video-frame") {
        item.videoFrame.close();
      }
      captured.push(item);
    }

    expect(captured).toHaveLength(durationInFrames);
    expect(captured.map((item) => item.frame)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("emits zero CapturedFrames for a zero-frame source", async () => {
    const { fake, ...options } = withFakeVideoFrame();

    const captured = [];
    for await (const item of captureFrames(fakeRenderedFrames(0), options)) {
      captured.push(item);
    }

    expect(captured).toHaveLength(0);
    expect(fake.liveInstanceCount()).toBe(0);
  });
});

describe("captureFrames: timestamp math", () => {
  it("computes the same timestamp as frameToMicrosecondTimestamp for every frame", async () => {
    const durationInFrames = 10;
    const fps = 24;
    const { fake: _fake, ...options } = withFakeVideoFrame({ fps });

    const captured = [];
    for await (const item of captureFrames(fakeRenderedFrames(durationInFrames), options)) {
      if (item.kind === "video-frame") {
        item.videoFrame.close();
      }
      captured.push(item);
    }

    for (const item of captured) {
      expect(item.timestamp).toBe(frameToMicrosecondTimestamp(item.frame, fps));
    }
  });

  it("yields strictly increasing timestamps across consecutive frames", async () => {
    const { fake: _fake, ...options } = withFakeVideoFrame({ fps: 60 });

    const timestamps: number[] = [];
    for await (const item of captureFrames(fakeRenderedFrames(20), options)) {
      if (item.kind === "video-frame") {
        item.videoFrame.close();
      }
      timestamps.push(item.timestamp);
    }

    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]!);
    }
  });
});

describe("captureFrames: VideoFrame construction", () => {
  it("passes format RGBA, correct codedWidth/codedHeight/timestamp/colorSpace to the constructor", async () => {
    const fps = 30;
    const { fake, ...options } = withFakeVideoFrame({ fps });

    for await (const item of captureFrames(fakeRenderedFrames(3), options)) {
      if (item.kind === "video-frame") {
        item.videoFrame.close();
      }
    }

    expect(fake.constructions).toHaveLength(3);
    fake.constructions.forEach((construction, frame) => {
      expect(construction.init.format).toBe("RGBA");
      expect(construction.init.codedWidth).toBe(4);
      expect(construction.init.codedHeight).toBe(4);
      expect(construction.init.timestamp).toBe(frameToMicrosecondTimestamp(frame, fps));
      expect(construction.init.colorSpace).toEqual(DEFAULT_CAPTURE_COLOR_SPACE);
    });
  });

  it("passes the PixelBuffer's own raw data as the buffer source", async () => {
    const { fake, ...options } = withFakeVideoFrame();
    const source = fakeRenderedFrames(1);

    for await (const item of captureFrames(source, options)) {
      if (item.kind === "video-frame") {
        item.videoFrame.close();
      }
    }

    expect(fake.constructions[0]!.data).toBeInstanceOf(Uint8ClampedArray);
  });

  it("uses a caller-supplied colorSpace override instead of the default", async () => {
    const overrideColorSpace: VideoColorSpaceInit = {
      primaries: "smpte170m",
      transfer: "smpte170m",
      matrix: "smpte170m",
      fullRange: false,
    };
    const { fake, ...options } = withFakeVideoFrame({ colorSpace: overrideColorSpace });

    for await (const item of captureFrames(fakeRenderedFrames(1), options)) {
      if (item.kind === "video-frame") {
        item.videoFrame.close();
      }
    }

    expect(fake.constructions[0]!.init.colorSpace).toEqual(overrideColorSpace);
  });

  it("yields the CapturedVideoFrame's own timestamp/frame matching the constructed VideoFrame", async () => {
    const fps = 24;
    const { fake, ...options } = withFakeVideoFrame({ fps });

    for await (const item of captureFrames(fakeRenderedFrames(2), options)) {
      expect(item.kind).toBe("video-frame");
      if (item.kind === "video-frame") {
        expect(item.videoFrame.timestamp).toBe(item.timestamp);
        item.videoFrame.close();
      }
    }

    expect(fake.liveInstanceCount()).toBe(0);
  });
});

describe("captureFrames: no leaks", () => {
  it("returns to exactly zero live instances after closing every yielded VideoFrame across a full render", async () => {
    const { fake, ...options } = withFakeVideoFrame({ fps: 30 });
    const durationInFrames = 15;

    let closedCount = 0;
    for await (const item of captureFrames(fakeRenderedFrames(durationInFrames), options)) {
      expect(item.kind).toBe("video-frame");
      if (item.kind === "video-frame") {
        // Model the consumer: "use" the frame (a no-op here), then close it,
        // exactly as a real VideoEncoder.encode(frame) caller would after
        // encoding finishes with it.
        item.videoFrame.close();
        closedCount += 1;
      }
    }

    expect(closedCount).toBe(durationInFrames);
    expect(fake.constructions).toHaveLength(durationInFrames);
    expect(fake.liveInstanceCount()).toBe(0);
  });

  it("leaves no un-closed instances behind when the consumer closes each frame then breaks early", async () => {
    const { fake, ...options } = withFakeVideoFrame({ fps: 30 });
    const stopAfter = 4;

    let seen = 0;
    for await (const item of captureFrames(fakeRenderedFrames(20), options)) {
      if (item.kind === "video-frame") {
        item.videoFrame.close();
      }
      seen += 1;
      if (seen === stopAfter) {
        break;
      }
    }

    expect(seen).toBe(stopAfter);
    // Only the frames actually yielded (and closed) before the break were
    // ever constructed: captureFrames constructs one VideoFrame immediately
    // before yielding it, so breaking early after frame `stopAfter` means
    // exactly `stopAfter` constructions happened and every one was closed.
    expect(fake.constructions).toHaveLength(stopAfter);
    expect(fake.liveInstanceCount()).toBe(0);
  });

  it("does not construct further frames once the consumer has broken out (module's own internal state does not leak)", async () => {
    const { fake, ...options } = withFakeVideoFrame({ fps: 30 });
    const generator = captureFrames(fakeRenderedFrames(50), options);

    let count = 0;
    for await (const item of generator) {
      if (item.kind === "video-frame") {
        item.videoFrame.close();
      }
      count += 1;
      if (count === 3) {
        break;
      }
    }

    const constructionsAtBreak = fake.constructions.length;
    expect(constructionsAtBreak).toBe(3);

    // Nothing further should happen if the now-finished generator is
    // iterated again: a generator that already ran its return()/finally to
    // completion yields no more items and constructs nothing further.
    const remaining = [];
    for await (const item of generator) {
      remaining.push(item);
    }
    expect(remaining).toHaveLength(0);
    expect(fake.constructions.length).toBe(constructionsAtBreak);
    expect(fake.liveInstanceCount()).toBe(0);
  });
});

describe("captureFrames: fallback path (WebCodecs unavailable)", () => {
  it("yields the raw PixelBuffer instead of a VideoFrame for every frame when unavailable", async () => {
    const fps = 30;
    const options: CaptureFramesOptions = {
      fps,
      detectWebCodecs: () => false,
    };

    const captured = [];
    for await (const item of captureFrames(fakeRenderedFrames(5), options)) {
      captured.push(item);
    }

    expect(captured).toHaveLength(5);
    for (const item of captured) {
      expect(item.kind).toBe("pixel-buffer");
    }
  });

  it("carries the same correct frame/timestamp values as the VideoFrame path would", async () => {
    const fps = 24;
    const options: CaptureFramesOptions = {
      fps,
      detectWebCodecs: () => false,
    };

    const captured = [];
    for await (const item of captureFrames(fakeRenderedFrames(4), options)) {
      captured.push(item);
    }

    captured.forEach((item, frame) => {
      expect(item.frame).toBe(frame);
      expect(item.timestamp).toBe(frameToMicrosecondTimestamp(frame, fps));
    });
  });

  it("passes through the source frame's exact PixelBuffer object (dimensions and data)", async () => {
    const options: CaptureFramesOptions = {
      fps: 30,
      detectWebCodecs: () => false,
    };

    for await (const item of captureFrames(fakeRenderedFrames(1), options)) {
      expect(item.kind).toBe("pixel-buffer");
      if (item.kind === "pixel-buffer") {
        expect(item.pixels.width).toBe(4);
        expect(item.pixels.height).toBe(4);
        expect(item.pixels.data).toBeInstanceOf(Uint8ClampedArray);
        expect(item.pixels.data.length).toBe(4 * 4 * 4);
      }
    }
  });

  it("never constructs a VideoFrame even if a constructor is also supplied", async () => {
    const { fake } = withFakeVideoFrame();
    const options: CaptureFramesOptions = {
      fps: 30,
      detectWebCodecs: () => false,
      videoFrameConstructor: fake.VideoFrameConstructor,
    };

    for await (const item of captureFrames(fakeRenderedFrames(6), options)) {
      expect(item.kind).toBe("pixel-buffer");
    }

    expect(fake.constructions).toHaveLength(0);
  });

  it("falls back automatically via the real detectWebCodecsSupport default in this Node/Vitest environment", async () => {
    // No detectWebCodecs override: exercises the real default, which is
    // false in this environment since there is no global VideoFrame.
    const options: CaptureFramesOptions = { fps: 30 };

    const captured = [];
    for await (const item of captureFrames(fakeRenderedFrames(2), options)) {
      captured.push(item);
    }

    expect(captured).toHaveLength(2);
    for (const item of captured) {
      expect(item.kind).toBe("pixel-buffer");
    }
  });
});
