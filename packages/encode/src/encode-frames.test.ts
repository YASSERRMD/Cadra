import { describe, expect, it, vi } from "vitest";

import type { CapturedVideoFrame } from "./capture-frames.js";
import type { CodecPreference } from "./codec-probe.js";
import { NoSupportedCodecError } from "./codec-probe.js";
import {
  DEFAULT_KEYFRAME_INTERVAL_FRAMES,
  DEFAULT_MAX_QUEUE_SIZE,
  type EncodedChunkResult,
  encodeFrames,
  type EncodeFramesOptions,
  WebCodecsUnavailableForEncodingError,
} from "./encode-frames.js";
import type { IsConfigSupportedFn, VideoEncoderConstructor } from "./video-encoder-factory.js";

/**
 * Flushes microtasks (via `setTimeout(0)`, which only runs once the
 * microtask queue is fully drained) until `condition()` is true, or gives
 * up after `maxTicks` and returns `false`. Used instead of a fixed number of
 * `await Promise.resolve()` hops: `encodeFrames` chains several `await`s per
 * frame (codec probing, the backpressure check, the input generator's own
 * `yield`), so the exact microtask-hop count is an implementation detail
 * these tests should not hardcode.
 */
async function flushUntil(condition: () => boolean, maxTicks = 50): Promise<boolean> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return condition();
}

/** One `encoder.encode()` call recorded by `createFakeVideoEncoder`. */
interface FakeEncodeCall {
  frame: VideoFrame;
  options: VideoEncoderEncodeOptions | undefined;
}

/** A fake, controllable `VideoFrame`: just enough surface for `encodeFrames` to close it. */
function createFakeVideoFrame(frame: number): { videoFrame: VideoFrame; closeCount: () => number } {
  let closed = 0;
  const videoFrame = {
    timestamp: frame,
    close: () => {
      closed += 1;
    },
    // Cast is required: the real WebCodecs VideoFrame interface declares
    // many more members this fake never needs, matching
    // capture-frames.test.ts's own FakeVideoFrame cast rationale.
  } as unknown as VideoFrame;
  return { videoFrame, closeCount: () => closed };
}

/** Yields `count` fake `CapturedVideoFrame`s, frame indices 0..count-1, in order. */
async function* fakeCapturedFrames(
  count: number,
  frames: Map<number, VideoFrame>,
): AsyncGenerator<CapturedVideoFrame> {
  for (let frame = 0; frame < count; frame += 1) {
    const videoFrame = frames.get(frame);
    if (videoFrame === undefined) {
      throw new Error(`test setup error: no fake VideoFrame registered for frame ${frame}`);
    }
    yield { kind: "video-frame", frame, timestamp: frame, videoFrame };
  }
}

/**
 * A fake `VideoEncoder`: records every `configure`/`encode`/`flush`/`close`
 * call, and exposes direct control over `encodeQueueSize` plus a way to
 * fire `dequeue` events synchronously, mirroring the real WebCodecs
 * `VideoEncoder`'s `EventTarget`-based `dequeue` event contract closely
 * enough for `waitForQueueBelowThreshold` to exercise its real
 * addEventListener/removeEventListener logic (not a fake specific to it).
 */
function createFakeVideoEncoder(options: { holdFlush?: boolean } = {}): {
  VideoEncoderConstructor: VideoEncoderConstructor;
  configureCalls: VideoEncoderConfig[];
  encodeCalls: FakeEncodeCall[];
  flushCalls: number;
  closeCalls: number;
  setQueueSize: (size: number) => void;
  fireDequeue: () => void;
  fireOutput: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => void;
  fireError: (error: DOMException) => void;
  resolveFlush: () => void;
  rejectFlush: (error: Error) => void;
} {
  const holdFlush = options.holdFlush ?? false;
  const configureCalls: VideoEncoderConfig[] = [];
  const encodeCalls: FakeEncodeCall[] = [];
  let flushCalls = 0;
  let closeCalls = 0;
  let queueSize = 0;
  const dequeueListeners = new Set<() => void>();
  let outputCallback: EncodedVideoChunkOutputCallback | undefined;
  let errorCallback: WebCodecsErrorCallback | undefined;
  let flushResolve: (() => void) | undefined;
  let flushReject: ((error: Error) => void) | undefined;

  class FakeVideoEncoder {
    // Deliberately not declared as a class field: a field initializer would
    // create an own instance property that permanently shadows the
    // prototype-level getter defined below via Object.defineProperty,
    // freezing every instance's reading at its construction-time value
    // instead of reflecting live `queueSize` changes. Declared only via the
    // constructor's own type annotation-free cast below, so the real
    // getter is the sole source of this property.
    declare readonly encodeQueueSize: number;

    constructor(init: VideoEncoderInit) {
      outputCallback = init.output;
      errorCallback = init.error;
    }

    configure(config: VideoEncoderConfig): void {
      configureCalls.push(config);
    }

    encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): void {
      encodeCalls.push({ frame, options });
    }

    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type === "dequeue" && typeof listener === "function") {
        dequeueListeners.add(listener as () => void);
      }
    }

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type === "dequeue" && typeof listener === "function") {
        dequeueListeners.delete(listener as () => void);
      }
    }

    flush(): Promise<void> {
      flushCalls += 1;
      if (!holdFlush) {
        // Default behavior: resolve on the next microtask, modeling an
        // encoder with nothing left buffered once encode() has been called
        // for every frame. Tests exercising flush()'s own timing pass
        // holdFlush: true and drive resolveFlush/rejectFlush explicitly.
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        flushResolve = resolve;
        flushReject = reject;
      });
    }

    close(): void {
      closeCalls += 1;
    }
  }

  // `encodeQueueSize` must reflect live state on each read, which a plain
  // class field cannot do (it would freeze at construction time); defined
  // via a getter on the prototype instead so every instance always reads
  // the shared `queueSize` closure variable.
  Object.defineProperty(FakeVideoEncoder.prototype, "encodeQueueSize", {
    get() {
      return queueSize;
    },
  });

  return {
    VideoEncoderConstructor: FakeVideoEncoder as unknown as VideoEncoderConstructor,
    configureCalls,
    encodeCalls,
    get flushCalls() {
      return flushCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
    setQueueSize: (size: number) => {
      queueSize = size;
    },
    fireDequeue: () => {
      for (const listener of [...dequeueListeners]) {
        listener();
      }
    },
    fireOutput: (chunk, metadata) => {
      outputCallback?.(chunk, metadata);
    },
    fireError: (error) => {
      errorCallback?.(error);
    },
    resolveFlush: () => {
      flushResolve?.();
    },
    rejectFlush: (error: Error) => {
      flushReject?.(error);
    },
  };
}

/** A fake `EncodedVideoChunk`: identity-only, enough for `toBe` comparisons. */
function createFakeChunk(label: string): EncodedVideoChunk {
  return { label } as unknown as EncodedVideoChunk;
}

/**
 * Replaces `VideoEncoderConstructor.prototype.encode` with `implementation`
 * for the duration of the current test. A thin wrapper around
 * `vi.spyOn(...).mockImplementation(...)`: pre-typing `implementation` as
 * `VideoEncoder["encode"]` (rather than inline at each call site) is what
 * lets `mockImplementation` accept it without TypeScript widening its
 * parameters to `unknown` (a known `vi.spyOn` generic-inference gap against
 * a constructor's `.prototype`-typed target).
 */
function mockEncodeImplementation(
  videoEncoderConstructor: VideoEncoderConstructor,
  implementation: VideoEncoder["encode"],
): void {
  vi.spyOn<VideoEncoder, "encode">(videoEncoderConstructor.prototype, "encode").mockImplementation(
    implementation,
  );
}

/** Base options for `encodeFrames` with a fake encoder and always-supported codec probing injected. */
function withFakeEncoder(
  overrides: Partial<EncodeFramesOptions> = {},
  fakeEncoderOptions: { holdFlush?: boolean } = {},
): EncodeFramesOptions & { fake: ReturnType<typeof createFakeVideoEncoder> } {
  const fake = createFakeVideoEncoder(fakeEncoderOptions);
  const isConfigSupported: IsConfigSupportedFn = async (config) => ({ config, supported: true });
  return {
    width: 1920,
    height: 1080,
    bitrate: 8_000_000,
    framerate: 30,
    videoEncoderConstructor: fake.VideoEncoderConstructor,
    isConfigSupported,
    fake,
    ...overrides,
  };
}

/** Builds a `frame -> VideoFrame` map plus a way to read each one's close count, for a run of `count` frames. */
function buildFrameFixtures(count: number): {
  frames: Map<number, VideoFrame>;
  closeCounts: () => number[];
} {
  const frames = new Map<number, VideoFrame>();
  const trackers: Array<() => number> = [];
  for (let frame = 0; frame < count; frame += 1) {
    const { videoFrame, closeCount } = createFakeVideoFrame(frame);
    frames.set(frame, videoFrame);
    trackers.push(closeCount);
  }
  return { frames, closeCounts: () => trackers.map((tracker) => tracker()) };
}

describe("encodeFrames: codec probing and configuration", () => {
  it("selects the first supported codec (preference order) and configures the encoder with it", async () => {
    const { frames } = buildFrameFixtures(1);
    const { fake, ...options } = withFakeEncoder({
      isConfigSupported: async (config) => ({
        config,
        supported: config.codec === "vp09.00.10.08",
      }),
    });

    const results = [];
    for await (const result of encodeFrames(fakeCapturedFrames(1, frames), options)) {
      results.push(result);
    }

    expect(fake.configureCalls).toHaveLength(1);
    expect(fake.configureCalls[0]?.codec).toBe("vp09.00.10.08");
    expect(fake.configureCalls[0]?.width).toBe(1920);
    expect(fake.configureCalls[0]?.height).toBe(1080);
    expect(fake.configureCalls[0]?.bitrate).toBe(8_000_000);
    expect(fake.configureCalls[0]?.framerate).toBe(30);
  });

  it("throws a clear NoSupportedCodecError when no codec preference is supported", async () => {
    const { frames } = buildFrameFixtures(1);
    const { fake: _fake, ...options } = withFakeEncoder({
      isConfigSupported: async (config) => ({ config, supported: false }),
    });

    const generator = encodeFrames(fakeCapturedFrames(1, frames), options);
    await expect(generator.next()).rejects.toThrow(NoSupportedCodecError);
  });

  it("throws WebCodecsUnavailableForEncodingError when no constructor/isConfigSupported is available", async () => {
    const { frames } = buildFrameFixtures(1);
    const options: EncodeFramesOptions = {
      width: 1920,
      height: 1080,
      bitrate: 8_000_000,
      framerate: 30,
    };

    const generator = encodeFrames(fakeCapturedFrames(1, frames), options);
    await expect(generator.next()).rejects.toThrow(WebCodecsUnavailableForEncodingError);
  });

  it("uses a caller-supplied custom codec preference list instead of the default", async () => {
    const { frames } = buildFrameFixtures(1);
    const customPreferences: CodecPreference[] = [{ label: "Custom H.264", codec: "avc1.42001f" }];
    const { fake, ...options } = withFakeEncoder({ codecPreferences: customPreferences });

    for await (const _result of encodeFrames(fakeCapturedFrames(1, frames), options)) {
      // Drain.
    }

    expect(fake.configureCalls[0]?.codec).toBe("avc1.42001f");
  });
});

describe("encodeFrames: keyframe forcing", () => {
  it("forces keyFrame true at frame 0 and every keyframeIntervalFrames-th frame, false otherwise", async () => {
    const durationInFrames = 10;
    const keyframeIntervalFrames = 3;
    const { frames } = buildFrameFixtures(durationInFrames);
    const { fake, ...options } = withFakeEncoder({ keyframeIntervalFrames });

    for await (const _result of encodeFrames(
      fakeCapturedFrames(durationInFrames, frames),
      options,
    )) {
      // Drain: chunks are never emitted since fireOutput is never called in
      // this test, only encode() call shape is under test here.
    }

    expect(fake.encodeCalls).toHaveLength(durationInFrames);
    fake.encodeCalls.forEach((call, frame) => {
      const expectedKeyFrame = frame % keyframeIntervalFrames === 0;
      expect(call.options?.keyFrame).toBe(expectedKeyFrame);
    });
    // Frames 0, 3, 6, 9 are keyframes at interval 3.
    const keyframedFrames = fake.encodeCalls
      .map((call, frame) => (call.options?.keyFrame === true ? frame : undefined))
      .filter((frame): frame is number => frame !== undefined);
    expect(keyframedFrames).toEqual([0, 3, 6, 9]);
  });

  it("defaults keyframeIntervalFrames to DEFAULT_KEYFRAME_INTERVAL_FRAMES when not supplied", async () => {
    expect(DEFAULT_KEYFRAME_INTERVAL_FRAMES).toBe(30);

    const durationInFrames = 61;
    const { frames } = buildFrameFixtures(durationInFrames);
    const { fake, ...options } = withFakeEncoder();

    for await (const _result of encodeFrames(
      fakeCapturedFrames(durationInFrames, frames),
      options,
    )) {
      // Drain.
    }

    const keyframedFrames = fake.encodeCalls
      .map((call, frame) => (call.options?.keyFrame === true ? frame : undefined))
      .filter((frame): frame is number => frame !== undefined);
    expect(keyframedFrames).toEqual([0, 30, 60]);
  });

  it("always forces frame 0 as a keyframe even with a large interval", async () => {
    const { frames } = buildFrameFixtures(1);
    const { fake, ...options } = withFakeEncoder({ keyframeIntervalFrames: 1000 });

    for await (const _result of encodeFrames(fakeCapturedFrames(1, frames), options)) {
      // Drain.
    }

    expect(fake.encodeCalls[0]?.options?.keyFrame).toBe(true);
  });
});

describe("encodeFrames: frame closing", () => {
  it("closes every incoming videoFrame exactly once, immediately after encode()", async () => {
    const durationInFrames = 5;
    const { frames, closeCounts } = buildFrameFixtures(durationInFrames);
    const { fake, ...options } = withFakeEncoder();

    // Records, at the moment encode() is called for a given frame, whether
    // that same frame's videoFrame was already closed by then: proves
    // closing happens immediately after encode(), not batched at the end.
    const closedAtEncodeTime: boolean[] = [];
    const originalEncode = fake.encodeCalls.push.bind(fake.encodeCalls);
    let call = 0;
    mockEncodeImplementation(fake.VideoEncoderConstructor, (frame, opts) => {
      originalEncode({ frame, options: opts });
      // At this exact point (inside encode(), before encodeFrames's own
      // close() call below runs), the frame must not be closed yet.
      closedAtEncodeTime[call] = closeCounts()[call] !== 0;
      call += 1;
    });

    for await (const _result of encodeFrames(
      fakeCapturedFrames(durationInFrames, frames),
      options,
    )) {
      // Drain.
    }

    expect(closeCounts()).toEqual([1, 1, 1, 1, 1]);
    expect(closedAtEncodeTime).toEqual([false, false, false, false, false]);
  });

  it("closes a frame immediately even when backpressure delays the next frame's encode", async () => {
    const { frames, closeCounts } = buildFrameFixtures(2);
    const { fake, ...options } = withFakeEncoder({ maxQueueSize: 1 });
    // Queue starts empty so frame 0's pre-encode check passes; encode()
    // itself simulates the queue filling up as a result of that call, so
    // the pre-encode check before frame 1 is the one that actually blocks.
    fake.setQueueSize(0);
    mockEncodeImplementation(fake.VideoEncoderConstructor, (frame, opts) => {
      fake.encodeCalls.push({ frame, options: opts });
      fake.setQueueSize(1);
    });

    const generator = encodeFrames(fakeCapturedFrames(2, frames), options);
    const firstStep = generator.next();

    // Give the generator time to reach its backpressure wait before frame 1.
    await flushUntil(() => fake.encodeCalls.length >= 1);

    // Frame 0 must already be closed even though frame 1 has not been
    // pulled/encoded yet (blocked on backpressure).
    expect(closeCounts()[0]).toBe(1);
    expect(closeCounts()[1]).toBe(0);
    expect(fake.encodeCalls).toHaveLength(1);

    fake.setQueueSize(0);
    fake.fireDequeue();
    await firstStep;
    for await (const _result of generator) {
      // Drain the rest.
    }

    expect(closeCounts()).toEqual([1, 1]);
  });
});

describe("encodeFrames: backpressure", () => {
  it("does not pull/encode the next frame while encodeQueueSize is at or above maxQueueSize", async () => {
    const { frames } = buildFrameFixtures(3);
    const maxQueueSize = 2;
    const { fake, ...options } = withFakeEncoder({ maxQueueSize });
    // Queue starts empty so frame 0's pre-encode check passes; the first
    // encode() call simulates the queue filling to the threshold as a
    // result of that call, so it is the pre-encode check before frame 1
    // that blocks. Frame 1's encode() call fires its chunk immediately,
    // which is what lets `pending` (below) resolve exactly once frame 1 has
    // been pulled and encoded, rather than only once the whole generator
    // finishes (which would happen regardless of backpressure, since
    // nothing else in this test ever yields a chunk to stop at).
    fake.setQueueSize(0);
    let encodeCallCount = 0;
    mockEncodeImplementation(fake.VideoEncoderConstructor, (frame, opts) => {
      fake.encodeCalls.push({ frame, options: opts });
      encodeCallCount += 1;
      if (encodeCallCount === 1) {
        fake.setQueueSize(2);
      }
      if (encodeCallCount === 2) {
        fake.fireOutput(createFakeChunk(`chunk-${frame.timestamp}`));
      }
    });

    const generator = encodeFrames(fakeCapturedFrames(3, frames), options);
    const pending = generator.next();

    // Let the generator reach frame 0's encode, then give it a generous
    // settle window. If the implementation did not actually wait, frame 1
    // would already be encoded by now (proving an absence, so this
    // deliberately waits out a fixed budget rather than polling for a
    // positive condition).
    await flushUntil(() => fake.encodeCalls.length >= 1);
    await flushUntil(() => false, 20);
    expect(fake.encodeCalls).toHaveLength(1);
    expect(fake.encodeCalls[0]?.frame).toBe(frames.get(0));

    // Still blocked: queue size stays at threshold, dequeue fires, but that
    // alone must not be enough proceed past the threshold check.
    fake.fireDequeue();
    await flushUntil(() => false, 20);
    expect(fake.encodeCalls).toHaveLength(1);

    // Now actually drop the queue size below threshold and fire dequeue:
    // this must unblock the wait and let frame 1 proceed.
    fake.setQueueSize(1);
    fake.fireDequeue();
    const firstResult = await pending;

    expect(firstResult.done).toBe(false);
    expect(fake.encodeCalls).toHaveLength(2);
    expect(fake.encodeCalls[1]?.frame).toBe(frames.get(1));

    // Queue size is still 1 (below the threshold of 2), so frame 2's
    // pre-encode check passes immediately and the drain completes.
    for await (const _result of generator) {
      // Drain remaining frame(s).
    }
    expect(fake.encodeCalls).toHaveLength(3);
  });

  it("proceeds immediately (no wait) when encodeQueueSize starts below maxQueueSize", async () => {
    const { frames } = buildFrameFixtures(2);
    const { fake, ...options } = withFakeEncoder({ maxQueueSize: 5 });
    fake.setQueueSize(0);

    for await (const _result of encodeFrames(fakeCapturedFrames(2, frames), options)) {
      // Drain.
    }

    expect(fake.encodeCalls).toHaveLength(2);
  });

  it("defaults maxQueueSize to DEFAULT_MAX_QUEUE_SIZE when not supplied", async () => {
    expect(DEFAULT_MAX_QUEUE_SIZE).toBe(2);

    const { frames } = buildFrameFixtures(2);
    const { fake, ...options } = withFakeEncoder();
    // Queue starts empty so frame 0's pre-encode check passes; encode()
    // simulates the queue filling to the default threshold, so it is the
    // pre-encode check before frame 1 that blocks.
    fake.setQueueSize(0);
    mockEncodeImplementation(fake.VideoEncoderConstructor, (frame, opts) => {
      fake.encodeCalls.push({ frame, options: opts });
      fake.setQueueSize(DEFAULT_MAX_QUEUE_SIZE);
    });

    const generator = encodeFrames(fakeCapturedFrames(2, frames), options);
    const pending = generator.next();
    await flushUntil(() => fake.encodeCalls.length >= 1);
    expect(fake.encodeCalls).toHaveLength(1);

    fake.setQueueSize(0);
    fake.fireDequeue();
    await pending;
    for await (const _result of generator) {
      // Drain.
    }
    expect(fake.encodeCalls).toHaveLength(2);
  });
});

describe("encodeFrames: chunk collection", () => {
  it("yields EncodedChunkResults in frame order with the right frame/chunk/metadata", async () => {
    const durationInFrames = 4;
    const { frames } = buildFrameFixtures(durationInFrames);
    const { fake, ...options } = withFakeEncoder();

    const chunks = [0, 1, 2, 3].map((frame) => createFakeChunk(`chunk-${frame}`));
    const metadataForFrame2: EncodedVideoChunkMetadata = {
      decoderConfig: { codec: "vp09.00.10.08" },
    };

    // Deliver output for each frame right after its encode() call, in
    // encode order, mirroring a real encoder's FIFO output ordering.
    mockEncodeImplementation(fake.VideoEncoderConstructor, (frame) => {
      const frameIndex = frame.timestamp;
      fake.encodeCalls.push({ frame, options: undefined });
      const chunk = chunks[frameIndex];
      if (chunk === undefined) return;
      fake.fireOutput(chunk, frameIndex === 2 ? metadataForFrame2 : undefined);
    });

    const results = [];
    for await (const result of encodeFrames(
      fakeCapturedFrames(durationInFrames, frames),
      options,
    )) {
      results.push(result);
    }

    expect(results.map((result) => result.frame)).toEqual([0, 1, 2, 3]);
    expect(results.map((result) => result.chunk)).toEqual(chunks);
    expect(results[2]?.metadata).toBe(metadataForFrame2);
    expect(results[0]?.metadata).toBeUndefined();
    expect(results[1]?.metadata).toBeUndefined();
    expect(results[3]?.metadata).toBeUndefined();
  });

  it("preserves order/pairing with no reordering, dropping, or duplication (decodability proxy)", async () => {
    // Honest scope note: a real decodable bitstream cannot be produced or
    // verified in this environment (no real VideoEncoder). What this test
    // actually proves is that the sequence of (frame, chunk) pairs the fake
    // encoder's output callback delivers is preserved, in order, all the
    // way through to what encodeFrames yields: no reordering, dropping, or
    // duplication between output-callback delivery and generator yield.
    const durationInFrames = 6;
    const { frames } = buildFrameFixtures(durationInFrames);
    const { fake, ...options } = withFakeEncoder();
    const chunks = Array.from({ length: durationInFrames }, (_unused, frame) =>
      createFakeChunk(`c${frame}`),
    );

    mockEncodeImplementation(fake.VideoEncoderConstructor, (frame) => {
      const frameIndex = frame.timestamp;
      fake.encodeCalls.push({ frame, options: undefined });
      const chunk = chunks[frameIndex];
      if (chunk !== undefined) fake.fireOutput(chunk);
    });

    const results = [];
    for await (const result of encodeFrames(
      fakeCapturedFrames(durationInFrames, frames),
      options,
    )) {
      results.push(result);
    }

    expect(results).toHaveLength(durationInFrames);
    results.forEach((result, index) => {
      expect(result.frame).toBe(index);
      expect(result.chunk).toBe(chunks[index]);
    });
  });

  it("flushes chunks that only arrive during encoder.flush(), after input is exhausted", async () => {
    const durationInFrames = 2;
    const { frames } = buildFrameFixtures(durationInFrames);
    const { fake, ...options } = withFakeEncoder({}, { holdFlush: true });
    const lateChunk0 = createFakeChunk("late-0");
    const lateChunk1 = createFakeChunk("late-1");

    // Neither frame's output fires during encode(): both arrive only once
    // flush() is called, modeling an encoder buffering internally.
    const generator = encodeFrames(fakeCapturedFrames(durationInFrames, frames), options);
    const results: EncodedChunkResult[] = [];
    const iterationDone = (async () => {
      for await (const result of generator) {
        results.push(result);
      }
    })();

    // Let encode() calls happen for both frames, and flush() get called.
    await flushUntil(() => fake.flushCalls >= 1);
    expect(fake.encodeCalls).toHaveLength(2);
    expect(fake.flushCalls).toBe(1);

    fake.fireOutput(lateChunk0);
    fake.fireOutput(lateChunk1);
    fake.resolveFlush();
    await iterationDone;

    expect(results.map((result) => result.chunk)).toEqual([lateChunk0, lateChunk1]);
  });

  it("calls flush() and close() exactly once each, at the end of a full run", async () => {
    const durationInFrames = 3;
    const { frames } = buildFrameFixtures(durationInFrames);
    const { fake, ...options } = withFakeEncoder({}, { holdFlush: true });

    const generator = encodeFrames(fakeCapturedFrames(durationInFrames, frames), options);
    const resultsPromise = (async () => {
      const results = [];
      for await (const result of generator) {
        results.push(result);
      }
      return results;
    })();

    await flushUntil(() => fake.flushCalls >= 1);
    expect(fake.flushCalls).toBe(1);
    expect(fake.closeCalls).toBe(0);

    fake.resolveFlush();
    await resultsPromise;

    expect(fake.flushCalls).toBe(1);
    expect(fake.closeCalls).toBe(1);
  });

  it("calls close() exactly once on early termination (consumer breaks the loop), without calling flush()", async () => {
    const durationInFrames = 5;
    const { frames } = buildFrameFixtures(durationInFrames);
    const { fake, ...options } = withFakeEncoder();
    // Every encode() immediately produces a chunk, so the consumer's for
    // await loop below actually receives values to count and break on
    // (otherwise nothing is ever yielded until flush, defeating this
    // test's own "breaking early skips flush" premise).
    mockEncodeImplementation(fake.VideoEncoderConstructor, (frame, opts) => {
      fake.encodeCalls.push({ frame, options: opts });
      fake.fireOutput(createFakeChunk(`chunk-${frame.timestamp}`));
    });

    let seen = 0;
    for await (const _result of encodeFrames(
      fakeCapturedFrames(durationInFrames, frames),
      options,
    )) {
      seen += 1;
      if (seen === 2) {
        break;
      }
    }

    expect(seen).toBe(2);
    expect(fake.closeCalls).toBe(1);
    // flush() is only reached after the input generator is fully exhausted;
    // breaking early skips that path entirely.
    expect(fake.flushCalls).toBe(0);
  });

  it("propagates an encoder error instead of hanging, and still closes the encoder", async () => {
    const { frames } = buildFrameFixtures(2);
    const { fake, ...options } = withFakeEncoder({ maxQueueSize: 1 });
    fake.setQueueSize(1);

    const generator = encodeFrames(fakeCapturedFrames(2, frames), options);
    const firstStep = generator.next();
    // Give the generator time to reach its backpressure wait (queue size 1
    // is at the threshold of 1 from the very first frame, so it blocks
    // immediately) before injecting the error.
    await flushUntil(() => false, 10);

    const encodingError = new DOMException("simulated encoder failure", "EncodingError");
    fake.fireError(encodingError);

    await expect(firstStep).rejects.toThrow(/simulated encoder failure/);
    expect(fake.closeCalls).toBe(1);
  });
});
