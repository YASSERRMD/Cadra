import { describe, expect, it } from "vitest";

import type { MeshMaterialConfig } from "../scene-graph/scene-node.js";
import { PBR_PRESETS, resolveMeshMaterial } from "./material.js";

describe("resolveMeshMaterial: defaults", () => {
  it("applies every cinematic default when the config is empty", () => {
    expect(resolveMeshMaterial({}, 0)).toEqual({
      baseColor: [0.7, 0.7, 0.7, 1],
      metalness: 0,
      roughness: 0.5,
      emissive: [0, 0, 0, 1],
      emissiveIntensity: 1,
      clearcoat: 0,
      clearcoatRoughness: 0,
      transmission: 0,
      ior: 1.5,
      thickness: 0,
      sheen: 0,
      sheenRoughness: 1,
      sheenColor: [0, 0, 0, 1],
      opacity: 1,
      normalMapRef: undefined,
      aoMapRef: undefined,
    });
  });

  it("resolves every explicit plain value unchanged", () => {
    const config: MeshMaterialConfig = {
      baseColor: [0.9, 0.1, 0.1, 1],
      metalness: 1,
      roughness: 0.2,
      emissive: [0.2, 0, 0, 1],
      emissiveIntensity: 3,
      clearcoat: 0.5,
      clearcoatRoughness: 0.1,
      transmission: 0.9,
      ior: 1.33,
      thickness: 0.6,
      sheen: 0.7,
      sheenRoughness: 0.4,
      sheenColor: [0.8, 0.6, 0.7, 1],
      opacity: 0.8,
      normalMapRef: "normal-1",
      aoMapRef: "ao-1",
    };
    expect(resolveMeshMaterial(config, 0)).toEqual({
      baseColor: [0.9, 0.1, 0.1, 1],
      metalness: 1,
      roughness: 0.2,
      emissive: [0.2, 0, 0, 1],
      emissiveIntensity: 3,
      clearcoat: 0.5,
      clearcoatRoughness: 0.1,
      transmission: 0.9,
      ior: 1.33,
      thickness: 0.6,
      sheen: 0.7,
      sheenRoughness: 0.4,
      sheenColor: [0.8, 0.6, 0.7, 1],
      opacity: 0.8,
      normalMapRef: "normal-1",
      aoMapRef: "ao-1",
    });
  });
});

describe("resolveMeshMaterial: keyframed channels", () => {
  it("resolves keyframed baseColor, metalness, and roughness to different values at different frames", () => {
    const config: MeshMaterialConfig = {
      baseColor: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: [0, 0, 0, 1] },
          { frame: 10, value: [1, 1, 1, 1] },
        ],
      },
      metalness: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }] },
      roughness: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 1 }, { frame: 10, value: 0 }] },
    };

    const atStart = resolveMeshMaterial(config, 0);
    expect(atStart.baseColor).toEqual([0, 0, 0, 1]);
    expect(atStart.metalness).toBe(0);
    expect(atStart.roughness).toBe(1);

    const atEnd = resolveMeshMaterial(config, 10);
    expect(atEnd.baseColor).toEqual([1, 1, 1, 1]);
    expect(atEnd.metalness).toBe(1);
    expect(atEnd.roughness).toBe(0);
  });
});

describe("resolveMeshMaterial: determinism", () => {
  it("is deterministic and order-independent across frames", () => {
    const config: MeshMaterialConfig = {
      metalness: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }] },
      roughness: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 0.2 }, { frame: 10, value: 0.8 }] },
    };
    const resolveAtFrame = (frame: number) => resolveMeshMaterial(config, frame);

    const first = resolveAtFrame(4);
    const second = resolveAtFrame(4);
    expect(second).toEqual(first);

    const inOrder = [0, 5, 10].map(resolveAtFrame);
    const outOfOrder = [10, 0, 5].map(resolveAtFrame);
    expect(outOfOrder[1]).toEqual(inOrder[0]);
    expect(outOfOrder[2]).toEqual(inOrder[1]);
    expect(outOfOrder[0]).toEqual(inOrder[2]);
  });
});

describe("PBR_PRESETS", () => {
  it("resolves every preset without throwing, each within its own physically valid 0-1 ranges", () => {
    for (const [name, preset] of Object.entries(PBR_PRESETS)) {
      const resolved = resolveMeshMaterial(preset, 0);
      expect(resolved.metalness, name).toBeGreaterThanOrEqual(0);
      expect(resolved.metalness, name).toBeLessThanOrEqual(1);
      expect(resolved.roughness, name).toBeGreaterThanOrEqual(0);
      expect(resolved.roughness, name).toBeLessThanOrEqual(1);
      expect(resolved.clearcoat, name).toBeGreaterThanOrEqual(0);
      expect(resolved.clearcoat, name).toBeLessThanOrEqual(1);
      expect(resolved.transmission, name).toBeGreaterThanOrEqual(0);
      expect(resolved.transmission, name).toBeLessThanOrEqual(1);
      expect(resolved.sheen, name).toBeGreaterThanOrEqual(0);
      expect(resolved.sheen, name).toBeLessThanOrEqual(1);
    }
  });

  it("brushedMetal and polishedGold are fully metallic", () => {
    expect(resolveMeshMaterial(PBR_PRESETS.brushedMetal as MeshMaterialConfig, 0).metalness).toBe(1);
    expect(resolveMeshMaterial(PBR_PRESETS.polishedGold as MeshMaterialConfig, 0).metalness).toBe(1);
  });

  it("glossyPlastic and matteClay are fully dielectric", () => {
    expect(resolveMeshMaterial(PBR_PRESETS.glossyPlastic as MeshMaterialConfig, 0).metalness).toBe(0);
    expect(resolveMeshMaterial(PBR_PRESETS.matteClay as MeshMaterialConfig, 0).metalness).toBe(0);
  });

  it("carPaint has a strong clearcoat layer", () => {
    expect(resolveMeshMaterial(PBR_PRESETS.carPaint as MeshMaterialConfig, 0).clearcoat).toBe(1);
  });

  it("clearGlass and frostedGlass are fully transmissive, differing only in roughness", () => {
    const clear = resolveMeshMaterial(PBR_PRESETS.clearGlass as MeshMaterialConfig, 0);
    const frosted = resolveMeshMaterial(PBR_PRESETS.frostedGlass as MeshMaterialConfig, 0);
    expect(clear.transmission).toBe(1);
    expect(frosted.transmission).toBe(1);
    expect(frosted.roughness).toBeGreaterThan(clear.roughness);
  });

  it("velvet has a strong, tinted sheen layer", () => {
    const resolved = resolveMeshMaterial(PBR_PRESETS.velvet as MeshMaterialConfig, 0);
    expect(resolved.sheen).toBe(1);
    expect(resolved.sheenColor).not.toEqual([0, 0, 0, 1]);
  });
});
