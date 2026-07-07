import {
  computeStaggerRanks,
  type ResolvedTextUnitState,
  resolveTextUnitState,
  type TextStaggerConfig,
} from "@cadra/core";

import type { PositionedGlyph } from "./glyph-layout.js";
import { splitTextUnits } from "./text-units.js";

/** One glyph's own resolved stagger state, addressed by its index into the `glyphs` array `resolveGlyphStaggerStates` was given. */
export interface GlyphStaggerState {
  glyphIndex: number;
  state: ResolvedTextUnitState;
}

/**
 * Splits `glyphs` into `stagger.grouping`-sized units (`splitTextUnits`),
 * ranks them by `stagger.direction` (`computeStaggerRanks`), and resolves
 * every glyph belonging to some unit to that unit's own state at `frame`
 * (`resolveTextUnitState`) - the one function that turns a `TextNode`'s
 * `stagger` config plus its own laid-out glyphs into exactly what a
 * renderer needs to apply, with no Three.js or other rendering-target
 * dependency of its own.
 *
 * Every glyph in the same unit shares the identical `state` object (not
 * independently recomputed per glyph), since a unit's state depends only on
 * its own rank, never on which particular glyph within it is being looked
 * up.
 *
 * `lineTexts` is forwarded to `splitTextUnits` and is required exactly when
 * `stagger.grouping === "grapheme"` (see that function's own doc for the
 * exact per-line-text contract).
 */
export function resolveGlyphStaggerStates(
  glyphs: readonly PositionedGlyph[],
  stagger: TextStaggerConfig,
  frame: number,
  lineTexts?: readonly string[],
): readonly GlyphStaggerState[] {
  const units = splitTextUnits(glyphs, stagger.grouping, lineTexts);
  const ranks = computeStaggerRanks(units.length, stagger.direction ?? "forward");

  const results: GlyphStaggerState[] = [];
  units.forEach((unit, unitIndex) => {
    const rank = ranks[unitIndex] as number;
    const state = resolveTextUnitState(stagger, rank, frame);
    for (const glyphIndex of unit.glyphIndices) {
      results.push({ glyphIndex, state });
    }
  });
  return results;
}
