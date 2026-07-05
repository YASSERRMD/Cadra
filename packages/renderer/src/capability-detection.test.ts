import { afterEach, describe, expect, it, vi } from "vitest";

import { detectWebGpuSupport } from "./capability-detection.js";

describe("detectWebGpuSupport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when navigator is undefined", () => {
    vi.stubGlobal("navigator", undefined);
    expect(detectWebGpuSupport()).toBe(false);
  });

  it("returns false when navigator exists but has no gpu property", () => {
    vi.stubGlobal("navigator", {});
    expect(detectWebGpuSupport()).toBe(false);
  });

  it("returns true when navigator.gpu is present", () => {
    vi.stubGlobal("navigator", { gpu: {} });
    expect(detectWebGpuSupport()).toBe(true);
  });

  it("does not throw when navigator.gpu is falsy but defined", () => {
    vi.stubGlobal("navigator", { gpu: null });
    expect(() => detectWebGpuSupport()).not.toThrow();
    expect(detectWebGpuSupport()).toBe(false);
  });
});
