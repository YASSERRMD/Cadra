import type { Pending } from "@cadra/core";
import { describe, expect, it, vi } from "vitest";

import { renderWhenAssetsReady } from "./render-when-ready.js";

/** A `Pending`-shaped fake asset load whose completion is controlled manually by the test. */
function createControllableAsset(): { pending: Pending; resolve: () => void } {
  let resolve!: () => void;
  const ready = new Promise<void>((res) => {
    resolve = res;
  });
  return { pending: { ready }, resolve };
}

/** Yields to a macrotask boundary so pending microtask chains have a chance to run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("renderWhenAssetsReady", () => {
  it("does not call render while any pending asset is still unresolved", async () => {
    const assetA = createControllableAsset();
    const assetB = createControllableAsset();
    const assetC = createControllableAsset();
    const render = vi.fn(() => "frame-drawn");

    void renderWhenAssetsReady([assetA.pending, assetB.pending, assetC.pending], render);

    await flush();
    expect(render).not.toHaveBeenCalled();

    assetA.resolve();
    await flush();
    expect(render).not.toHaveBeenCalled();

    assetB.resolve();
    await flush();
    expect(render).not.toHaveBeenCalled();

    // Two of three assets ready is still not all of them: render must
    // remain ungated only in the sense of "not yet called", never called
    // early just because most of the scene's assets happen to be ready.
    assetC.resolve();
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("calls render promptly, exactly once, once every pending asset resolves", async () => {
    const assetA = createControllableAsset();
    const assetB = createControllableAsset();
    const render = vi.fn(() => "frame-drawn");

    const resultPromise = renderWhenAssetsReady([assetA.pending, assetB.pending], render);

    assetA.resolve();
    assetB.resolve();

    const result = await resultPromise;

    expect(result).toBe("frame-drawn");
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("resolves immediately (does not hang) when there are no pending assets at all", async () => {
    const render = vi.fn(() => "frame-drawn");

    const result = await renderWhenAssetsReady([], render);

    expect(result).toBe("frame-drawn");
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("never calls render if a pending asset rejects, and propagates the rejection instead", async () => {
    const failure = new Error("asset failed to load");
    const assetA = createControllableAsset();
    const render = vi.fn(() => "frame-drawn");

    const resultPromise = renderWhenAssetsReady(
      [assetA.pending, { ready: Promise.reject(failure) }],
      render,
    );

    await expect(resultPromise).rejects.toThrow(failure);
    expect(render).not.toHaveBeenCalled();
  });

  it("propagates render's own return value through to the caller", async () => {
    const render = vi.fn(() => ({ pixels: [1, 2, 3] }));

    const result = await renderWhenAssetsReady([], render);

    expect(result).toEqual({ pixels: [1, 2, 3] });
  });

  it("demonstrates the full pipeline: fake loaders with controllable delay gate a render callback", async () => {
    // This is the scenario the readiness gate exists for: several assets
    // (standing in for everything the current scene references), each
    // loading via its own fake loader with an independently controllable
    // resolution, and a render callback that must not run until all of
    // them are done.
    function createFakeLoad(): { ready: Promise<{ decoded: string }>; finishLoading: () => void } {
      let finishLoading!: () => void;
      const ready = new Promise<{ decoded: string }>((resolve) => {
        finishLoading = () => resolve({ decoded: "asset-bytes" });
      });
      return { ready, finishLoading };
    }

    const imageLoad = createFakeLoad();
    const videoLoad = createFakeLoad();
    const fontLoad = createFakeLoad();
    const renderCalls: string[] = [];
    const render = (): void => {
      renderCalls.push("frame-rendered");
    };

    void renderWhenAssetsReady(
      [{ ready: imageLoad.ready }, { ready: videoLoad.ready }, { ready: fontLoad.ready }],
      render,
    );

    await flush();
    expect(renderCalls).toEqual([]);

    imageLoad.finishLoading();
    videoLoad.finishLoading();
    await flush();
    expect(renderCalls).toEqual([]);

    fontLoad.finishLoading();
    await flush();
    expect(renderCalls).toEqual(["frame-rendered"]);
  });
});
