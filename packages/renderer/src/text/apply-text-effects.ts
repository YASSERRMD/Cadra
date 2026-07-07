import type { TextPathConfig, TextPhysicsConfig, TextStaggerConfig } from "@cadra/core";
import {
  type PositionedGlyph,
  resolveGlyphPathStates,
  resolveGlyphPhysicsStates,
  resolveGlyphStaggerStates,
} from "@cadra/text/browser";
import * as THREE from "three";

export interface TextEffectsOptions {
  stagger?: TextStaggerConfig;
  physics?: TextPhysicsConfig;
  path?: TextPathConfig;
}

/** `a * b`, treating a missing side as `1` (identity for multiplication) - `undefined` only when *both* sides are, meaning neither effect touched opacity at all this frame. */
function combineOpacity(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  return a * b;
}

/**
 * Applies a `TextNode`'s own `stagger`, `physics`, and/or `path` config to
 * the already-built glyph meshes inside `group` (`buildTextGroup`'s own
 * output), at `frame`. Supersedes Phase 50's own `applyTextStagger`: all
 * three effects genuinely compose (Phase 51's own task 4, extended by
 * Phase 52's own task 2 to include `path`), e.g. text laid out along a
 * curve (`path`) that also jitters (`physics`) as it staggers into view
 * (`stagger`), so this resolves all three independently and merges them
 * onto each glyph's own mesh in one pass:
 *
 * - **Position**: `stagger`'s own `offsetY` and `physics`'s own `offsetX`/
 *   `offsetY` are added on top of the mesh's own `userData.basePosition`
 *   (tagged at build time), same as before `path` existed. `path`'s own
 *   `x`/`y` are instead *absolute* targets (see `resolveGlyphPathStates`'s
 *   own doc on why: the offset actually needed to reach them depends on
 *   which convention this specific mesh's own `basePosition` was built
 *   from, flat-MSDF vs extruded, information only available here), so this
 *   function itself derives an offset from them (`x - basePosition.x`) - the
 *   net effect still lands a physics-free glyph exactly on the curve, while
 *   still leaving room for `physics`'s own offset to ride on top of it, not
 *   instead of it. `path`'s own `offsetZ`, unlike `x`/`y`, already is an
 *   offset (see that same doc for why depth has no equivalent mismatch).
 * - **Rotation**: `physics`'s own `rotationZ` (a wobble) and `path`'s own
 *   `rotationZ` (tangent alignment) add together, for the same reason;
 *   neither has any notion of the other, so either alone still just works.
 * - **Scale**: `physics`-only; always recomputed fresh from its own
 *   resolved state (defaulting to natural scale), never accumulated, so
 *   re-applying at any frame is idempotent regardless of what a prior frame
 *   left the mesh at. `path` has no scale notion (see this module's own
 *   sibling doc on `resolveGlyphPathStates` for why a path only ever
 *   rescales the text's own overall span, never an individual glyph).
 * - **Opacity**: `stagger`'s own and `physics`'s own multiply together when
 *   both resolve one (so either effect being "not yet visible" keeps the
 *   glyph hidden), applied via `userData.setOpacity` (routing around the
 *   flat MSDF path's TSL-uniform opacity, which the classic
 *   `material.opacity` property does not affect at all). `path` has no
 *   opacity notion either.
 *
 * Every glyph is addressed individually (not via `build-text-group.ts`'s
 * own line/word `Group` nodes), even for `"word"`/`"line"` grouping: every
 * glyph in the same unit resolves to the exact same state (see
 * `resolveGlyphStaggerStates`/`resolveGlyphPhysicsStates`'s own doc), so
 * offsetting/fading each of that unit's own glyph meshes by the identical
 * amount is visually identical to touching their shared parent group once,
 * while keeping this function's own logic uniform across all four
 * granularities. A glyph whose mesh cannot be found (should not happen for
 * a `group` this same `glyphs` array actually built) is silently skipped.
 */
export function applyTextEffects(
  group: THREE.Group,
  glyphs: readonly PositionedGlyph[],
  options: TextEffectsOptions,
  frame: number,
  lineTexts?: readonly string[],
): void {
  if (options.stagger === undefined && options.physics === undefined && options.path === undefined) {
    return;
  }

  const staggerByGlyphIndex = new Map(
    (options.stagger !== undefined
      ? resolveGlyphStaggerStates(glyphs, options.stagger, frame, lineTexts)
      : []
    ).map(({ glyphIndex, state }) => [glyphIndex, state]),
  );
  const physicsByGlyphIndex = new Map(
    (options.physics !== undefined
      ? resolveGlyphPhysicsStates(glyphs, options.physics, frame, lineTexts)
      : []
    ).map(({ glyphIndex, state }) => [glyphIndex, state]),
  );
  const pathByGlyphIndex = new Map(
    (options.path !== undefined ? resolveGlyphPathStates(glyphs, options.path, frame) : []).map((state) => [
      state.glyphIndex,
      state,
    ]),
  );

  const glyphIndices = new Set([
    ...staggerByGlyphIndex.keys(),
    ...physicsByGlyphIndex.keys(),
    ...pathByGlyphIndex.keys(),
  ]);

  for (const glyphIndex of glyphIndices) {
    const glyph = glyphs[glyphIndex];
    if (glyph === undefined) {
      continue;
    }
    const mesh = group.getObjectByName(`glyph-${glyph.cluster}-${glyph.glyphId}`);
    if (!(mesh instanceof THREE.Mesh)) {
      continue;
    }

    const staggerState = staggerByGlyphIndex.get(glyphIndex);
    const physicsState = physicsByGlyphIndex.get(glyphIndex);
    const pathState = pathByGlyphIndex.get(glyphIndex);

    const basePosition = mesh.userData["basePosition"] as THREE.Vector3 | undefined;
    if (basePosition !== undefined) {
      const pathOffsetX = pathState !== undefined ? pathState.x - basePosition.x : 0;
      const pathOffsetY = pathState !== undefined ? pathState.y - basePosition.y : 0;
      const offsetX = (physicsState?.offsetX ?? 0) + pathOffsetX;
      const offsetY = (staggerState?.offsetY ?? 0) + (physicsState?.offsetY ?? 0) + pathOffsetY;
      const offsetZ = pathState?.offsetZ ?? 0;
      mesh.position.set(basePosition.x + offsetX, basePosition.y + offsetY, basePosition.z + offsetZ);
    }

    mesh.rotation.z = (physicsState?.rotationZ ?? 0) + (pathState?.rotationZ ?? 0);
    const scale = physicsState?.scale ?? 1;
    mesh.scale.set(scale, scale, scale);

    const opacity = combineOpacity(staggerState?.opacity, physicsState?.opacity);
    if (opacity !== undefined) {
      const setOpacity = mesh.userData["setOpacity"] as ((a: number) => void) | undefined;
      setOpacity?.(opacity);
    }
  }
}
