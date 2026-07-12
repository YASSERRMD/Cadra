import { describe, expect, it } from "vitest";

import { createRenderer } from "./create-renderer.js";

describe("createRenderer", () => {
  it("constructs a Renderer exposing the full interface, without touching a GPU", () => {
    // Construction itself is synchronous and does no backend detection or
    // Three.js renderer construction (that happens in init()), so this is
    // safe to call with no target/size and no injected fakes at all.
    const renderer = createRenderer();

    expect(typeof renderer.init).toBe("function");
    expect(typeof renderer.renderFrame).toBe("function");
    expect(typeof renderer.resize).toBe("function");
    expect(typeof renderer.dispose).toBe("function");
  });

  it("accepts an optional detectWebGpuSupport override without throwing at construction time", () => {
    expect(() => createRenderer({ detectWebGpuSupport: () => true })).not.toThrow();
    expect(() => createRenderer({ detectWebGpuSupport: () => false })).not.toThrow();
  });

  it("accepts optional modelRegistry/satoriLayerRenderRegistry overrides without throwing at construction time", () => {
    const modelRegistry = { resolve: () => undefined };
    const satoriLayerRenderRegistry = { resolve: () => undefined };
    expect(() => createRenderer({ modelRegistry })).not.toThrow();
    expect(() => createRenderer({ satoriLayerRenderRegistry })).not.toThrow();
    expect(() => createRenderer({ modelRegistry, satoriLayerRenderRegistry })).not.toThrow();
  });

  it("defers to the real WebGPU-detection default when no override is supplied", () => {
    // No assertion on the result itself (it depends on the real
    // environment's navigator.gpu, which this Node test environment does
    // not have), just that omitting options is a valid, non-throwing call
    // distinct from passing an explicit override.
    expect(() => createRenderer(undefined)).not.toThrow();
    expect(() => createRenderer({})).not.toThrow();
  });
});
