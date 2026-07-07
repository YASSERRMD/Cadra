import { describe, expect, it, vi } from "vitest";

import * as iconResolverModule from "./icon-resolver.js";
import { createIconResolverCache } from "./icon-resolver-cache.js";

describe("createIconResolverCache", () => {
  it("resolves only once for repeated identical (icon, color) requests", () => {
    const resolveSpy = vi.spyOn(iconResolverModule, "resolveIconDataUri");
    const cache = createIconResolverCache();

    const first = cache.resolve("arrow-right", "#ff0000");
    const second = cache.resolve("arrow-right", "#ff0000");

    expect(second).toBe(first);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    resolveSpy.mockRestore();
  });

  it("resolves again when only the color differs", () => {
    const resolveSpy = vi.spyOn(iconResolverModule, "resolveIconDataUri");
    const cache = createIconResolverCache();

    cache.resolve("arrow-right", "#ff0000");
    cache.resolve("arrow-right", "#00ff00");

    expect(resolveSpy).toHaveBeenCalledTimes(2);
    resolveSpy.mockRestore();
  });

  it("resolves again when only the icon name differs", () => {
    const cache = createIconResolverCache();
    const a = cache.resolve("arrow-right", undefined);
    const b = cache.resolve("arrow-left", undefined);
    expect(a).not.toBe(b);
  });

  it("treats color undefined distinctly from any real color string", () => {
    const resolveSpy = vi.spyOn(iconResolverModule, "resolveIconDataUri");
    const cache = createIconResolverCache();

    cache.resolve("arrow-right", undefined);
    cache.resolve("arrow-right", "undefined");

    expect(resolveSpy).toHaveBeenCalledTimes(2);
    resolveSpy.mockRestore();
  });

  it("caches a negative result (not a real icon name) too, without re-resolving", () => {
    const resolveSpy = vi.spyOn(iconResolverModule, "resolveIconDataUri");
    const cache = createIconResolverCache();

    const first = cache.resolve("not-a-real-icon", undefined);
    const second = cache.resolve("not-a-real-icon", undefined);

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    resolveSpy.mockRestore();
  });
});
