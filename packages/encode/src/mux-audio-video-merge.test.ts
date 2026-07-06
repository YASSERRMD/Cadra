import { describe, expect, it } from "vitest";

import type { EncodedAudioChunkResult } from "./encode-audio.js";
import type { EncodedChunkResult } from "./encode-frames.js";
import { mergeVideoAndAudioChunks } from "./mux-audio-video-merge.js";

/** A fake `EncodedVideoChunk`/`EncodedAudioChunk`: identity-only, enough for equality assertions. */
function createFakeChunk(label: string): EncodedVideoChunk & EncodedAudioChunk {
  return { label } as unknown as EncodedVideoChunk & EncodedAudioChunk;
}

function makeVideoResult(frame: number): EncodedChunkResult {
  return { frame, chunk: createFakeChunk(`video-${frame}`), metadata: undefined };
}

function makeAudioResult(chunkIndex: number): EncodedAudioChunkResult {
  return { chunkIndex, chunk: createFakeChunk(`audio-${chunkIndex}`), metadata: undefined };
}

/**
 * Yields `results`, resolving each index's own `next()` only once
 * `release(index)` is called, so a test can control interleaving
 * precisely. Every index's resolver is registered eagerly at construction
 * time (not lazily inside the generator body when it happens to reach that
 * iteration): `release(index)` must be safe to call at any point relative
 * to when `mergeVideoAndAudioChunks` itself gets around to pulling that
 * index, including before the generator body has even started running.
 */
function createControlledGenerator<T>(results: readonly T[]): {
  generator: AsyncGenerator<T>;
  release: (index: number) => void;
  returnCallCount: () => number;
} {
  const resolvers: Array<() => void> = [];
  const gates: Promise<void>[] = results.map(
    (_result, index) =>
      new Promise<void>((resolve) => {
        resolvers[index] = resolve;
      }),
  );
  let returnCalls = 0;
  async function* generatorImpl(): AsyncGenerator<T> {
    try {
      for (let index = 0; index < results.length; index += 1) {
        await gates[index];
        yield results[index] as T;
      }
    } finally {
      returnCalls += 1;
    }
  }
  return {
    generator: generatorImpl(),
    release: (index: number) => {
      resolvers[index]?.();
    },
    returnCallCount: () => returnCalls,
  };
}

/** Yields every value in `values` immediately (no artificial delay), for tests that don't need to control interleaving. */
async function* immediateGenerator<T>(values: readonly T[]): AsyncGenerator<T> {
  for (const value of values) {
    yield value;
  }
}

describe("mergeVideoAndAudioChunks: basic merging", () => {
  it("yields every video result tagged kind: 'video' and every audio result tagged kind: 'audio'", async () => {
    const videoResults = [makeVideoResult(0), makeVideoResult(1)];
    const audioResults = [makeAudioResult(0), makeAudioResult(1)];

    const merged = [];
    for await (const item of mergeVideoAndAudioChunks(
      immediateGenerator(videoResults),
      immediateGenerator(audioResults),
    )) {
      merged.push(item);
    }

    const video = merged.filter((item) => item.kind === "video").map((item) => item.result);
    const audio = merged.filter((item) => item.kind === "audio").map((item) => item.result);
    expect(video).toEqual(videoResults);
    expect(audio).toEqual(audioResults);
    expect(merged).toHaveLength(4);
  });

  it("preserves each track's own internal order (video results in video order, audio results in audio order)", async () => {
    const videoResults = [makeVideoResult(0), makeVideoResult(1), makeVideoResult(2)];
    const audioResults = [makeAudioResult(0), makeAudioResult(1)];

    const merged = [];
    for await (const item of mergeVideoAndAudioChunks(
      immediateGenerator(videoResults),
      immediateGenerator(audioResults),
    )) {
      merged.push(item);
    }

    const videoFrames = merged
      .filter((item) => item.kind === "video")
      .map((item) => (item.result as EncodedChunkResult).frame);
    const audioIndices = merged
      .filter((item) => item.kind === "audio")
      .map((item) => (item.result as EncodedAudioChunkResult).chunkIndex);
    expect(videoFrames).toEqual([0, 1, 2]);
    expect(audioIndices).toEqual([0, 1]);
  });

  it("continues draining the remaining source alone once the other is exhausted", async () => {
    const videoResults = [makeVideoResult(0)];
    const audioResults = [makeAudioResult(0), makeAudioResult(1), makeAudioResult(2)];

    const merged = [];
    for await (const item of mergeVideoAndAudioChunks(
      immediateGenerator(videoResults),
      immediateGenerator(audioResults),
    )) {
      merged.push(item);
    }

    expect(merged).toHaveLength(4);
    const audioCount = merged.filter((item) => item.kind === "audio").length;
    expect(audioCount).toBe(3);
  });

  it("yields nothing for two empty sources", async () => {
    const merged = [];
    for await (const item of mergeVideoAndAudioChunks(
      immediateGenerator<EncodedChunkResult>([]),
      immediateGenerator<EncodedAudioChunkResult>([]),
    )) {
      merged.push(item);
    }
    expect(merged).toHaveLength(0);
  });

  it("yields only video results when the audio source is empty", async () => {
    const videoResults = [makeVideoResult(0), makeVideoResult(1)];

    const merged = [];
    for await (const item of mergeVideoAndAudioChunks(
      immediateGenerator(videoResults),
      immediateGenerator<EncodedAudioChunkResult>([]),
    )) {
      merged.push(item);
    }

    expect(merged.every((item) => item.kind === "video")).toBe(true);
    expect(merged).toHaveLength(2);
  });
});

describe("mergeVideoAndAudioChunks: concurrent pulling", () => {
  it("yields a value the instant it becomes available, without waiting for the other source", async () => {
    const videoResults = [makeVideoResult(0)];
    const audioResults = [makeAudioResult(0)];
    const video = createControlledGenerator(videoResults);
    const audio = createControlledGenerator(audioResults);

    const merged: Array<{ kind: string }> = [];
    const iterationDone = (async () => {
      for await (const item of mergeVideoAndAudioChunks(video.generator, audio.generator)) {
        merged.push(item);
      }
    })();

    // Release only the audio side; video's next() is left pending. If
    // mergeVideoAndAudioChunks waited on both sources before yielding
    // anything, merged would still be empty here.
    audio.release(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind).toBe("audio");

    video.release(0);
    await iterationDone;
    expect(merged).toHaveLength(2);
  });
});

describe("mergeVideoAndAudioChunks: early termination", () => {
  /**
   * Wraps `source` in a generator that yields the same values but records
   * whether/how many times `.return()` was called on it, via a `finally`
   * block. Every value is available immediately (no artificial delay): a
   * `.return()` call queued behind an already-in-flight, unresolved
   * `next()` call does not run until that `next()` itself settles (an
   * inherent property of the async generator protocol, not a bug in
   * `mergeVideoAndAudioChunks`), so this test's own sources must never
   * leave a `next()` permanently pending, or `.return()` could never be
   * observed to complete.
   */
  function trackReturnCalls<T>(values: readonly T[]): {
    generator: AsyncGenerator<T>;
    returnCallCount: () => number;
  } {
    let returnCalls = 0;
    async function* generatorImpl(): AsyncGenerator<T> {
      try {
        for (const value of values) {
          yield value;
        }
      } finally {
        returnCalls += 1;
      }
    }
    return { generator: generatorImpl(), returnCallCount: () => returnCalls };
  }

  it("calls return() on both source generators when the consumer breaks its for-await loop", async () => {
    const video = trackReturnCalls([makeVideoResult(0), makeVideoResult(1), makeVideoResult(2)]);
    const audio = trackReturnCalls([makeAudioResult(0), makeAudioResult(1), makeAudioResult(2)]);

    let seen = 0;
    for await (const _item of mergeVideoAndAudioChunks(video.generator, audio.generator)) {
      seen += 1;
      if (seen === 2) {
        break;
      }
    }

    expect(seen).toBe(2);
    expect(video.returnCallCount()).toBe(1);
    expect(audio.returnCallCount()).toBe(1);
  });

  it("calls return() only on the source that has not yet been exhausted", async () => {
    // Video has only 1 item (exhausted after the first merge cycle);
    // audio has several more still available when the consumer breaks.
    const video = trackReturnCalls([makeVideoResult(0)]);
    const audio = trackReturnCalls([makeAudioResult(0), makeAudioResult(1), makeAudioResult(2)]);

    let seen = 0;
    for await (const _item of mergeVideoAndAudioChunks(video.generator, audio.generator)) {
      seen += 1;
      if (seen === 3) {
        break;
      }
    }

    // video's own generator naturally finished (its own for-of loop body
    // completed), which already runs its finally block exactly once,
    // whether or not mergeVideoAndAudioChunks also calls .return() on an
    // already-finished generator (calling .return() on a generator that
    // has already run to completion is a no-op per the language spec, not
    // a second finally invocation), so this asserts finally ran exactly
    // once for video and exactly once for audio, not "was .return()
    // specifically called" for the already-exhausted side.
    expect(video.returnCallCount()).toBe(1);
    expect(audio.returnCallCount()).toBe(1);
  });
});
