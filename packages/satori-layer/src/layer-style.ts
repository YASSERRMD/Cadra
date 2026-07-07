/**
 * A curated, typed subset of CSS a `LayerElement` can carry, restricted to
 * exactly what Satori itself implements (verified against Satori's own
 * supported-CSS documentation; Satori is a from-scratch layout and
 * rendering engine, not a browser, so it recognizes only a fixed subset of
 * real CSS - anything outside this type would silently do nothing or throw
 * inside Satori, which a hand-authored raw style object could not catch at
 * compile time). Property names match Satori's own (React-style camelCase)
 * so no translation is needed when this is handed to Satori; see
 * `layer-to-satori-node.ts`.
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
