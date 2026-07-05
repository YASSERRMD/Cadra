import { describe, expect, it, vi } from "vitest";

import type { Pending } from "./wait-for-assets.js";
import { waitForAssets } from "./wait-for-assets.js";

/** A `Pending`-shaped item whose `ready` promise is resolved by an external call. */
function createManuallyResolved(): { pending: Pending; resolve: () => void } {
  let resolve!: () => void;
  const ready = new Promise<void>((res) => {
    resolve = res;
  });
  return { pending: { ready }, resolve };
}

/**
 * Flushes pending microtasks by yielding to a macrotask boundary, so
 * assertions after resolving a promise are not sensitive to exactly how
 * many internal `await` hops `waitForAssets` happens to use.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("waitForAssets", () => {
  it("resolves trivially for an empty collection", async () => {
    await expect(waitForAssets([])).resolves.toBeUndefined();
  });

  it("resolves once a single pending item resolves", async () => {
    const { pending, resolve } = createManuallyResolved();
    const onResolved = vi.fn();

    void waitForAssets([pending]).then(onResolved);
    await flushMicrotasks();
    expect(onResolved).not.toHaveBeenCalled();

    resolve();
    await flushMicrotasks();

    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("does not resolve until every pending item has resolved", async () => {
    const first = createManuallyResolved();
    const second = createManuallyResolved();
    const third = createManuallyResolved();
    const onResolved = vi.fn();

    void waitForAssets([first.pending, second.pending, third.pending]).then(onResolved);

    await flushMicrotasks();
    expect(onResolved).not.toHaveBeenCalled();

    first.resolve();
    await flushMicrotasks();
    expect(onResolved).not.toHaveBeenCalled();

    second.resolve();
    await flushMicrotasks();
    expect(onResolved).not.toHaveBeenCalled();

    third.resolve();
    await flushMicrotasks();
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("resolves promptly once all items are already resolved", async () => {
    const items: Pending[] = [
      { ready: Promise.resolve("a") },
      { ready: Promise.resolve("b") },
      { ready: Promise.resolve("c") },
    ];

    await expect(waitForAssets(items)).resolves.toBeUndefined();
  });

  it("rejects if any one pending item rejects", async () => {
    const failure = new Error("asset failed to load");
    const items: Pending[] = [{ ready: Promise.resolve("ok") }, { ready: Promise.reject(failure) }];

    await expect(waitForAssets(items)).rejects.toThrow(failure);
  });

  it("accepts a non-array iterable", async () => {
    function* generate(): Generator<Pending> {
      yield { ready: Promise.resolve(1) };
      yield { ready: Promise.resolve(2) };
    }

    await expect(waitForAssets(generate())).resolves.toBeUndefined();
  });
});
