import * as THREE from "three";

/**
 * The two weights a 5-tap (center plus four neighbors) unsharp-mask kernel
 * needs, derived once from `amount` and shared verbatim by both backends'
 * own shader/node implementations below: `centerWeight` scales the pixel
 * itself, `neighborWeight` scales the sum of its four immediate neighbors.
 * At `amount === 0`, `centerWeight === 1` and `neighborWeight === 0`, so the
 * kernel reduces to `center * 1 - 0`, an exact identity - the no-op every
 * `PostEffectConfig` at zero strength is expected to be. A flat region (every
 * tap equal to some color `c`) always resolves to `c` regardless of
 * `amount`, since `centerWeight - 4 * neighborWeight === 1` for every
 * `amount`: only regions where neighbors differ from center (edges/detail)
 * are actually affected, which is what makes this a sharpen rather than a
 * brightness shift.
 */
export interface SharpenKernelWeights {
  centerWeight: number;
  neighborWeight: number;
}

/** Pure, deterministic, and the single source of truth both the WebGL2 shader and the WebGPU TSL node read their actual numeric weights from. */
export function computeSharpenKernelWeights(amount: number): SharpenKernelWeights {
  return {
    centerWeight: 1 + 4 * amount,
    neighborWeight: amount,
  };
}

/**
 * A `THREE.ShaderPass`-compatible shader definition (see that class's own
 * constructor doc: an object with `uniforms`/`vertexShader`/`fragmentShader`
 * is accepted directly, cloning `uniforms` per instance). `tDiffuse` is the
 * pass's own default `textureID`, populated with the read buffer's texture
 * every render call; `texelSize`/`centerWeight`/`neighborWeight` are set by
 * `updateSharpenUniforms` below, once per `ThreeRenderer.renderFrame` call.
 */
export const SharpenShader = {
  name: "SharpenShader",
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    texelSize: { value: new THREE.Vector2(1, 1) },
    centerWeight: { value: 1 },
    neighborWeight: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 texelSize;
    uniform float centerWeight;
    uniform float neighborWeight;
    varying vec2 vUv;

    void main() {
      vec4 center = texture2D(tDiffuse, vUv);
      vec4 top = texture2D(tDiffuse, vUv + vec2(0.0, texelSize.y));
      vec4 bottom = texture2D(tDiffuse, vUv - vec2(0.0, texelSize.y));
      vec4 left = texture2D(tDiffuse, vUv - vec2(texelSize.x, 0.0));
      vec4 right = texture2D(tDiffuse, vUv + vec2(texelSize.x, 0.0));
      vec4 neighborSum = top + bottom + left + right;
      gl_FragColor = center * centerWeight - neighborSum * neighborWeight;
    }
  `,
};

/**
 * Sets `sharpenMaterial`'s own `texelSize`/`centerWeight`/`neighborWeight`
 * uniforms from `amount` and the composer's current pixel size, called fresh
 * every `render()` (mirroring `GTAOPass`'s own `updateGtaoMaterial` call
 * site in `withAmbientOcclusionSupport`): `texelSize` depends on `width`/
 * `height`, which can change across a `resize()` call between frames, so it
 * is never safe to compute once at construction time.
 */
export function updateSharpenUniforms(
  material: THREE.ShaderMaterial,
  amount: number,
  width: number,
  height: number,
): void {
  const { centerWeight, neighborWeight } = computeSharpenKernelWeights(amount);
  const uniforms = material.uniforms as typeof SharpenShader.uniforms;
  uniforms.texelSize.value.set(1 / width, 1 / height);
  uniforms.centerWeight.value = centerWeight;
  uniforms.neighborWeight.value = neighborWeight;
}

