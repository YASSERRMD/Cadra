import { resolveColorProperty, resolveNumberProperty } from "../keyframes/compile.js";
import type { ColorRGBA } from "../scene-graph/primitives.js";
import type {
  TextFill,
  TextGlowConfig,
  TextGlowDirection,
  TextGradientStop,
  TextOutlineConfig,
  TextShadowConfig,
} from "../scene-graph/scene-node.js";

/** One `TextGradientStop`, resolved to a plain `ColorRGBA` at a specific frame. `offset` is structural (see `TextGradientStop`'s own doc), so it passes through unchanged. */
export interface ResolvedTextGradientStop {
  offset: number;
  color: ColorRGBA;
}

/** A `TextFill`, fully resolved to plain values at a specific frame. */
export type ResolvedTextFill =
  | { type: "solid"; color: ColorRGBA }
  | { type: "linearGradient"; angle: number; stops: readonly ResolvedTextGradientStop[] }
  | { type: "radialGradient"; stops: readonly ResolvedTextGradientStop[] }
  | { type: "texture"; assetRef: string }
  | { type: "video"; assetRef: string };

/** Resolves every `Property<T>` in a `TextFill` (including each gradient stop's own color) to its plain value at `frame`. */
export function resolveTextFill(fill: TextFill, frame: number): ResolvedTextFill {
  switch (fill.type) {
    case "solid":
      return { type: "solid", color: resolveColorProperty(fill.color, frame) };
    case "linearGradient":
      return {
        type: "linearGradient",
        angle: resolveNumberProperty(fill.angle ?? 0, frame),
        stops: resolveStops(fill.stops, frame),
      };
    case "radialGradient":
      return { type: "radialGradient", stops: resolveStops(fill.stops, frame) };
    case "texture":
      return { type: "texture", assetRef: fill.assetRef };
    case "video":
      return { type: "video", assetRef: fill.assetRef };
  }
}

function resolveStops(
  stops: readonly TextGradientStop[],
  frame: number,
): readonly ResolvedTextGradientStop[] {
  return stops.map((stop) => ({ offset: stop.offset, color: resolveColorProperty(stop.color, frame) }));
}

/** A `TextOutlineConfig`, fully resolved to plain values at a specific frame. */
export interface ResolvedTextOutline {
  width: number;
  color: ColorRGBA;
}

export function resolveTextOutline(config: TextOutlineConfig, frame: number): ResolvedTextOutline {
  return {
    width: resolveNumberProperty(config.width, frame),
    color: resolveColorProperty(config.color, frame),
  };
}

/** A `TextGlowConfig`, fully resolved to plain values at a specific frame. */
export interface ResolvedTextGlow {
  direction: TextGlowDirection;
  radius: number;
  color: ColorRGBA;
  intensity: number;
}

export function resolveTextGlow(config: TextGlowConfig, frame: number): ResolvedTextGlow {
  return {
    direction: config.direction ?? "outer",
    radius: resolveNumberProperty(config.radius, frame),
    color: resolveColorProperty(config.color, frame),
    intensity: resolveNumberProperty(config.intensity ?? 1, frame),
  };
}

/** A `TextShadowConfig`, fully resolved to plain values at a specific frame. */
export interface ResolvedTextShadow {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: ColorRGBA;
  steps: number;
}

export function resolveTextShadow(config: TextShadowConfig, frame: number): ResolvedTextShadow {
  return {
    offsetX: resolveNumberProperty(config.offsetX, frame),
    offsetY: resolveNumberProperty(config.offsetY, frame),
    blur: resolveNumberProperty(config.blur ?? 0, frame),
    color: resolveColorProperty(config.color, frame),
    steps: config.steps ?? 1,
  };
}
