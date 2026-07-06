import { describe, expect, it, vi } from "vitest";

import type { AudioCodecPreference } from "./audio-codec-probe.js";
import { NoSupportedAudioCodecError } from "./audio-codec-probe.js";
import type { AudioEncoderConstructor, IsAudioConfigSupportedFn } from "./audio-encoder-factory.js";
import {
  DEFAULT_AUDIO_CHUNK_FRAMES,
  DEFAULT_MAX_AUDIO_QUEUE_SIZE,
  encodeAudio,
  type EncodeAudioOptions,
  type EncodedAudioChunkResult,
  WebCodecsUnavailableForAudioEncodingError,
} from "./encode-audio.js";
import type { AudioBufferLike } from "./offline-audio-context-like.js";

/**
 * Flushes microtasks until `condition()` is true, or gives up after
 * `maxTicks`. Mirrors `encode-frames.test.ts`'s own `flushUntil` (same
 * rationale: `encodeAudio` chains several `await`s per chunk, so the exact
 * microtask-hop count is an implementation detail these tests should not
 * hardcode).
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

/** One `encoder.encode()` call recorded by `createFakeAudioEncoder`. */
interface FakeEncodeCall {
  data: AudioData;
}

/**
 * A fake, controllable `AudioEncoder`: mirrors `encode-frames.test.ts`'s own
 * `createFakeVideoEncoder` structurally (same `encodeQueueSize`/`dequeue`
 * event contract, same flush-holding option), but for the `AudioEncoder`/
 * `AudioData`/`EncodedAudioChunk` surface.
 */
function createFakeAudioEncoder(options: { holdFlush?: boolean } = {}): {
  AudioEncoderConstructor: AudioEncoderConstructor;
  configureCalls: AudioEncoderConfig[];
  encodeCalls: FakeEncodeCall[];
  flushCalls: number;
  closeCalls: number;
  setQueueSize: (size: number) => void;
  fireDequeue: () => void;
  fireOutput: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => void;
  fireError: (error: DOMException) => void;
  resolveFlush: () => void;
  rejectFlush: (error: Error) => void;
} {
  const holdFlush = options.holdFlush ?? false;
  const configureCalls: AudioEncoderConfig[] = [];
  const encodeCalls: FakeEncodeCall[] = [];
  let flushCalls = 0;
  let closeCalls = 0;
  let queueSize = 0;
  const dequeueListeners = new Set<() => void>();
  let outputCallback: EncodedAudioChunkOutputCallback | undefined;
  let errorCallback: WebCodecsErrorCallback | undefined;
  let flushResolve: (() => void) | undefined;
  let flushReject: ((error: Error) => void) | undefined;

  class FakeAudioEncoder {
    // Same rationale as encode-frames.test.ts's own FakeVideoEncoder: a
    // prototype-level getter is the only way encodeQueueSize reflects live
    // state rather than freezing at construction time.
    declare readonly encodeQueueSize: number;

    constructor(init: AudioEncoderInit) {
      outputCallback = init.output;
      errorCallback = init.error;
    }

    configure(config: AudioEncoderConfig): void {
      configureCalls.push(config);
    }

    encode(data: AudioData): void {
      encodeCalls.push({ data });
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

  Object.defineProperty(FakeAudioEncoder.prototype, "encodeQueueSize", {
    get() {
      return queueSize;
    },
  });

  return {
    AudioEncoderConstructor: FakeAudioEncoder as unknown as AudioEncoderConstructor,
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

/** A fake, controllable `AudioData` constructor: records every construction and close() call. */
function createFakeAudioDataConstructor(): {
  constructorCalls: AudioDataInit[];
  closeCounts: () => number[];
  AudioDataConstructor: new (init: AudioDataInit) => AudioData;
} {
  const constructorCalls: AudioDataInit[] = [];
  const closeCounts: number[] = [];

  class FakeAudioData {
    timestamp: number;
    numberOfFrames: number;
    numberOfChannels: number;
    sampleRate: number;
    format: AudioSampleFormat;
    #index: number;

    constructor(init: AudioDataInit) {
      this.#index = constructorCalls.length;
      constructorCalls.push(init);
      closeCounts.push(0);
      this.timestamp = init.timestamp;
      this.numberOfFrames = init.numberOfFrames;
      this.numberOfChannels = init.numberOfChannels;
      this.sampleRate = init.sampleRate;
      this.format = init.format;
    }

    close(): void {
      closeCounts[this.#index] = (closeCounts[this.#index] ?? 0) + 1;
    }

    // Not exercised by encodeAudio itself (it only calls .close()), but
    // declared to keep this fake shaped like a real AudioData for
    // TypeScript's structural check against the real interface.
    allocationSize(): number {
      return 0;
    }
    clone(): AudioData {
      throw new Error("not implemented in this fake");
    }
    copyTo(): void {
      // No-op: encodeAudio never reads a chunk's own bytes back out
      // through this fake.
    }
  }

  return {
    constructorCalls,
    closeCounts: () => [...closeCounts],
    // Cast is required: FakeAudioData deliberately implements only the
    // members encodeAudio's chunkAudioBuffer actually constructs/reads
    // (timestamp/numberOfFrames/numberOfChannels/sampleRate/format/close),
    // not AudioData's full real surface.
    AudioDataConstructor: FakeAudioData as unknown as new (init: AudioDataInit) => AudioData,
  };
}

/** A fake `EncodedAudioChunk`: identity-only, enough for `toBe` comparisons. */
function createFakeChunk(label: string): EncodedAudioChunk {
  return { label } as unknown as EncodedAudioChunk;
}

/**
 * Replaces `AudioEncoderConstructor.prototype.encode` with `implementation`
 * for the duration of the current test. Mirrors
 * `encode-frames.test.ts`'s own `mockEncodeImplementation`.
 */
function mockEncodeImplementation(
  audioEncoderConstructor: AudioEncoderConstructor,
  implementation: AudioEncoder["encode"],
): void {
  vi.spyOn<AudioEncoder, "encode">(
    audioEncoderConstructor.prototype,
    "encode",
  ).mockImplementation(implementation);
}

/** A fake `AudioBufferLike` with deterministic, per-channel ramp content: channel c's sample i is `c * 1000 + i`. */
function createFakeAudioBuffer(options: {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
}): AudioBufferLike {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < options.numberOfChannels; channel += 1) {
    const data = new Float32Array(options.length);
    for (let i = 0; i < options.length; i += 1) {
      data[i] = channel * 1000 + i;
    }
    channels.push(data);
  }
  return {
    duration: options.length / options.sampleRate,
    length: options.length,
    numberOfChannels: options.numberOfChannels,
    sampleRate: options.sampleRate,
    getChannelData: (channel: number) => {
      const data = channels[channel];
      if (data === undefined) {
        throw new Error(`test setup error: no channel ${channel}`);
      }
      return data;
    },
  };
}

/** Base options for `encodeAudio` with a fake encoder, fake AudioData constructor, and always-supported codec probing injected. */
function withFakeEncoder(
  overrides: Partial<EncodeAudioOptions> = {},
  fakeEncoderOptions: { holdFlush?: boolean } = {},
): EncodeAudioOptions & {
  fake: ReturnType<typeof createFakeAudioEncoder>;
  fakeAudioData: ReturnType<typeof createFakeAudioDataConstructor>;
} {
  const fake = createFakeAudioEncoder(fakeEncoderOptions);
  const fakeAudioData = createFakeAudioDataConstructor();
  const isConfigSupported: IsAudioConfigSupportedFn = async (config) => ({ config, supported: true });
  return {
    container: "mp4",
    bitrate: 128_000,
    audioEncoderConstructor: fake.AudioEncoderConstructor,
    audioDataConstructor: fakeAudioData.AudioDataConstructor,
    isConfigSupported,
    fake,
    fakeAudioData,
    ...overrides,
  };
}

describe("encodeAudio: codec probing and configuration", () => {
  it("selects the AAC preference when container is mp4", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 100, sampleRate: 48_000 });
    const { fake, ...options } = withFakeEncoder({ container: "mp4" });

    for await (const _result of encodeAudio(buffer, options)) {
      // Drain.
    }

    expect(fake.configureCalls).toHaveLength(1);
    expect(fake.configureCalls[0]?.codec).toBe("mp4a.40.2");
    expect(fake.configureCalls[0]?.numberOfChannels).toBe(1);
    expect(fake.configureCalls[0]?.sampleRate).toBe(48_000);
    expect(fake.configureCalls[0]?.bitrate).toBe(128_000);
  });

  it("selects the Opus preference when container is webm", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 2, length: 100, sampleRate: 48_000 });
    const { fake, ...options } = withFakeEncoder({ container: "webm" });

    for await (const _result of encodeAudio(buffer, options)) {
      // Drain.
    }

    expect(fake.configureCalls[0]?.codec).toBe("opus");
    expect(fake.configureCalls[0]?.numberOfChannels).toBe(2);
  });

  it("throws NoSupportedAudioCodecError when the container's codec preference is unsupported", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 100, sampleRate: 48_000 });
    const { fake: _fake, ...options } = withFakeEncoder({
      container: "mp4",
      isConfigSupported: async (config) => ({ config, supported: false }),
    });

    const generator = encodeAudio(buffer, options);
    await expect(generator.next()).rejects.toThrow(NoSupportedAudioCodecError);
  });

  it("throws WebCodecsUnavailableForAudioEncodingError when no constructor/isConfigSupported/AudioData is available", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 100, sampleRate: 48_000 });
    const options: EncodeAudioOptions = { container: "mp4", bitrate: 128_000 };

    const generator = encodeAudio(buffer, options);
    await expect(generator.next()).rejects.toThrow(WebCodecsUnavailableForAudioEncodingError);
  });

  it("uses a caller-supplied custom codec preference list instead of the default", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 100, sampleRate: 48_000 });
    const customPreferences: AudioCodecPreference[] = [
      { label: "Custom AAC", codec: "mp4a.40.5", container: "mp4" },
    ];
    const { fake, ...options } = withFakeEncoder({ codecPreferences: customPreferences });

    for await (const _result of encodeAudio(buffer, options)) {
      // Drain.
    }

    expect(fake.configureCalls[0]?.codec).toBe("mp4a.40.5");
  });
});

describe("encodeAudio: chunking", () => {
  it("splits the buffer into DEFAULT_AUDIO_CHUNK_FRAMES-sized chunks, with a shorter final chunk", async () => {
    expect(DEFAULT_AUDIO_CHUNK_FRAMES).toBe(1024);
    const length = DEFAULT_AUDIO_CHUNK_FRAMES * 2 + 100;
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length, sampleRate: 48_000 });
    const { fake, fakeAudioData, ...options } = withFakeEncoder();

    for await (const _result of encodeAudio(buffer, options)) {
      // Drain.
    }

    expect(fake.encodeCalls).toHaveLength(3);
    expect(fakeAudioData.constructorCalls.map((call) => call.numberOfFrames)).toEqual([
      DEFAULT_AUDIO_CHUNK_FRAMES,
      DEFAULT_AUDIO_CHUNK_FRAMES,
      100,
    ]);
  });

  it("respects a caller-supplied chunkFrames size", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 300, sampleRate: 48_000 });
    const { fakeAudioData, ...options } = withFakeEncoder({ chunkFrames: 100 });

    for await (const _result of encodeAudio(buffer, options)) {
      // Drain.
    }

    expect(fakeAudioData.constructorCalls.map((call) => call.numberOfFrames)).toEqual([100, 100, 100]);
  });

  it("constructs each AudioData with format f32-planar and the buffer's own sampleRate/numberOfChannels", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 2, length: 50, sampleRate: 44_100 });
    const { fakeAudioData, ...options } = withFakeEncoder();

    for await (const _result of encodeAudio(buffer, options)) {
      // Drain.
    }

    expect(fakeAudioData.constructorCalls).toHaveLength(1);
    expect(fakeAudioData.constructorCalls[0]?.format).toBe("f32-planar");
    expect(fakeAudioData.constructorCalls[0]?.sampleRate).toBe(44_100);
    expect(fakeAudioData.constructorCalls[0]?.numberOfChannels).toBe(2);
  });

  it("computes each chunk's timestamp in whole microseconds from its sample offset", async () => {
    const sampleRate = 48_000;
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 200, sampleRate });
    const { fakeAudioData, ...options } = withFakeEncoder({ chunkFrames: 100 });

    for await (const _result of encodeAudio(buffer, options)) {
      // Drain.
    }

    // Chunk 0 starts at sample 0 (0 microseconds); chunk 1 starts at sample
    // 100 (100/48000 seconds = ~2083.33 microseconds, rounded).
    expect(fakeAudioData.constructorCalls.map((call) => call.timestamp)).toEqual([
      0,
      Math.round((100 / sampleRate) * 1_000_000),
    ]);
  });

  it("lays out planar data as every sample of channel 0 followed by every sample of channel 1", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 2, length: 4, sampleRate: 48_000 });
    const { fakeAudioData, ...options } = withFakeEncoder({ chunkFrames: 4 });

    for await (const _result of encodeAudio(buffer, options)) {
      // Drain.
    }

    // createFakeAudioBuffer's own ramp: channel 0 is [0, 1, 2, 3], channel 1
    // is [1000, 1001, 1002, 1003].
    const planar = fakeAudioData.constructorCalls[0]?.data as Float32Array;
    expect(Array.from(planar)).toEqual([0, 1, 2, 3, 1000, 1001, 1002, 1003]);
  });

  it("closes every constructed AudioData exactly once, immediately after encode()", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 300, sampleRate: 48_000 });
    const { fakeAudioData, ...options } = withFakeEncoder({ chunkFrames: 100 });

    for await (const _result of encodeAudio(buffer, options)) {
      // Drain.
    }

    expect(fakeAudioData.closeCounts()).toEqual([1, 1, 1]);
  });

  it("produces zero chunks (and never configures/calls encode) for an empty buffer", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 0, sampleRate: 48_000 });
    const { fake, ...options } = withFakeEncoder();

    const results = [];
    for await (const result of encodeAudio(buffer, options)) {
      results.push(result);
    }

    expect(results).toHaveLength(0);
    expect(fake.encodeCalls).toHaveLength(0);
    // The encoder is still configured (codec probing/configure always runs
    // regardless of chunk count) and flushed/closed, just never fed any
    // chunk to encode.
    expect(fake.configureCalls).toHaveLength(1);
    expect(fake.closeCalls).toBe(1);
  });
});

describe("encodeAudio: backpressure", () => {
  it("does not pull/encode the next chunk while encodeQueueSize is at or above maxQueueSize", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 300, sampleRate: 48_000 });
    const maxQueueSize = 2;
    const { fake, ...options } = withFakeEncoder({ chunkFrames: 100, maxQueueSize });
    fake.setQueueSize(0);
    let encodeCallCount = 0;
    mockEncodeImplementation(fake.AudioEncoderConstructor, (data) => {
      fake.encodeCalls.push({ data });
      encodeCallCount += 1;
      if (encodeCallCount === 1) {
        fake.setQueueSize(2);
      }
      if (encodeCallCount === 2) {
        fake.fireOutput(createFakeChunk(`chunk-${data.timestamp}`));
      }
    });

    const generator = encodeAudio(buffer, options);
    const pending = generator.next();

    await flushUntil(() => fake.encodeCalls.length >= 1);
    await flushUntil(() => false, 20);
    expect(fake.encodeCalls).toHaveLength(1);

    fake.fireDequeue();
    await flushUntil(() => false, 20);
    expect(fake.encodeCalls).toHaveLength(1);

    fake.setQueueSize(1);
    fake.fireDequeue();
    const firstResult = await pending;

    expect(firstResult.done).toBe(false);
    expect(fake.encodeCalls).toHaveLength(2);

    for await (const _result of generator) {
      // Drain remaining chunk(s).
    }
    expect(fake.encodeCalls).toHaveLength(3);
  });

  it("proceeds immediately (no wait) when encodeQueueSize starts below maxQueueSize", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 200, sampleRate: 48_000 });
    const { fake, ...options } = withFakeEncoder({ chunkFrames: 100, maxQueueSize: 5 });
    fake.setQueueSize(0);

    for await (const _result of encodeAudio(buffer, options)) {
      // Drain.
    }

    expect(fake.encodeCalls).toHaveLength(2);
  });

  it("defaults maxQueueSize to DEFAULT_MAX_AUDIO_QUEUE_SIZE when not supplied", async () => {
    expect(DEFAULT_MAX_AUDIO_QUEUE_SIZE).toBe(4);

    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 200, sampleRate: 48_000 });
    const { fake, ...options } = withFakeEncoder({ chunkFrames: 100 });
    fake.setQueueSize(0);
    mockEncodeImplementation(fake.AudioEncoderConstructor, (data) => {
      fake.encodeCalls.push({ data });
      fake.setQueueSize(DEFAULT_MAX_AUDIO_QUEUE_SIZE);
    });

    const generator = encodeAudio(buffer, options);
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

describe("encodeAudio: chunk collection", () => {
  it("yields EncodedAudioChunkResults in submission order with the right chunkIndex/chunk/metadata", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 400, sampleRate: 48_000 });
    const { fake, ...options } = withFakeEncoder({ chunkFrames: 100 });

    const chunks = [0, 1, 2, 3].map((index) => createFakeChunk(`chunk-${index}`));
    const metadataForChunk2: EncodedAudioChunkMetadata = {
      decoderConfig: { codec: "mp4a.40.2", numberOfChannels: 1, sampleRate: 48_000 },
    };

    let call = 0;
    mockEncodeImplementation(fake.AudioEncoderConstructor, (data) => {
      const index = call;
      fake.encodeCalls.push({ data });
      const chunk = chunks[index];
      if (chunk !== undefined) {
        fake.fireOutput(chunk, index === 2 ? metadataForChunk2 : undefined);
      }
      call += 1;
    });

    const results: EncodedAudioChunkResult[] = [];
    for await (const result of encodeAudio(buffer, options)) {
      results.push(result);
    }

    expect(results.map((result) => result.chunkIndex)).toEqual([0, 1, 2, 3]);
    expect(results.map((result) => result.chunk)).toEqual(chunks);
    expect(results[2]?.metadata).toBe(metadataForChunk2);
    expect(results[0]?.metadata).toBeUndefined();
  });

  it("flushes chunks that only arrive during encoder.flush(), after input is exhausted", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 200, sampleRate: 48_000 });
    const { fake, ...options } = withFakeEncoder({ chunkFrames: 100 }, { holdFlush: true });
    const lateChunk0 = createFakeChunk("late-0");
    const lateChunk1 = createFakeChunk("late-1");

    const generator = encodeAudio(buffer, options);
    const results: EncodedAudioChunkResult[] = [];
    const iterationDone = (async () => {
      for await (const result of generator) {
        results.push(result);
      }
    })();

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
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 300, sampleRate: 48_000 });
    const { fake, ...options } = withFakeEncoder({ chunkFrames: 100 }, { holdFlush: true });

    const generator = encodeAudio(buffer, options);
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
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 500, sampleRate: 48_000 });
    const { fake, ...options } = withFakeEncoder({ chunkFrames: 100 });
    mockEncodeImplementation(fake.AudioEncoderConstructor, (data) => {
      fake.encodeCalls.push({ data });
      fake.fireOutput(createFakeChunk(`chunk-${data.timestamp}`));
    });

    let seen = 0;
    for await (const _result of encodeAudio(buffer, options)) {
      seen += 1;
      if (seen === 2) {
        break;
      }
    }

    expect(seen).toBe(2);
    expect(fake.closeCalls).toBe(1);
    expect(fake.flushCalls).toBe(0);
  });

  it("propagates an encoder error instead of hanging, and still closes the encoder", async () => {
    const buffer = createFakeAudioBuffer({ numberOfChannels: 1, length: 200, sampleRate: 48_000 });
    const { fake, ...options } = withFakeEncoder({ chunkFrames: 100, maxQueueSize: 1 });
    fake.setQueueSize(1);

    const generator = encodeAudio(buffer, options);
    const firstStep = generator.next();
    await flushUntil(() => false, 10);

    const encodingError = new DOMException("simulated encoder failure", "EncodingError");
    fake.fireError(encodingError);

    await expect(firstStep).rejects.toThrow(/simulated encoder failure/);
    expect(fake.closeCalls).toBe(1);
  });
});
