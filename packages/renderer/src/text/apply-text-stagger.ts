import type { TextStaggerConfig } from "@cadra/core";
import { type PositionedGlyph, resolveGlyphStaggerStates } from "@cadra/text/browser";
import * as THREE from "three";

/**
 * Applies a `TextNode`'s own `stagger` config to the already-built glyph
 * meshes inside `group` (`buildTextGroup`'s own output), at `frame`: every
 * glyph belonging to some unit (`resolveGlyphStaggerStates`) gets its own
 * mesh looked up by `build-text-group.ts`'s own `glyph-{cluster}-{glyphId}`
 * naming, then has its resolved `offsetY` (added on top of the mesh's own
 * `userData.basePosition`, tagged at build time) and/or `opacity`
 * (`userData.setOpacity`, routing around the flat MSDF path's TSL-uniform
 * opacity so the classic `material.opacity` property, which that path
 * ignores entirely, is never relied on) applied directly.
 *
 * Every glyph is addressed individually (not via `build-text-group.ts`'s
 * own line/word `Group` nodes), even for `"word"`/`"line"` grouping: since
 * every glyph in the same unit resolves to the exact same state (see
 * `resolveGlyphStaggerStates`'s own doc), offsetting/fading each of that
 * unit's own glyph meshes by the identical amount is visually identical to
 * offsetting/fading their shared parent group once, while keeping this
 * function's own logic uniform across all four granularities rather than
 * bifurcated between "group-level" and "mesh-level" application.
 *
 * A glyph whose mesh cannot be found (should not happen for a `group` this
 * same `glyphs` array actually built) is silently skipped, matching this
 * renderer's existing defensive style elsewhere rather than throwing mid-
 * frame over one glyph.
 */
export function applyTextStagger(
  group: THREE.Group,
  glyphs: readonly PositionedGlyph[],
  stagger: TextStaggerConfig,
  frame: number,
  lineTexts?: readonly string[],
): void {
  const glyphStates = resolveGlyphStaggerStates(glyphs, stagger, frame, lineTexts);

  for (const { glyphIndex, state } of glyphStates) {
    const glyph = glyphs[glyphIndex];
    if (glyph === undefined) {
      continue;
    }
    const mesh = group.getObjectByName(`glyph-${glyph.cluster}-${glyph.glyphId}`);
    if (!(mesh instanceof THREE.Mesh)) {
      continue;
    }

    if (state.offsetY !== undefined) {
      const basePosition = mesh.userData["basePosition"] as THREE.Vector3 | undefined;
      if (basePosition !== undefined) {
        mesh.position.set(basePosition.x, basePosition.y + state.offsetY, basePosition.z);
      }
    }

    if (state.opacity !== undefined) {
      const setOpacity = mesh.userData["setOpacity"] as ((a: number) => void) | undefined;
      setOpacity?.(state.opacity);
    }
  }
}
