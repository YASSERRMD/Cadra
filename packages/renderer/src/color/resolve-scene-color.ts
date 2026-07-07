import type { ColorRGBA, WhiteBalanceGain } from "@cadra/core";
import * as THREE from "three";

/** A `ColorRGBA` after `resolveSceneColor`: no longer sRGB-encoded, and no longer neutral to white balance - the exact values every color-consuming THREE.js API this renderer touches (`Color.setRGB`, a TSL `Vector4` uniform) should receive with no further color-space argument, since they are already in the renderer's own working (linear) space. */
export type ResolvedSceneColor = readonly [r: number, g: number, b: number, a: number];

/**
 * Converts one authored (sRGB-encoded, the conventional assumption for a
 * hand-picked or eye-dropped color - see `ColorRGBA`'s own doc) scene-graph
 * color into this renderer's own linear working space, then applies the
 * composition's own white-balance gain - both in linear light, matching a
 * real camera's own white-balance correction, which is physically a
 * linear-space operation, not an sRGB-encoded one.
 *
 * This is the *one* place `ColorRGBA` values are converted at all: every
 * caller that used to construct a `THREE.Color`/color uniform directly
 * from a raw `ColorRGBA` now routes through here first, then hands the
 * result to that same API with no color-space argument (since it is
 * already in the correct space) - see `build-text-group.ts` and
 * `node-factory.ts`'s own `applyLightProperties`.
 *
 * Alpha is untouched: straight alpha has no color-space encoding of its
 * own to convert, and is not touched by a white-balance correction, which
 * only makes sense as a color/luminance adjustment.
 */
export function resolveSceneColor(color: ColorRGBA, whiteBalanceGain: WhiteBalanceGain): ResolvedSceneColor {
  const linear = new THREE.Color().setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace);
  return [linear.r * whiteBalanceGain[0], linear.g * whiteBalanceGain[1], linear.b * whiteBalanceGain[2], color[3]];
}
