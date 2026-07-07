import { describe, expect, it, vi } from "vitest";

import * as rasterizeSvgModule from "./rasterize-svg.js";
import { computeSvgRasterCacheKey, createSvgRasterCache } from "./svg-raster-cache.js";

const SVG = `<svg width="10" height="10" xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="red"/></svg>`;

describe("computeSvgRasterCacheKey", () => {
  it("is stable for the same svg and options", () => {
    const a = computeSvgRasterCacheKey(SVG, { width: 20, height: 20 });
    const b = computeSvgRasterCacheKey(SVG, { width: 20, height: 20 });
    expect(a).toBe(b);
  });

  it("hashes an explicit default-valued option the same as omitting it", () => {
    const a = computeSvgRasterCacheKey(SVG, { supersample: 1 });
    const b = computeSvgRasterCacheKey(SVG);
    expect(a).toBe(b);
  });

  it("differs when the svg content differs", () => {
    const other = `<svg width="10" height="10" xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="blue"/></svg>`;
    expect(computeSvgRasterCacheKey(SVG)).not.toBe(computeSvgRasterCacheKey(other));
  });

  it("differs when supersample differs", () => {
    const a = computeSvgRasterCacheKey(SVG, { supersample: 2 });
    const b = computeSvgRasterCacheKey(SVG, { supersample: 3 });
    expect(a).not.toBe(b);
  });
});

describe("createSvgRasterCache", () => {
  it("rasterizes only once for repeated identical requests", () => {
    const rasterizeSpy = vi.spyOn(rasterizeSvgModule, "rasterizeSvg");
    const cache = createSvgRasterCache();

    const first = cache.getOrRasterize(SVG, { width: 20, height: 20 });
    const second = cache.getOrRasterize(SVG, { width: 20, height: 20 });

    expect(second).toBe(first);
    expect(rasterizeSpy).toHaveBeenCalledTimes(1);
    rasterizeSpy.mockRestore();
  });

  it("rasterizes again for a different request", () => {
    const cache = createSvgRasterCache();
    const a = cache.getOrRasterize(SVG, { width: 20, height: 20 });
    const b = cache.getOrRasterize(SVG, { width: 40, height: 40 });
    expect(a).not.toBe(b);
    expect(a.width).toBe(20);
    expect(b.width).toBe(40);
  });

  it("reports has() correctly once a request is cached", () => {
    const cache = createSvgRasterCache();
    const cacheKey = computeSvgRasterCacheKey(SVG, { width: 20, height: 20 });
    expect(cache.has(cacheKey)).toBe(false);
    cache.getOrRasterize(SVG, { width: 20, height: 20 });
    expect(cache.has(cacheKey)).toBe(true);
  });
});
