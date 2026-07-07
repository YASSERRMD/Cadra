/**
 * Font-wide metrics needed by the layout engine (Phase 45) to place baselines
 * and lines: the font's internal coordinate grid size plus the four
 * vertical measurements every text layout computation is built from.
 */
export interface FontMetrics {
  /** The size of the font's internal coordinate grid (glyph coordinates are in this space). */
  unitsPerEm: number;
  /** The font's ascender, in font units. */
  ascent: number;
  /** The font's descender, in font units (typically negative). */
  descent: number;
  /** Extra spacing recommended between lines, in font units. */
  lineGap: number;
  /** The height of capital letters above the baseline, in font units. */
  capHeight: number;
  /** The height of lowercase letters (like "x") above the baseline, in font units. */
  xHeight: number;
}
