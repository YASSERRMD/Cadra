import { afterEach, describe, expect, it, vi } from "vitest";

import { detectOffscreenCanvasSupport } from "./offscreen-detection.js";

describe("detectOffscreenCanvasSupport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when OffscreenCanvas is undefined (this Node/Vitest environment's real state)", () => {
    expect(detectOffscreenCanvasSupport()).toBe(false);
  });

  it("returns false when OffscreenCanvas exists but HTMLCanvasElement does not", () => {
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("HTMLCanvasElement", undefined);
    expect(detectOffscreenCanvasSupport()).toBe(false);
  });

  it("returns false when both exist but transferControlToOffscreen is not a function", () => {
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("HTMLCanvasElement", { prototype: {} });
    expect(detectOffscreenCanvasSupport()).toBe(false);
  });

  it("returns true when OffscreenCanvas and transferControlToOffscreen are both present", () => {
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("HTMLCanvasElement", { prototype: { transferControlToOffscreen: () => {} } });
    expect(detectOffscreenCanvasSupport()).toBe(true);
  });
});
