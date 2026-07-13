import { describe, expect, it } from "vitest";

import { createIdGenerator } from "../scene-graph/id-generator.js";
import type { Composition } from "../scene-graph/timeline.js";
import type { LookPreset } from "./look-presets.js";
import {
  applyLookPreset,
  LOOK_PRESETS,
  UnknownLookPresetError,
  UnresolvedPresetLightRefError,
} from "./look-presets.js";

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

  it("ships the full curated library: cinematic, product, documentary, boldSocial, elegantTitle, dynamicAction, lightShafts", () => {
    expect(Object.keys(LOOK_PRESETS).sort()).toEqual([
      "boldSocial",
      "cinematic",
      "documentary",
      "dynamicAction",
      "elegantTitle",
      "lightShafts",
      "product",
    ]);
  });

  it("dynamicAction is the one preset that turns on motionBlur (@cadra/renderer's own real, tested velocity-buffer effect, otherwise unreachable through apply_look_preset)", () => {
    const motionBlurPresets = Object.entries(LOOK_PRESETS).filter(([, preset]) =>
      preset.postProcessing?.effects.some((effect) => effect.type === "motionBlur"),
    );
    expect(motionBlurPresets.map(([name]) => name)).toEqual(["dynamicAction"]);
  });

  it("lightShafts is the one preset that turns on godRays (@cadra/renderer's own real, tested volumetric-light-shaft effect, otherwise unreachable through apply_look_preset)", () => {
    const godRaysPresets = Object.entries(LOOK_PRESETS).filter(([, preset]) =>
      preset.postProcessing?.effects.some((effect) => effect.type === "godRays"),
    );
    expect(godRaysPresets.map(([name]) => name)).toEqual(["lightShafts"]);
  });

  it("every godRays effect's own lightNodeId resolves to a presetLightRef one of that same preset's own lights declares", () => {
    for (const [name, preset] of Object.entries(LOOK_PRESETS)) {
      const presetLightRefs = new Set(
        preset.lights.map((light) => light.presetLightRef).filter((ref) => ref !== undefined),
      );
      for (const effect of preset.postProcessing?.effects ?? []) {
        if (effect.type === "godRays") {
          expect(presetLightRefs.has(effect.lightNodeId), `${name}: godRays.lightNodeId`).toBe(true);
        }
      }
    }
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

  it("resolves lightShafts' own godRays.lightNodeId to the real generated id of its own key light", () => {
    const composition = buildBareComposition();
    const result = applyLookPreset(composition, "lightShafts", createIdGenerator("seed-1"));

    const godRaysEffect = result.postProcessing?.effects.find((effect) => effect.type === "godRays");
    expect(godRaysEffect).toBeDefined();

    // The resolved lightNodeId is no longer the static "key" presetLightRef
    // string - it must name one of the real LightNode ids this same call
    // actually created.
    expect(godRaysEffect?.type === "godRays" && godRaysEffect.lightNodeId).not.toBe("key");
    const realLightIds = result.tracks.flatMap((track) =>
      track.clips.filter((clip) => clip.node.kind === "light").map((clip) => clip.node.id),
    );
    expect(realLightIds).toContain(godRaysEffect?.type === "godRays" ? godRaysEffect.lightNodeId : undefined);

    // Specifically the key light (directional, castShadow: true) - the one
    // GodRaysEffectConfig's own doc requires - not the ambient fill.
    const resolvedLightId = godRaysEffect?.type === "godRays" ? godRaysEffect.lightNodeId : undefined;
    const resolvedLightNode = result.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.node.id === resolvedLightId)?.node;
    expect(resolvedLightNode?.kind === "light" && resolvedLightNode.lightType).toBe("directional");
    expect(resolvedLightNode?.kind === "light" && resolvedLightNode.castShadow).toBe(true);
  });

  it("is deterministic for lightShafts too: the same seed resolves godRays.lightNodeId to the same real id across two calls", () => {
    const composition = buildBareComposition();
    const first = applyLookPreset(composition, "lightShafts", createIdGenerator("fixed-seed"));
    const second = applyLookPreset(composition, "lightShafts", createIdGenerator("fixed-seed"));

    expect(second).toEqual(first);
  });

  it("throws UnresolvedPresetLightRefError when a godRays effect references a presetLightRef none of the preset's own lights declare", () => {
    const composition = buildBareComposition();
    const brokenPresets: Record<string, LookPreset> = {
      broken: {
        lights: [{ name: "key", lightType: "directional", castShadow: true }],
        postProcessing: { effects: [{ type: "godRays", lightNodeId: "does-not-exist" }] },
      },
    };
    Object.assign(LOOK_PRESETS, brokenPresets);
    try {
      expect(() => applyLookPreset(composition, "broken", createIdGenerator("seed-1"))).toThrow(
        UnresolvedPresetLightRefError,
      );
    } finally {
      delete (LOOK_PRESETS as Record<string, LookPreset | undefined>).broken;
    }
  });
});
