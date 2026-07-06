/**
 * Both mp4-muxer's and webm-muxer's `StreamTarget` accept an `onData(data,
 * position)` callback rather than a Node/web stream directly (see each
 * package's own `StreamTarget` doc), so `@cadra/headless`'s server-side
 * "writable stream target" requirement (this phase's spec) needs a small
 * adapter from one shape to the other. Kept in its own module (rather than
 * duplicated inside `mux-mp4.ts` and `mux-webm.ts`) since the adapter itself
 * has nothing MP4- or WebM-specific about it.
 *
 * Deliberately narrow structural types (`NodeWritableLike`/
 * `WebWritableStreamLike`) rather than importing `node:stream`'s `Writable`
 * or DOM's `WritableStream` directly: this package's `tsconfig.base.json`
 * `lib` is `["ES2022", "DOM", "DOM.Iterable"]` with no `@types/node`, so a
 * real `Writable` type is not otherwise available here, and requiring one
 * would force every caller (including browser-only ones) to install
 * `@types/node`. A structural type capturing only the methods this adapter
 * actually calls lets a real Node `Writable` (or anything else shaped like
 * one) satisfy it without a nominal import.
 */

/** The subset of Node's `stream.Writable` this adapter needs. */
export interface NodeWritableLike {
  write(chunk: Uint8Array): unknown;
}

/** The subset of a spec `WritableStream`'s writer this adapter needs. */
export interface WebWritableStreamLike {
  getWriter(): {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
  };
}

function isWebWritableStreamLike(
  destination: NodeWritableLike | WebWritableStreamLike,
): destination is WebWritableStreamLike {
  return typeof (destination as WebWritableStreamLike).getWriter === "function";
}

/** Thrown when a muxer's `StreamTarget` calls `onData` out of strictly increasing position order. */
export class NonSequentialMuxWriteError extends Error {
  constructor(position: number, expectedPosition: number) {
    super(
      `Muxer wrote at position ${position}, but this stream target only supports sequential, append-only writes (expected position ${expectedPosition}). This means the muxer was configured with a fastStart mode that seeks backward to patch already-written data, which a plain Writable/WritableStream destination cannot do; use 'fastStart: false' or 'fastStart: "fragmented"' with this target instead.`,
    );
    this.name = "NonSequentialMuxWriteError";
  }
}

/**
 * Builds an `onData(data, position)` callback (mp4-muxer's/webm-muxer's
 * `StreamTarget` constructor option) that forwards each `data` chunk into
 * `destination` in the order received, for either a Node `Writable`-like
 * object (`.write(chunk)`, fire-and-forget from this adapter's perspective
 * since mp4-muxer/webm-muxer do not await `onData`'s return value either) or
 * a web `WritableStream`-like object (via a single `getWriter()` writer,
 * reused across the whole muxing session so writes stay ordered and the
 * stream is not locked/unlocked repeatedly).
 *
 * Asserts strictly sequential, contiguous `position` values (each call's
 * `position` must equal the running total of bytes written so far): both
 * target muxers document that non-sequential writes only happen under
 * specific `fastStart` configurations that patch earlier bytes after later
 * ones are already written (see `NonSequentialMuxWriteError`'s own doc), and
 * a plain `Writable`/`WritableStream` has no way to honor that (no seek
 * operation), so failing loudly here is strictly better than silently
 * producing a corrupt file with a gap or a stale header.
 */
export function toSequentialOnData(
  destination: NodeWritableLike | WebWritableStreamLike,
): (data: Uint8Array, position: number) => void {
  let expectedPosition = 0;

  if (isWebWritableStreamLike(destination)) {
    const writer = destination.getWriter();
    return (data, position) => {
      if (position !== expectedPosition) {
        throw new NonSequentialMuxWriteError(position, expectedPosition);
      }
      expectedPosition += data.byteLength;
      // Not awaited: onData's own contract (both muxers) is synchronous and
      // fire-and-forget. The writer's internal queue preserves write order
      // across overlapping unawaited writes, matching how a real
      // FileSystemWritableFileStream-backed StreamTarget usage would behave.
      void writer.write(data);
    };
  }

  return (data, position) => {
    if (position !== expectedPosition) {
      throw new NonSequentialMuxWriteError(position, expectedPosition);
    }
    expectedPosition += data.byteLength;
    destination.write(data);
  };
}
