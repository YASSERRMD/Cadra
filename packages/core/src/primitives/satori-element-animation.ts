import { resolveColorProperty, resolveNumberProperty } from "../keyframes/compile.js";
import type { ColorRGBA } from "../scene-graph/primitives.js";
import type { SatoriElementKeyframes } from "../scene-graph/scene-node.js";

/** One element's resolved-at-a-frame animatable overrides; only the aspects its own `SatoriElementKeyframes` actually set are present. */
export interface ResolvedSatoriElementStyle {
  opacity?: number;
  x?: number;
  y?: number;
  color?: ColorRGBA;
}

/**
 * Resolves every element's `SatoriElementKeyframes` (`SatoriNode.elementAnimations`)
 * at `frame`, via the same `resolveNumberProperty`/`resolveColorProperty`
 * every other node kind's own animatable fields already go through - so a
 * per-element override is exactly as frame-deterministic as any other
 * `Property<T>` in this codebase, no separate animation system.
 *
 * Pure and renderer-agnostic (only reads `Property<T>` values): applying the
 * result onto an actual `LayerElement` tree (merging `x`/`y` into a CSS
 * `transform: translate(...)`, `opacity`/`color` into `style`) is
 * `@cadra/satori-layer`'s own job, not this package's - `@cadra/core` has no
 * notion of `LayerElement`'s Satori-specific style semantics beyond the
 * plain data shape `layer-element.ts` declares.
 */
export function resolveSatoriElementStyles(
  elementAnimations: Readonly<Record<string, SatoriElementKeyframes>> | undefined,
  frame: number,
): Record<string, ResolvedSatoriElementStyle> {
  const resolved: Record<string, ResolvedSatoriElementStyle> = {};
  if (elementAnimations === undefined) {
    return resolved;
  }

  for (const [elementId, keyframes] of Object.entries(elementAnimations)) {
    const style: ResolvedSatoriElementStyle = {};
    if (keyframes.opacity !== undefined) {
      style.opacity = resolveNumberProperty(keyframes.opacity, frame);
    }
    if (keyframes.x !== undefined) {
      style.x = resolveNumberProperty(keyframes.x, frame);
    }
    if (keyframes.y !== undefined) {
      style.y = resolveNumberProperty(keyframes.y, frame);
    }
    if (keyframes.color !== undefined) {
      style.color = resolveColorProperty(keyframes.color, frame);
    }
    resolved[elementId] = style;
  }

  return resolved;
}
