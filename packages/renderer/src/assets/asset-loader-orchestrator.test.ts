import type { AssetDescriptor } from "@cadra/core";
import { createInMemoryAssetRegistry } from "@cadra/core";
import { describe, expect, it, vi } from "vitest";

import { createAssetLoaderOrchestrator } from "./asset-loader-orchestrator.js";

interface FakeLoadedAsset {
  hash: string;
  label: string;
}

/** Builds a minimal `AssetDescriptor` for `url`; the `kind` value is irrelevant to this dedup logic. */
function descriptorFor(url: string): AssetDescriptor {
  return { kind: "image", url };
}

/** A `loadByUrl`-shaped fake: resolves with `result` once `resolve()` is called, tracks call count. */
function createControllableLoader(): {
  loadByUrl: (url: string) => Promise<FakeLoadedAsset>;
  resolveNext: (result: FakeLoadedAsset) => void;
  callCount: () => number;
  calledUrls: () => string[];
} {
  let callCount = 0;
  const calledUrls: string[] = [];
  const pendingResolvers: Array<(result: FakeLoadedAsset) => void> = [];

  const loadByUrl = vi.fn((url: string): Promise<FakeLoadedAsset> => {
    callCount += 1;
    calledUrls.push(url);
    return new Promise((resolve) => {
      pendingResolvers.push(resolve);
    });
  });

  return {
    loadByUrl,
    resolveNext(result) {
      const resolve = pendingResolvers.shift();
      if (!resolve) {
        throw new Error("no pending load to resolve");
      }
      resolve(result);
    },
    callCount: () => callCount,
    calledUrls: () => [...calledUrls],
  };
}

describe("createAssetLoaderOrchestrator single-flight dedup", () => {
  it("invokes the underlying loader only once for two concurrent calls to the same url", async () => {
    const registry = createInMemoryAssetRegistry<FakeLoadedAsset>();
    const controllable = createControllableLoader();
    const orchestrator = createAssetLoaderOrchestrator(registry, controllable.loadByUrl);

    const first = orchestrator.load(descriptorFor("https://example.test/a.png"));
    const second = orchestrator.load(descriptorFor("https://example.test/a.png"));

    expect(controllable.callCount()).toBe(1);

    controllable.resolveNext({ hash: "hash-a", label: "loaded-a" });
    const [firstResult, secondResult] = await Promise.all([first.ready, second.ready]);

    expect(firstResult).toEqual({ hash: "hash-a", label: "loaded-a" });
    expect(secondResult).toBe(firstResult);
  });

  it("invokes the underlying loader once per distinct url, even when requested concurrently", async () => {
    const registry = createInMemoryAssetRegistry<FakeLoadedAsset>();
    const controllable = createControllableLoader();
    const orchestrator = createAssetLoaderOrchestrator(registry, controllable.loadByUrl);

    orchestrator.load(descriptorFor("https://example.test/a.png"));
    orchestrator.load(descriptorFor("https://example.test/b.png"));

    expect(controllable.callCount()).toBe(2);
    expect(controllable.calledUrls()).toEqual([
      "https://example.test/a.png",
      "https://example.test/b.png",
    ]);
  });

  it("triggers a fresh load for the same url again after the first in-flight request settles", async () => {
    const registry = createInMemoryAssetRegistry<FakeLoadedAsset>();
    const controllable = createControllableLoader();
    const orchestrator = createAssetLoaderOrchestrator(registry, controllable.loadByUrl);

    const first = orchestrator.load(descriptorFor("https://example.test/a.png"));
    controllable.resolveNext({ hash: "hash-1", label: "first-load" });
    await first.ready;

    // First request has fully settled; the in-flight entry is cleared, so a
    // second request for the same url is a genuinely new load, not a stale
    // single-flight replay.
    const second = orchestrator.load(descriptorFor("https://example.test/a.png"));
    expect(controllable.callCount()).toBe(2);
    controllable.resolveNext({ hash: "hash-1", label: "second-load-same-hash" });
    await second.ready;
  });

  it("clears the in-flight entry even when the load rejects, so a retry is possible", async () => {
    const registry = createInMemoryAssetRegistry<FakeLoadedAsset>();
    let callCount = 0;
    const loadByUrl = vi.fn(async (): Promise<FakeLoadedAsset> => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("transient failure");
      }
      return { hash: "hash-1", label: "retry-succeeded" };
    });
    const orchestrator = createAssetLoaderOrchestrator(registry, loadByUrl);

    await expect(
      orchestrator.load(descriptorFor("https://example.test/a.png")).ready,
    ).rejects.toThrow("transient failure");

    const retryResult = await orchestrator.load(descriptorFor("https://example.test/a.png")).ready;
    expect(retryResult).toEqual({ hash: "hash-1", label: "retry-succeeded" });
    expect(callCount).toBe(2);
  });
});

describe("createAssetLoaderOrchestrator content-hash dedup", () => {
  it("reuses the already-registered resource when two different urls load byte-identical content", async () => {
    const registry = createInMemoryAssetRegistry<FakeLoadedAsset>();
    let callCount = 0;
    const loadByUrl = vi.fn(async (url: string): Promise<FakeLoadedAsset> => {
      callCount += 1;
      // Both urls "happen" to serve byte-identical content: same hash,
      // distinct per-call label so identity is observable in the test.
      return { hash: "same-content-hash", label: `loaded-from-${url}` };
    });
    const orchestrator = createAssetLoaderOrchestrator(registry, loadByUrl);

    const first = await orchestrator.load(descriptorFor("https://example.test/a.png")).ready;
    const second = await orchestrator.load(descriptorFor("https://example.test/b.png")).ready;

    expect(callCount).toBe(2);
    // The second url's own load result is discarded in favor of the first,
    // already-registered resource: same reference, and specifically the
    // first url's label, not the second's.
    expect(second).toBe(first);
    expect(second.label).toBe("loaded-from-https://example.test/a.png");
  });

  it("registers exactly one resource in the registry for two byte-identical loads", async () => {
    const registry = createInMemoryAssetRegistry<FakeLoadedAsset>();
    const loadByUrl = vi.fn(async (url: string): Promise<FakeLoadedAsset> => ({
      hash: "shared-hash",
      label: `from-${url}`,
    }));
    const orchestrator = createAssetLoaderOrchestrator(registry, loadByUrl);

    await orchestrator.load(descriptorFor("https://example.test/a.png")).ready;
    await orchestrator.load(descriptorFor("https://example.test/b.png")).ready;

    expect(registry.has("shared-hash")).toBe(true);
    expect(registry.resolve("shared-hash")?.label).toBe("from-https://example.test/a.png");
  });

  it("registers two separate resources for two urls with different content hashes", async () => {
    const registry = createInMemoryAssetRegistry<FakeLoadedAsset>();
    const loadByUrl = vi.fn(async (url: string): Promise<FakeLoadedAsset> => {
      return url.includes("a.png")
        ? { hash: "hash-a", label: "content-a" }
        : { hash: "hash-b", label: "content-b" };
    });
    const orchestrator = createAssetLoaderOrchestrator(registry, loadByUrl);

    const first = await orchestrator.load(descriptorFor("https://example.test/a.png")).ready;
    const second = await orchestrator.load(descriptorFor("https://example.test/b.png")).ready;

    expect(first).not.toBe(second);
    expect(registry.has("hash-a")).toBe(true);
    expect(registry.has("hash-b")).toBe(true);
  });

  it("resolving via content hash reuses a resource registered by an earlier, already-settled load", async () => {
    const registry = createInMemoryAssetRegistry<FakeLoadedAsset>();
    registry.register("preexisting-hash", { hash: "preexisting-hash", label: "already-there" });
    const loadByUrl = vi.fn(async (): Promise<FakeLoadedAsset> => ({
      hash: "preexisting-hash",
      label: "freshly-loaded-but-same-hash",
    }));
    const orchestrator = createAssetLoaderOrchestrator(registry, loadByUrl);

    const result = await orchestrator.load(descriptorFor("https://example.test/new-url.png")).ready;

    expect(result.label).toBe("already-there");
  });
});
