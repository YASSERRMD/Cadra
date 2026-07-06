import { describe, expect, it } from "vitest";

import { NonSequentialMuxWriteError, toSequentialOnData } from "./mux-stream-target.js";

/** A fake `NodeWritableLike`: records every chunk written to it. */
function createFakeNodeWritable(): { write: (chunk: Uint8Array) => unknown; writes: Uint8Array[] } {
  const writes: Uint8Array[] = [];
  return {
    write: (chunk: Uint8Array) => {
      writes.push(chunk);
      return true;
    },
    writes,
  };
}

/** A fake `WebWritableStreamLike`: records every chunk written via its single writer, and whether/how many times `close` was called. */
function createFakeWebWritableStream(): {
  getWriter: () => { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void> };
  writes: Uint8Array[];
  getWriterCallCount: () => number;
  closeCallCount: () => number;
} {
  const writes: Uint8Array[] = [];
  let getWriterCallCount = 0;
  let closeCallCount = 0;
  return {
    getWriter: () => {
      getWriterCallCount += 1;
      return {
        write: async (chunk: Uint8Array) => {
          writes.push(chunk);
        },
        close: async () => {
          closeCallCount += 1;
        },
      };
    },
    writes,
    getWriterCallCount: () => getWriterCallCount,
    closeCallCount: () => closeCallCount,
  };
}

describe("toSequentialOnData: Node Writable-like destination", () => {
  it("forwards each chunk to destination.write in call order", () => {
    const destination = createFakeNodeWritable();
    const { onData } = toSequentialOnData(destination);

    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5]);
    onData(first, 0);
    onData(second, 3);

    expect(destination.writes).toEqual([first, second]);
  });

  it("throws NonSequentialMuxWriteError when position does not match the running total of bytes written", () => {
    const destination = createFakeNodeWritable();
    const { onData } = toSequentialOnData(destination);

    onData(new Uint8Array([1, 2, 3]), 0);
    // Next write should be expected at position 3, not 10.
    expect(() => onData(new Uint8Array([4]), 10)).toThrow(NonSequentialMuxWriteError);
  });

  it("throws NonSequentialMuxWriteError when the very first write is not at position 0", () => {
    const destination = createFakeNodeWritable();
    const { onData } = toSequentialOnData(destination);

    expect(() => onData(new Uint8Array([1]), 5)).toThrow(NonSequentialMuxWriteError);
  });

  it("accepts a zero-length chunk at the expected position without advancing it", () => {
    const destination = createFakeNodeWritable();
    const { onData } = toSequentialOnData(destination);

    onData(new Uint8Array([]), 0);
    onData(new Uint8Array([1, 2]), 0);

    expect(destination.writes).toHaveLength(2);
  });

  it("close() resolves without doing anything: a Node Writable's lifecycle stays the caller's own responsibility", async () => {
    const destination = createFakeNodeWritable();
    const { close } = toSequentialOnData(destination);

    await expect(close()).resolves.toBeUndefined();
  });
});

describe("toSequentialOnData: web WritableStream-like destination", () => {
  it("forwards each chunk to a single reused writer, in call order", () => {
    const destination = createFakeWebWritableStream();
    const { onData } = toSequentialOnData(destination);

    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5]);
    onData(first, 0);
    onData(second, 3);

    expect(destination.writes).toEqual([first, second]);
    // getWriter() is called exactly once for the whole muxing session, not
    // once per onData call: repeatedly locking/unlocking the stream would
    // be both wasteful and, per the Streams spec, an error if a previous
    // writer was never released.
    expect(destination.getWriterCallCount()).toBe(1);
  });

  it("throws NonSequentialMuxWriteError when position does not match the running total of bytes written", () => {
    const destination = createFakeWebWritableStream();
    const { onData } = toSequentialOnData(destination);

    onData(new Uint8Array([1, 2, 3, 4]), 0);
    expect(() => onData(new Uint8Array([5]), 100)).toThrow(NonSequentialMuxWriteError);
  });

  it("close() closes the same writer instance onData wrote through, exactly once", async () => {
    const destination = createFakeWebWritableStream();
    const { onData, close } = toSequentialOnData(destination);

    onData(new Uint8Array([1, 2, 3]), 0);
    await close();

    expect(destination.getWriterCallCount()).toBe(1);
    expect(destination.closeCallCount()).toBe(1);
  });
});
