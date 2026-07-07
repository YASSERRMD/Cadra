import type { LayerStyle } from "./layer-style.js";

/**
 * The three element kinds this layer spec supports: `"div"` (a flexbox
 * container, the workhorse of any layout), `"span"` (an inline text run,
 * for styling part of a line differently from its surroundings), and
 * `"img"` (an embedded raster or vector image). This is Satori's own
 * "constrained HTML subset" (its README's phrase), narrowed to exactly the
 * three tags every layout, typography, and image-embedding need in
 * practice actually requires - not the full HTML tag set Satori happens to
 * recognize, which also includes heading/paragraph tags whose only
 * practical difference from `div`/`span` here is a preset default style
 * this spec does not rely on (every style is authored explicitly).
 */
export type LayerElementType = "div" | "span" | "img";

/**
 * One node in a layer's element tree: a typed, agent-safe alternative to
 * raw JSX or HTML (this package never parses HTML or evaluates arbitrary
 * markup - a `LayerElement` tree is the only input `renderLayerToSvg`
 * accepts), so a caller (an agent or a UI) can only ever construct
 * something `layerElementToSatoriNode` knows how to translate, rather than
 * a string that might contain an unsupported tag or a typo'd property name
 * that would silently do nothing inside Satori.
 */
export interface LayerElement {
  type: LayerElementType;
  style?: LayerStyle;
  /** Text content and/or nested elements, in document order (Satori paints later siblings on top of earlier ones; there is no `z-index` in SVG). */
  children?: ReadonlyArray<LayerElement | string>;
  /** `img` only: the image source, a `data:` URI (recommended - no I/O needed) or an `http(s)://` URL. */
  src?: string;
  /** `img` only, in layer units (recommended: Satori stretches an unsized image to fill its element). */
  width?: number;
  height?: number;
  /** BCP-47-ish language tag, e.g. `"ja-JP"`, forcing which locale-specific font/shaping Satori uses for this element's own text (see Satori's own `Locale` support). */
  lang?: string;
}
