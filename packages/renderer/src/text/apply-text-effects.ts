import type { TextPhysicsConfig, TextStaggerConfig } from "@cadra/core";
import {
  type PositionedGlyph,
  resolveGlyphPhysicsStates,
  resolveGlyphStaggerStates,
} from "@cadra/text/browser";
import * as THREE from "three";

export interface TextEffectsOptions {
  stagger?: TextStaggerConfig;
  physics?: TextPhysicsConfig;
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
 * Applies a `TextNode`'s own `stagger` and/or `physics` config to the
 * already-built glyph meshes inside `group` (`buildTextGroup`'s own
 * output), at `frame`. Supersedes Phase 50's own `applyTextStagger`: the
 * two effects genuinely compose (Phase 51's own task 4) rather than being
 * mutually exclusive, e.g. a `fadeInUp` stagger reveal with a continuous
 * `jitter` physics wobble layered on top once each glyph is visible, so
 * this resolves both independently and merges them onto each glyph's own
 * mesh in one pass:
 *
 * - **Position**: `stagger`'s own `offsetY` and `physics`'s own `offsetX`/
 *   `offsetY` are all added on top of the mesh's own `userData.basePosition`
 *   (tagged at build time) - additive, so a jitter wobble rides on top of
 *   wherever the stagger reveal currently has the glyph, not instead of it.
 * - **Rotation/scale**: `physics`-only concepts (`stagger` has no notion of
 *   either); always recomputed fresh from `physics`'s own resolved state
 *   (defaulting to no rotation / natural scale), never accumulated, so
 *   re-applying at any frame is idempotent regardless of what a prior frame
 *   left the mesh at.
 * - **Opacity**: multiplied together when both resolve one (so either
 *   effect being "not yet visible" keeps the glyph hidden), applied via
 *   `userData.setOpacity` (routing around the flat MSDF path's TSL-uniform
 *   opacity, which the classic `material.opacity` property does not affect
 *   at all).
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
  if (options.stagger === undefined && options.physics === undefined) {
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

  const glyphIndices = new Set([...staggerByGlyphIndex.keys(), ...physicsByGlyphIndex.keys()]);

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

    const basePosition = mesh.userData["basePosition"] as THREE.Vector3 | undefined;
    if (basePosition !== undefined) {
      const offsetX = physicsState?.offsetX ?? 0;
      const offsetY = (staggerState?.offsetY ?? 0) + (physicsState?.offsetY ?? 0);
      mesh.position.set(basePosition.x + offsetX, basePosition.y + offsetY, basePosition.z);
    }

    mesh.rotation.z = physicsState?.rotationZ ?? 0;
    const scale = physicsState?.scale ?? 1;
    mesh.scale.set(scale, scale, scale);

    const opacity = combineOpacity(staggerState?.opacity, physicsState?.opacity);
    if (opacity !== undefined) {
      const setOpacity = mesh.userData["setOpacity"] as ((a: number) => void) | undefined;
      setOpacity?.(opacity);
    }
  }
}
