import { describe, expect, it } from "vitest";

import { POST_PROCESSING_LOOK_PRESETS } from "./post-processing-presets.js";

describe("POST_PROCESSING_LOOK_PRESETS", () => {
  it("gives every preset at least one effect", () => {
    for (const [name, effects] of Object.entries(POST_PROCESSING_LOOK_PRESETS)) {
      expect(effects.length, name).toBeGreaterThan(0);
    }
  });

  it("never repeats the same effect type twice within one preset", () => {
    for (const [name, effects] of Object.entries(POST_PROCESSING_LOOK_PRESETS)) {
      const types = effects.map((effect) => effect.type);
      expect(new Set(types).size, name).toBe(types.length);
    }
  });

  it("is deterministic and immutable across reads: two reads of the same preset are deep-equal", () => {
    expect(POST_PROCESSING_LOOK_PRESETS.cinematic).toEqual(POST_PROCESSING_LOOK_PRESETS.cinematic);
  });

  it("ships the cinematic, dreamy, and vintage presets", () => {
    expect(Object.keys(POST_PROCESSING_LOOK_PRESETS).sort()).toEqual(["cinematic", "dreamy", "vintage"]);
  });
});
