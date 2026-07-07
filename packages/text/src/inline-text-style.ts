import type { ColorRGBA } from "@cadra/core";

import type { ParsedFont } from "./parsed-font.js";

/**
 * Per-span style overrides for one `ParagraphSpan`, layered on top of the
 * paragraph's own base font/size/color: any field left `undefined` inherits
 * the paragraph's base value. `font` (a genuinely distinct `ParsedFont`,
 * e.g. a separate bold static instance) is how this engine supports a
 * "weight" override - not variable-font variation coordinates on the same
 * font file, since MSDF atlas generation (`msdf-atlas.ts`) loads a font's
 * glyph outlines directly from its raw bytes with no variation-coordinate
 * input, so instancing the same file differently would render identically
 * either way. A distinct font file naturally gets its own atlas (grouped by
 * content hash, see `prepareParagraphRenderData`), sidestepping that gap
 * entirely.
 */
export interface InlineTextStyle {
  font?: ParsedFont;
  /** Multiplies the paragraph's own base font size for this span (e.g. `1.5` for a bigger word). Defaults to `1`. */
  fontSizeScale?: number;
  color?: ColorRGBA;
  /** Extra em-unit advance added after every glyph in this span (letter-spacing). Defaults to `0`. */
  tracking?: number;
  /** OpenType feature toggles for this span, same shape as `ShapeTextOptions.features`. Defaults to the paragraph's own base features. */
  features?: Readonly<Record<string, boolean>>;
}

/** One inline-styled span of a paragraph's text: plain text plus optional style overrides. */
export interface ParagraphSpan {
  text: string;
  style?: InlineTextStyle;
}
