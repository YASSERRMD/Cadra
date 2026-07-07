import type { LayerElement } from "./layer-element.js";

/**
 * The shape Satori itself accepts without needing an actual React runtime:
 * "React-elements-like objects that have `type`, `props.children` and
 * `props.style`" (Satori's own README, under "Use without JSX"). Kept
 * local rather than imported from `react` so this module's own output type
 * says exactly what it produces, not React's much larger `ReactElement`.
 */
export interface SatoriElement {
  type: string;
  props: Record<string, unknown>;
}

/**
 * Converts a typed `LayerElement` tree into the plain-object element shape
 * Satori consumes directly (see `SatoriElement`'s own doc): a mechanical,
 * lossless translation - every `LayerElement` field maps to exactly one
 * Satori prop, so nothing here interprets or validates CSS values, that is
 * entirely Satori's own job when it lays out and paints the result.
 */
export function layerElementToSatoriNode(element: LayerElement): SatoriElement {
  const props: Record<string, unknown> = {};

  if (element.style !== undefined) {
    props["style"] = element.style;
  }
  if (element.lang !== undefined) {
    props["lang"] = element.lang;
  }

  if (element.type === "img") {
    if (element.src !== undefined) {
      props["src"] = element.src;
    }
    if (element.width !== undefined) {
      props["width"] = element.width;
    }
    if (element.height !== undefined) {
      props["height"] = element.height;
    }
  } else if (element.children !== undefined) {
    props["children"] =
      element.children.length === 1 && typeof element.children[0] === "string"
        ? element.children[0]
        : element.children.map((child) => (typeof child === "string" ? child : layerElementToSatoriNode(child)));
  }

  return { type: element.type, props };
}
