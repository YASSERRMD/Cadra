import { createTextPathSampler, resolveTextPath, type TextPathConfig } from "@cadra/core";

import type { PositionedGlyph } from "./glyph-layout.js";

/**
 * One glyph's own resolved path placement, addressed by its index into the
 * `glyphs` array `resolveGlyphPathStates` was given.
 *
 * `x`/`y` are the glyph's own *absolute* target position (in the same
 * em-space `PositionedGlyph.origin`/`quad` already use) - deliberately not
 * an offset relative to `origin`, unlike `ResolvedGlyphPhysicsState`:
 * `build-text-group.ts` positions a glyph mesh at `origin` for the
 * extrusion path but at its own quad *center* for the flat MSDF path, and
 * an offset computed against `origin` would land at the wrong place for
 * the latter (off by that glyph's own bearing, not a negligible amount).
 * Computing an actual offset against whichever convention a given mesh's
 * own `userData.basePosition` really uses only requires knowing `x`/`y`
 * (`apply-text-effects.ts` does the subtraction itself, since it is the
 * one place that already has `basePosition` on hand).
 *
 * `offsetZ`, by contrast, *is* an offset added on top of the mesh's own
 * `basePosition.z`, same as physics: every glyph's natural z is already
 * the same shared constant regardless of rendering path (`0` flat,
 * `-extrudeDepth / 2` extruded), so there is no equivalent bearing gap to
 * correct for, and staying additive means a path lying flat in the XY
 * plane (z `0` throughout) does not flatten extruded text's own depth.
 */
export interface GlyphPathState {
  glyphIndex: number;
  x: number;
  y: number;
  offsetZ: number;
  /** The glyph's own rotation to face the path's local tangent direction (`orientation: "tangent"`), or `0` (`orientation: "upright"`, the glyph keeps its natural upright rotation regardless of the curve). Z-axis-only, matching `ResolvedGlyphPhysicsState.rotationZ`'s own scope: genuinely tilting a glyph to face a tangent with a Z component would need a full 3D (quaternion) rotation, out of scope for the same reason per-glyph physics never grew beyond Z-axis rotation either. */
  rotationZ: number;
}

/**
 * Maps `glyphs` onto `path` at `frame`: each glyph's own natural horizontal
 * position (`origin.x`, the shaped pen position `build-text-group.ts` also
 * places extruded glyph geometry at directly) becomes a normalized `0`-`1`
 * fraction of its own text's natural span, which then maps to a `0`-`1`
 * fraction of the curve's own arc length (per `alignment`/`startOffset`/
 * `progress`, see `TextPathConfig`'s own doc), which `createTextPathSampler`
 * turns into a 3D point plus tangent - the text is always rescaled to fit
 * whatever portion of the curve it is mapped onto, regardless of its own
 * length in scene units (unlike, say, SVG's `textPath`, which keeps each
 * glyph at its own natural size and lets the text overflow a too-short
 * path instead).
 *
 * `spacing: "advance"` (the default) preserves each glyph's own natural
 * advance-width proportions within that span (an "i" narrower than an "m"
 * keeps that proportion along the curve too). `spacing: "even"` instead
 * ranks glyphs by that same natural `origin.x` (still respecting whatever
 * left-to-right visual order shaping produced, correct regardless of
 * script direction since `origin.x` is already a real resolved position,
 * not a logical cluster index) and spreads them at equal fractions of the
 * span instead.
 *
 * `alignment` picks which part of the text (`"start"`: its first unit,
 * `"center"`: its own midpoint, `"end"`: its last unit) is the one
 * positioned exactly at `startOffset`. `progress` scales how much of the
 * curve's own remaining length (from `startOffset` to the curve's own end,
 * `u = 1`) the text's full span is stretched across: `1` (the default)
 * uses all of it; less compresses the whole text into a shorter leading
 * portion, e.g. animating `progress` from `0` to `1` reveals the text
 * unfurling onto the curve rather than being statically placed on it.
 */
export function resolveGlyphPathStates(
  glyphs: readonly PositionedGlyph[],
  path: TextPathConfig,
  frame: number,
): readonly GlyphPathState[] {
  if (glyphs.length === 0) {
    return [];
  }

  const resolved = resolveTextPath(path, frame);
  const sampler = createTextPathSampler(resolved);

  const naturalXs = glyphs.map((glyph) => glyph.origin.x);
  const minX = Math.min(...naturalXs);
  const maxX = Math.max(...naturalXs);
  const textLength = maxX - minX;

  const evenFractionByGlyphIndex = new Map<number, number>();
  if (resolved.spacing === "even") {
    const sortedByNaturalX = glyphs
      .map((_glyph, glyphIndex) => glyphIndex)
      .sort((a, b) => (naturalXs[a] as number) - (naturalXs[b] as number));
    sortedByNaturalX.forEach((glyphIndex, rank) => {
      evenFractionByGlyphIndex.set(
        glyphIndex,
        sortedByNaturalX.length > 1 ? rank / (sortedByNaturalX.length - 1) : 0,
      );
    });
  }

  const anchorFraction = resolved.alignment === "center" ? 0.5 : resolved.alignment === "end" ? 1 : 0;
  const effectiveSpan = (1 - resolved.startOffset) * resolved.progress;

  const results: GlyphPathState[] = [];
  glyphs.forEach((glyph, glyphIndex) => {
    const naturalFraction =
      resolved.spacing === "even"
        ? (evenFractionByGlyphIndex.get(glyphIndex) as number)
        : textLength === 0
          ? 0
          : (glyph.origin.x - minX) / textLength;

    const u = resolved.startOffset + (naturalFraction - anchorFraction) * effectiveSpan;
    const sample = sampler.sampleAt(u);

    results.push({
      glyphIndex,
      x: sample.point[0],
      y: sample.point[1],
      offsetZ: sample.point[2],
      rotationZ: resolved.orientation === "tangent" ? Math.atan2(sample.tangent[1], sample.tangent[0]) : 0,
    });
  });
  return results;
}
