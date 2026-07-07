import * as THREE from "three";
import { Fn, fwidth, max, min, smoothstep, texture, uniform, uv } from "three/tsl";
import { MeshBasicNodeMaterial, type Node } from "three/webgpu";

/**
 * A material plus the live uniform handles to mutate it per frame, since
 * TSL node materials build their shader graph once; updating a uniform's
 * own `.value` (rather than reassigning `colorNode`) is how a per-frame
 * color/opacity change reaches the GPU without rebuilding that graph.
 */
export interface MsdfTextMaterialHandle {
  material: THREE.Material;
  setColor(r: number, g: number, b: number, a: number): void;
  /** Updates only this material's own opacity uniform, leaving its color uniform untouched - `apply-text-stagger.ts`'s own per-glyph reveal needs this independent of `setColor`, since a caller staggering opacity has no reason to already know (and so redundantly re-supply) a glyph's current resolved color. */
  setOpacity(a: number): void;
}

/**
 * Builds the standard MSDF (multi-channel signed distance field) alpha test:
 * sample the atlas, take the median of its three channels (msdfgen's own
 * encoding - the true signed distance is whichever of the three channels is
 * *not* the extremum, which `median(r, g, b)` recovers), and anti-alias the
 * 0.5 edge with `fwidth`-based screen-space derivatives rather than the
 * atlas's own fixed pixel range, so the same atlas stays crisp whether a
 * glyph fills the screen or is shrunk to a few pixels.
 *
 * Built with `three/tsl` (not a raw `THREE.ShaderMaterial`/GLSL) so it
 * compiles correctly under both backends `packages/renderer` supports
 * (`WebGPURenderer` and the `WebGLRenderer` fallback): TSL compiles to
 * WGSL or GLSL depending on which is active, where a hand-written GLSL
 * `ShaderMaterial` would only ever run on the WebGL2 path.
 */
export function createMsdfTextMaterial(atlasTexture: THREE.Texture): MsdfTextMaterialHandle {
  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;

  const colorUniform = uniform(new THREE.Color(1, 1, 1));
  const opacityUniform = uniform(1);

  const median = Fn(([r, g, b]: [Node<"float">, Node<"float">, Node<"float">]) => {
    return max(min(r, g), min(max(r, g), b));
  });

  const sample = texture(atlasTexture, uv());
  const signedDistance = median(sample.r, sample.g, sample.b).sub(0.5);
  const edgeWidth = fwidth(signedDistance);
  const coverage = smoothstep(edgeWidth.negate(), edgeWidth, signedDistance);

  material.colorNode = colorUniform;
  material.opacityNode = coverage.mul(opacityUniform);

  return {
    material,
    setColor(r: number, g: number, b: number, a: number): void {
      colorUniform.value.setRGB(r, g, b);
      opacityUniform.value = a;
    },
    setOpacity(a: number): void {
      opacityUniform.value = a;
    },
  };
}
