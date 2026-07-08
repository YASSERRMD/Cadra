import { describe, expect, it } from "vitest";

import { createIdGenerator } from "../scene-graph/id-generator.js";
import type { Composition } from "../scene-graph/timeline.js";
import { applyLookPreset, LOOK_PRESETS, UnknownLookPresetError } from "./look-presets.js";

function buildBareComposition(): Composition {
  return {
    id: "comp-1",
    name: "Main",
    fps: 30,
    durationInFrames: 90,
    width: 1920,
    height: 1080,
    tracks: [],
  };
}

describe("LOOK_PRESETS", () => {
  it("gives every preset at least one light", () => {
    for (const [name, preset] of Object.entries(LOOK_PRESETS)) {
      expect(preset.lights.length, name).toBeGreaterThan(0);
    }
  });

  it("ships the full curated library: cinematic, product, documentary, boldSocial, elegantTitle", () => {
    expect(Object.keys(LOOK_PRESETS).sort()).toEqual([
      "boldSocial",
      "cinematic",
      "documentary",
      "elegantTitle",
      "product",
    ]);
  });

  it("gives every preset at least one postProcessing effect", () => {
    for (const [name, preset] of Object.entries(LOOK_PRESETS)) {
      expect(preset.postProcessing?.effects.length ?? 0, name).toBeGreaterThan(0);
    }
  });
});

describe("applyLookPreset", () => {
  it("adds one new track per preset light, each spanning the composition's own full duration", () => {
    const composition = buildBareComposition();
    const result = applyLookPreset(composition, "cinematic", createIdGenerator("seed-1"));

    expect(result.tracks.length).toBe(LOOK_PRESETS.cinematic?.lights.length);
    for (const track of result.tracks) {
      expect(track.clips.length).toBe(1);
      expect(track.clips[0]?.startFrame).toBe(0);
      expect(track.clips[0]?.durationInFrames).toBe(composition.durationInFrames);
      expect(track.clips[0]?.node.kind).toBe("light");
    }
  });

  it("does not mutate the input composition", () => {
    const composition = buildBareComposition();
    applyLookPreset(composition, "cinematic", createIdGenerator("seed-1"));

    expect(composition.tracks).toEqual([]);
    expect(composition.postProcessing).toBeUndefined();
  });

  it("sets postProcessing/environment from the preset, overwriting any existing value", () => {
    const composition: Composition = {
      ...buildBareComposition(),
      postProcessing: { effects: [{ type: "vignette", darkness: 1 }] },
    };
    const result = applyLookPreset(composition, "product", createIdGenerator("seed-1"));

    expect(result.postProcessing).toEqual(LOOK_PRESETS.product?.postProcessing);
    expect(result.environment).toEqual(LOOK_PRESETS.product?.environment);
  });

  it("is deterministic: the same seed produces byte-identical output across two independent calls", () => {
    const composition = buildBareComposition();
    const first = applyLookPreset(composition, "cinematic", createIdGenerator("fixed-seed"));
    const second = applyLookPreset(composition, "cinematic", createIdGenerator("fixed-seed"));

    expect(second).toEqual(first);
  });

  it("throws UnknownLookPresetError for an unrecognized preset name", () => {
    const composition = buildBareComposition();
    expect(() => applyLookPreset(composition, "not-a-real-preset", createIdGenerator("seed-1"))).toThrow(
      UnknownLookPresetError,
    );
  });
});
