import { describe, expect, it, vi } from "vitest";

import type { LayerElement } from "./layer-element.js";
import { createRenderLayerCache } from "./render-layer-cache.js";
import * as renderLayerToSvgModule from "./render-layer-to-svg.js";

const LAYER: LayerElement = { type: "div", style: { backgroundColor: "red" } };
const OPTIONS = { width: 100, height: 100, fonts: [] };

describe("createRenderLayerCache", () => {
  it("renders only once for repeated identical requests", async () => {
    const renderSpy = vi.spyOn(renderLayerToSvgModule, "renderLayerToSvg");
    const cache = createRenderLayerCache();

    const first = await cache.getOrRender(LAYER, OPTIONS);
    const second = await cache.getOrRender(LAYER, OPTIONS);

    expect(second).toBe(first);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    renderSpy.mockRestore();
  });

  it("renders again for a layer with different content", async () => {
    const cache = createRenderLayerCache();
    const a = await cache.getOrRender(LAYER, OPTIONS);
    const b = await cache.getOrRender({ type: "div", style: { backgroundColor: "blue" } }, OPTIONS);
    expect(a).not.toBe(b);
  });

  it("reports has() correctly once a request is cached", async () => {
    const cache = createRenderLayerCache();
    const { computeRenderLayerCacheKey } = await import("./render-layer-cache-key.js");
    const cacheKey = computeRenderLayerCacheKey(LAYER, OPTIONS);

    expect(cache.has(cacheKey)).toBe(false);
    await cache.getOrRender(LAYER, OPTIONS);
    expect(cache.has(cacheKey)).toBe(true);
  });

  it("deduplicates concurrent identical requests (caches the in-flight promise, not just the settled result)", async () => {
    const renderSpy = vi.spyOn(renderLayerToSvgModule, "renderLayerToSvg");
    const cache = createRenderLayerCache();

    const [a, b] = await Promise.all([cache.getOrRender(LAYER, OPTIONS), cache.getOrRender(LAYER, OPTIONS)]);

    expect(a).toBe(b);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    renderSpy.mockRestore();
  });
});
