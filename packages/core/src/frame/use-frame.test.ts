import { describe, expect, it } from "vitest";

import { createFrameContext } from "./frame-context.js";
import { useFrame } from "./use-frame.js";

describe("useFrame", () => {
  it("returns the frame index from the passed-in context", () => {
    const context = createFrameContext({
      frame: 42,
      fps: 30,
      durationInFrames: 300,
      seed: "use-frame-check",
    });

    expect(useFrame(context)).toBe(42);
  });

  it("reads only from the passed-in context, not any ambient state", () => {
    const contextA = createFrameContext({
      frame: 1,
      fps: 30,
      durationInFrames: 300,
      seed: "a",
    });
    const contextB = createFrameContext({
      frame: 2,
      fps: 30,
      durationInFrames: 300,
      seed: "b",
    });

    expect(useFrame(contextA)).toBe(1);
    expect(useFrame(contextB)).toBe(2);
  });
});
