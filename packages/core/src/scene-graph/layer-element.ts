/**
 * The pure-data shape of a Satori 2D layer's element tree (`SatoriNode.layer`,
 * `scene-node.ts`): a curated, typed subset of HTML/CSS, restricted to
 * exactly what Satori (`@cadra/satori-layer`'s rendering engine) itself
 * implements. Defined here, in `@cadra/core`, rather than in
 * `@cadra/satori-layer` itself, since `@cadra/satori-layer` already depends
 * on `@cadra/core` (for `ColorRGBA`/`Property`/etc.) - the reverse dependency
 * would be circular. `@cadra/satori-layer` re-exports these same types
 * rather than redefining its own copy, so there is exactly one
 * canonical definition.
 */

/**
 * The four element kinds this layer spec supports: `"div"` (a flexbox
 * container, the workhorse of any layout), `"span"` (an inline text run,
 * for styling part of a line differently from its surroundings), `"img"`
 * (an embedded raster or vector image), and `"icon"` (a named icon from a
 * bundled icon set, resolved to an image ahead of Satori ever seeing it;
 * see `@cadra/satori-layer`'s `resolveIconElements`). This is Satori's own
 * "constrained HTML subset" (its README's phrase) for the first three,
 * narrowed to exactly the tags every layout, typography, and
 * image-embedding need in practice actually requires - not the full HTML
 * tag set Satori happens to recognize, which also includes heading/
 * paragraph tags whose only practical difference from `div`/`span` here is
 * a preset default style this spec does not rely on (every style is
 * authored explicitly). `"icon"` is not a real HTML tag at all: it is this
 * spec's own first-class ergonomic layer over `"img"`, so an author names
 * an icon rather than having to already have a raw SVG/data URI in hand.
 */
export type LayerElementType = "div" | "span" | "img" | "icon";

/**
 * A curated, typed subset of CSS a `LayerElement` can carry, restricted to
 * exactly what Satori itself implements (verified against Satori's own
 * supported-CSS documentation; Satori is a from-scratch layout and
 * rendering engine, not a browser, so it recognizes only a fixed subset of
 * real CSS - anything outside this type would silently do nothing or throw
 * inside Satori, which a hand-authored raw style object could not catch at
 * compile time). Property names match Satori's own (React-style camelCase)
 * so no translation is needed when this is handed to Satori.
 */
export interface LayerStyle {
  display?: "flex" | "none";
  position?: "relative" | "absolute" | "static";
  top?: number | string;
  right?: number | string;
  bottom?: number | string;
  left?: number | string;

  width?: number | string;
  height?: number | string;
  minWidth?: number | string;
  minHeight?: number | string;
  maxWidth?: number | string;
  maxHeight?: number | string;

  margin?: number | string;
  marginTop?: number | string;
  marginRight?: number | string;
  marginBottom?: number | string;
  marginLeft?: number | string;
  padding?: number | string;
  paddingTop?: number | string;
  paddingRight?: number | string;
  paddingBottom?: number | string;
  paddingLeft?: number | string;

  flexDirection?: "row" | "row-reverse" | "column" | "column-reverse";
  flexWrap?: "wrap" | "nowrap" | "wrap-reverse";
  flexGrow?: number;
  flexShrink?: number;
  flexBasis?: number | string;
  alignItems?: "stretch" | "center" | "flex-start" | "flex-end" | "baseline" | "normal";
  alignContent?: string;
  alignSelf?: string;
  justifyContent?:
    | "flex-start"
    | "flex-end"
    | "center"
    | "space-between"
    | "space-around"
    | "space-evenly";
  gap?: number | string;
  rowGap?: number | string;
  columnGap?: number | string;

  color?: string;
  fontFamily?: string;
  fontSize?: number | string;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  lineHeight?: number | string;
  letterSpacing?: number | string;
  textAlign?: "start" | "end" | "left" | "right" | "center" | "justify";
  textTransform?: "none" | "lowercase" | "uppercase" | "capitalize";
  textOverflow?: "clip" | "ellipsis";
  textDecoration?: string;
  whiteSpace?: "normal" | "pre" | "pre-wrap" | "pre-line" | "nowrap";
  wordBreak?: "normal" | "break-all" | "break-word" | "keep-all";
  textShadow?: string;

  backgroundColor?: string;
  /** A raw CSS `linear-gradient(...)`/`radial-gradient(...)`/`url(...)` value, parsed by Satori itself: no structured gradient type is exposed here since Satori's own gradient grammar already covers this well and re-typing it would just duplicate CSS syntax. */
  backgroundImage?: string;
  backgroundPosition?: string;
  backgroundSize?: string;
  backgroundRepeat?: "repeat" | "repeat-x" | "repeat-y" | "no-repeat";

  /** Shorthand, e.g. `"1px solid #000"`. */
  border?: string;
  borderWidth?: number | string;
  borderColor?: string;
  borderStyle?: "solid" | "dashed";
  borderRadius?: number | string;
  borderTopLeftRadius?: number | string;
  borderTopRightRadius?: number | string;
  borderBottomLeftRadius?: number | string;
  borderBottomRightRadius?: number | string;

  /** A raw CSS `box-shadow` value (Satori supports multiple comma-separated shadows, same as real CSS). */
  boxShadow?: string;
  opacity?: number;
  overflow?: "visible" | "hidden";

  /** A raw CSS `transform` value (translate/rotate/scale/skew; Satori does not support 3D transforms). */
  transform?: string;
  transformOrigin?: string;

  objectFit?: "fill" | "contain" | "cover" | "none" | "scale-down";
  objectPosition?: string;
}

/**
 * One node in a layer's element tree: a typed, agent-safe alternative to
 * raw JSX or HTML (this is the only input `@cadra/satori-layer`'s
 * `renderLayerToSvg` accepts), so a caller (an agent or a UI) can only ever
 * construct something its Satori-node conversion knows how to translate,
 * rather than a string that might contain an unsupported tag or a typo'd
 * property name that would silently do nothing inside Satori.
 */
export interface LayerElement {
  /**
   * Optional stable identifier, unique within one `SatoriNode.layer` tree.
   * Not read by Satori itself at all (it is not copied into Satori's own
   * `props`); its only purpose is as a lookup key for
   * `SatoriNode.elementAnimations`, so an individual element within a
   * layer can be targeted for its own per-frame animation independent of
   * the rest of the tree (Phase 48's "named element handles").
   */
  id?: string;
  type: LayerElementType;
  style?: LayerStyle;
  /** Text content and/or nested elements, in document order (Satori paints later siblings on top of earlier ones; there is no `z-index` in SVG). `icon` elements never have children. */
  children?: ReadonlyArray<LayerElement | string>;
  /** `img` only: the image source, a `data:` URI (recommended - no I/O needed) or an `http(s)://` URL. */
  src?: string;
  /** `icon` only: a bundled icon's name (Lucide's own kebab-case names, e.g. `"arrow-right"`), resolved to an `img` ahead of Satori ever seeing it. Recolored from `style.color` when set (via `stroke`/`fill: currentColor`, every bundled icon's own convention), otherwise rendered in the icon's own default color. */
  icon?: string;
  /** `img`/`icon` only, in layer units (recommended for `img`: Satori stretches an unsized image to fill its element; `icon` defaults to its bundled icon set's own native size, currently 24 for Lucide, when omitted). */
  width?: number;
  height?: number;
  /** BCP-47-ish language tag, e.g. `"ja-JP"`, forcing which locale-specific font/shaping Satori uses for this element's own text (see Satori's own `Locale` support). */
  lang?: string;
}
