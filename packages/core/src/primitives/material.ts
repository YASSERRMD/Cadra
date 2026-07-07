import { resolveColorProperty, resolveNumberProperty } from "../keyframes/compile.js";
import type { ColorRGBA } from "../scene-graph/primitives.js";
import type { MeshMaterialConfig } from "../scene-graph/scene-node.js";

/** A neutral, cinematic default base color: readable under any lighting, without pure white's "flat plastic" look under a strong key light. */
const DEFAULT_BASE_COLOR: ColorRGBA = [0.7, 0.7, 0.7, 1];

/** Black: the default `emissive` (no self-illumination). */
const NO_EMISSIVE: ColorRGBA = [0, 0, 0, 1];

/** A `MeshMaterialConfig`, fully resolved to plain values at a specific frame. */
export interface ResolvedMeshMaterial {
  baseColor: ColorRGBA;
  metalness: number;
  roughness: number;
  emissive: ColorRGBA;
  emissiveIntensity: number;
  clearcoat: number;
  clearcoatRoughness: number;
  opacity: number;
  normalMapRef: string | undefined;
  aoMapRef: string | undefined;
}

/**
 * Resolves every `Property<T>` in a `MeshMaterialConfig` to its plain value
 * at `frame`, applying this codebase's own cinematic defaults (see each
 * field's own doc comment on `MeshMaterialConfig`) for anything omitted.
 */
export function resolveMeshMaterial(config: MeshMaterialConfig, frame: number): ResolvedMeshMaterial {
  return {
    baseColor: resolveColorProperty(config.baseColor ?? DEFAULT_BASE_COLOR, frame),
    metalness: resolveNumberProperty(config.metalness ?? 0, frame),
    roughness: resolveNumberProperty(config.roughness ?? 0.5, frame),
    emissive: resolveColorProperty(config.emissive ?? NO_EMISSIVE, frame),
    emissiveIntensity: resolveNumberProperty(config.emissiveIntensity ?? 1, frame),
    clearcoat: resolveNumberProperty(config.clearcoat ?? 0, frame),
    clearcoatRoughness: resolveNumberProperty(config.clearcoatRoughness ?? 0, frame),
    opacity: resolveNumberProperty(config.opacity ?? 1, frame),
    normalMapRef: config.normalMapRef,
    aoMapRef: config.aoMapRef,
  };
}

/**
 * Named, ready-to-use cinematic material presets: `Shape({ material:
 * PBR_PRESETS.brushedMetal })`, or spread and overridden (`{
 * ...PBR_PRESETS.brushedMetal, baseColor: [...] }`). Every value here is a
 * plain `ColorRGBA`/number (no keyframe track), since a preset is a starting
 * point to author from, not itself animated.
 */
export const PBR_PRESETS: Record<string, MeshMaterialConfig> = {
  brushedMetal: { baseColor: [0.72, 0.73, 0.75, 1], metalness: 1, roughness: 0.35 },
  polishedGold: { baseColor: [1, 0.766, 0.336, 1], metalness: 1, roughness: 0.12 },
  glossyPlastic: {
    baseColor: [0.8, 0.15, 0.15, 1],
    metalness: 0,
    roughness: 0.25,
    clearcoat: 0.6,
    clearcoatRoughness: 0.1,
  },
  matteClay: { baseColor: [0.75, 0.7, 0.65, 1], metalness: 0, roughness: 0.9 },
  carPaint: {
    baseColor: [0.05, 0.15, 0.55, 1],
    metalness: 0.3,
    roughness: 0.35,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  },
  brushedSteel: { baseColor: [0.6, 0.62, 0.65, 1], metalness: 1, roughness: 0.45 },
};
