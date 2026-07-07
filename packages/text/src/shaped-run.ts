import type { TextDirection } from "./bidi-resolution.js";

/** One positioned glyph produced by shaping, in font units (see `ParsedFont.metrics.unitsPerEm`). */
export interface ShapedGlyph {
  /** The font's glyph id (post-shaping; not a Unicode code point). */
  glyphId: number;
  /**
   * The UTF-16 index in the original run's source text this glyph maps
   * back to. Multiple glyphs can share a cluster (one character producing
   * several glyphs) and multiple characters can share a cluster (a
   * ligature); see Phase 44/50's per-glyph and grapheme-safe splitting,
   * which both key off this field.
   */
  cluster: number;
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
  /** Raw HarfBuzz glyph flags (e.g. unsafe-to-break); see harfbuzzjs's `GlyphFlag`. */
  flags: number;
}

/** One shaped, positioned run of text: a single script and direction, ready to place. */
export interface ShapedTextRun {
  /** UTF-16 start index into the original full string this run came from. */
  start: number;
  /** UTF-16 end index (exclusive) into the original full string this run came from. */
  end: number;
  /** This run's own substring of the original full string (`fullString.slice(start, end)`), before mirroring/shaping. */
  text: string;
  script: string;
  direction: TextDirection;
  /**
   * The bidi embedding level this run's `direction` was derived from
   * (`isRtlLevel(level) === (direction === "rtl")`). `shapeText` reorders
   * runs to visual order using this and then discards it; the paragraph
   * layout engine (Phase 45) needs it kept, since after it slices a
   * paragraph's logically-ordered runs into lines, each line's own runs
   * must be independently re-reordered to visual order (`shapeText`'s
   * paragraph-wide reordering does not know about line breaks it never
   * computed).
   */
  level: number;
  language?: string;
  glyphs: readonly ShapedGlyph[];
}
