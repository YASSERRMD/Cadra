import type { ColorRGBA } from "@cadra/core";

import type { LayerElement } from "./layer-element.js";

/** One element's resolved-at-a-frame animatable overrides (mirrors `@cadra/core`'s `ResolvedSatoriElementStyle`, without depending on it: this package only needs the plain data shape, not `resolveSatoriElementStyles` itself). */
export interface ResolvedElementStyle {
  opacity?: number;
  x?: number;
  y?: number;
  color?: ColorRGBA;
}

/** Converts a straight (non-premultiplied) `ColorRGBA` (each channel `0` to `1`) to a CSS `rgba(...)` string Satori's own `color`/`backgroundColor` style properties accept. */
function colorToCss([red, green, blue, alpha]: ColorRGBA): string {
  const to255 = (channel: number) => Math.round(Math.max(0, Math.min(1, channel)) * 255);
  return `rgba(${to255(red)}, ${to255(green)}, ${to255(blue)}, ${alpha})`;
}

/**
 * Prepends a `translate(x, y)` to `existingTransform`: CSS applies a
 * `transform` list's functions innermost-first (the rightmost function acts
 * on the element first, and every function to its left acts on that
 * already-transformed result), so prepending puts this translation
 * outermost - a plain screen-space nudge applied after whatever the
 * element's own authored `transform` already did, unaffected by any
 * rotation or scale in it, matching `x`/`y`'s own documented meaning ("added
 * on top of the element's own natural position").
 */
function prependTranslate(
  existingTransform: string | undefined,
  x: number | undefined,
  y: number | undefined,
): string {
  const translate = `translate(${x ?? 0}px, ${y ?? 0}px)`;
  return existingTransform === undefined ? translate : `${translate} ${existingTransform}`;
}

/**
 * Recursively applies each element's own resolved-at-a-frame overrides
 * (`resolveSatoriElementStyles` in `@cadra/core`, keyed by `LayerElement.id`)
 * onto a copy of `element`'s own tree, producing the exact `LayerElement`
 * tree to render for one specific frame. `element` itself is never
 * mutated: every node on the path from the root to an animated element (and
 * the animated element itself) is shallow-copied; every other node is
 * returned unchanged.
 *
 * `opacity`/`color` override the element's own authored `style.opacity`/
 * `style.color` outright (not blended with it) for whichever frame this
 * resolves a value at; `x`/`y` become a `transform: translate(...)`
 * prepended to whatever the element's own authored `style.transform`
 * already is (see `prependTranslate`'s own doc for why prepended, not
 * appended).
 */
export function applyElementAnimations(
  element: LayerElement,
  resolvedStyles: Readonly<Record<string, ResolvedElementStyle>>,
): LayerElement {
  const children = element.children?.map((child) =>
    typeof child === "string" ? child : applyElementAnimations(child, resolvedStyles),
  );
  const own = element.id !== undefined ? resolvedStyles[element.id] : undefined;

  if (own === undefined) {
    return children === undefined ? element : { ...element, children };
  }

  const transform =
    own.x !== undefined || own.y !== undefined
      ? prependTranslate(element.style?.transform, own.x, own.y)
      : element.style?.transform;

  return {
    ...element,
    ...(children !== undefined && { children }),
    style: {
      ...element.style,
      ...(own.opacity !== undefined && { opacity: own.opacity }),
      ...(own.color !== undefined && { color: colorToCss(own.color) }),
      ...(transform !== undefined && { transform }),
    },
  };
}
