import type { TextStaggerGrouping } from "@cadra/core";

import type { PositionedGlyph } from "./glyph-layout.js";
import { splitTextUnits, type TextUnit } from "./text-units.js";

/** One glyph's own resolved morph state, addressed by its index into whichever of `fromGlyphs`/`toGlyphs` it belongs to (see `source`). */
export interface GlyphMorphState {
  glyphIndex: number;
  source: "from" | "to";
  opacity: number;
  /** Added on top of this glyph's own natural (already-laid-out) position. */
  offsetX: number;
  offsetY: number;
}

/** A representative "center" position for one unit: the average quad center of every glyph belonging to it, robust to multi-glyph units (e.g. a `"word"`-grouped unit spanning several characters) without needing to pick and justify any single one of them as "the" position. */
function unitCenter(glyphs: readonly PositionedGlyph[], unit: TextUnit): { x: number; y: number } {
  let sumX = 0;
  let sumY = 0;
  for (const glyphIndex of unit.glyphIndices) {
    const glyph = glyphs[glyphIndex] as PositionedGlyph;
    sumX += (glyph.quad.left + glyph.quad.right) / 2;
    sumY += (glyph.quad.bottom + glyph.quad.top) / 2;
  }
  return { x: sumX / unit.glyphIndices.length, y: sumY / unit.glyphIndices.length };
}

/**
 * Linear interpolation, structured so a boundary `t` of exactly `0` or `1`
 * subtracts an identical value from itself (`lerp(a, b, 0) - a` below,
 * `lerp(a, b, 1) - b`) rather than multiplying a signed delta by a zero
 * whose own sign depends on the delta - the former always exactly cancels
 * to `+0`, the latter can produce `-0` (e.g. `(-5) * 0 === -0`), which
 * fails a `toBe(0)`/`toEqual` (`Object.is`) determinism assertion despite
 * being numerically equal.
 */
function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Resolves a `TextMorphConfig`'s own crossfade at `progress`, matching
 * `fromGlyphs`'/`toGlyphs`' own `grouping`-sized units by their shared
 * reading-order index (`TextUnit.index`, from `splitTextUnits` - the same
 * index space `resolveGlyphStaggerStates`/`resolveGlyphPhysicsStates`
 * already rank by).
 *
 * A unit index present in *both* texts is a matched pair: both its `from`
 * and `to` glyphs are resolved to travel along the exact same path between
 * the two units' own natural center positions (`offsetX`/`offsetY` computed
 * relative to each glyph's own natural position specifically, so the two
 * converge to one identical absolute position at any given `progress`,
 * rather than each independently drifting), with `from` fading out
 * (`opacity: 1 - progress`) as `to` fades in (`opacity: progress`) - not a
 * true vertex-level outline morph (matching glyph shapes into one
 * continuously-deforming mesh is a substantially harder, unrelated
 * problem: `@cadra/renderer`'s glyph geometry is either a flat MSDF-quad or
 * an extruded solid built once per glyph id, neither of which has any
 * notion of "the shape halfway between letter A and letter B" - see
 * `build-text-group.ts`), but a transform-based crossfade, exactly what
 * `TextMorphConfig`'s own doc already documents as the deliberate scope.
 *
 * A unit index present in only one of the two texts (`from`/`to` of
 * different lengths - Phase 52's own task 4) has nothing to travel toward:
 * it simply fades in or out in place, at its own natural position, `offsetX`/
 * `offsetY` staying `0`.
 */
export function resolveGlyphMorphStates(
  fromGlyphs: readonly PositionedGlyph[],
  toGlyphs: readonly PositionedGlyph[],
  grouping: TextStaggerGrouping,
  progress: number,
  fromLineTexts?: readonly string[],
  toLineTexts?: readonly string[],
): readonly GlyphMorphState[] {
  const fromUnits = splitTextUnits(fromGlyphs, grouping, fromLineTexts);
  const toUnits = splitTextUnits(toGlyphs, grouping, toLineTexts);

  const results: GlyphMorphState[] = [];
  const unitCount = Math.max(fromUnits.length, toUnits.length);

  for (let unitIndex = 0; unitIndex < unitCount; unitIndex += 1) {
    const fromUnit = fromUnits[unitIndex];
    const toUnit = toUnits[unitIndex];

    if (fromUnit !== undefined && toUnit !== undefined) {
      const fromCenter = unitCenter(fromGlyphs, fromUnit);
      const toCenter = unitCenter(toGlyphs, toUnit);
      const absoluteX = lerpNumber(fromCenter.x, toCenter.x, progress);
      const absoluteY = lerpNumber(fromCenter.y, toCenter.y, progress);

      for (const glyphIndex of fromUnit.glyphIndices) {
        results.push({
          glyphIndex,
          source: "from",
          opacity: 1 - progress,
          offsetX: absoluteX - fromCenter.x,
          offsetY: absoluteY - fromCenter.y,
        });
      }
      for (const glyphIndex of toUnit.glyphIndices) {
        results.push({
          glyphIndex,
          source: "to",
          opacity: progress,
          offsetX: absoluteX - toCenter.x,
          offsetY: absoluteY - toCenter.y,
        });
      }
    } else if (fromUnit !== undefined) {
      for (const glyphIndex of fromUnit.glyphIndices) {
        results.push({ glyphIndex, source: "from", opacity: 1 - progress, offsetX: 0, offsetY: 0 });
      }
    } else if (toUnit !== undefined) {
      for (const glyphIndex of toUnit.glyphIndices) {
        results.push({ glyphIndex, source: "to", opacity: progress, offsetX: 0, offsetY: 0 });
      }
    }
  }

  return results;
}
