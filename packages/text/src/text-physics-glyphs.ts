import {
  computeStaggerRanks,
  type ResolvedGlyphPhysicsState,
  resolveGlyphPhysicsState,
  type TextPhysicsConfig,
} from "@cadra/core";

import type { PositionedGlyph } from "./glyph-layout.js";
import { splitTextUnits } from "./text-units.js";

/** One glyph's own resolved physics state, addressed by its index into the `glyphs` array `resolveGlyphPhysicsStates` was given. */
export interface GlyphPhysicsState {
  glyphIndex: number;
  state: ResolvedGlyphPhysicsState;
}

/**
 * Splits `glyphs` into `physics.grouping`-sized units (`splitTextUnits`),
 * ranks them by `physics.direction` (`computeStaggerRanks`), and resolves
 * every glyph belonging to some unit to that unit's own state at `frame`
 * (`resolveGlyphPhysicsState`) - the physics-effect mirror of
 * `resolveGlyphStaggerStates`, with the exact same "no rendering-target
 * dependency, every glyph in a unit shares the identical state object"
 * shape.
 *
 * `lineTexts` is forwarded to `splitTextUnits` and is required exactly when
 * `physics.grouping === "grapheme"`.
 */
export function resolveGlyphPhysicsStates(
  glyphs: readonly PositionedGlyph[],
  physics: TextPhysicsConfig,
  frame: number,
  lineTexts?: readonly string[],
): readonly GlyphPhysicsState[] {
  const units = splitTextUnits(glyphs, physics.grouping, lineTexts);
  const ranks = computeStaggerRanks(units.length, physics.direction ?? "forward");

  const results: GlyphPhysicsState[] = [];
  units.forEach((unit, unitIndex) => {
    const rank = ranks[unitIndex] as number;
    const state = resolveGlyphPhysicsState(physics, rank, frame);
    for (const glyphIndex of unit.glyphIndices) {
      results.push({ glyphIndex, state });
    }
  });
  return results;
}
