import * as THREE from "three";

/** One RGB color, each channel typically `0` to `1` in this module's own post-tonemap, display-referred usage. */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Applies a three-way lift/gamma/gain color grade plus saturation and
 * contrast to one color, in that fixed order (lift, then gain, then gamma,
 * then saturation, then contrast) - the same order real grading tools apply
 * their own primaries in. Pure and deterministic: the same inputs always
 * produce the same output, and at every default (`lift: [0,0,0]`, `gamma:
 * [1,1,1]`, `gain: [1,1,1]`, `saturation: 1`, `contrast: 1`) this is an
 * exact identity for any already-valid `0` to `1` display-referred color
 * (the one `Math.max(_, 0)` clamp before each channel's own gamma power
 * only ever changes a negative, out-of-gamut input, never a well-formed
 * one). Shared verbatim by both backends' own implementations (see
 * `buildWebGl2EffectPass`/`applyWebGpuEffect` in
 * `./post-processing-pipeline.ts`), each of which reproduces this exact
 * formula in its own shading language.
 */
export function applyColorGrade(
  color: RgbColor,
  lift: readonly [number, number, number],
  gamma: readonly [number, number, number],
  gain: readonly [number, number, number],
  saturation: number,
  contrast: number,
): RgbColor {
  const gradedR = gradeChannel(color.r, lift[0], gamma[0], gain[0]);
  const gradedG = gradeChannel(color.g, lift[1], gamma[1], gain[1]);
  const gradedB = gradeChannel(color.b, lift[2], gamma[2], gain[2]);

  const luma = 0.2126 * gradedR + 0.7152 * gradedG + 0.0722 * gradedB;
  const saturatedR = luma + (gradedR - luma) * saturation;
  const saturatedG = luma + (gradedG - luma) * saturation;
  const saturatedB = luma + (gradedB - luma) * saturation;

  return {
    r: (saturatedR - 0.5) * contrast + 0.5,
    g: (saturatedG - 0.5) * contrast + 0.5,
    b: (saturatedB - 0.5) * contrast + 0.5,
  };
}

/** One channel's own lift (shadow offset) -> gain (highlight multiplier) -> gamma (midtone power) chain. */
function gradeChannel(value: number, lift: number, gamma: number, gain: number): number {
  const lifted = value * (1 - lift) + lift;
  const gained = lifted * gain;
  return Math.max(gained, 0) ** (1 / gamma);
}

/**
 * A `THREE.ShaderPass`-compatible shader definition reproducing
 * `applyColorGrade`'s exact formula in GLSL (see that function's own doc for
 * why both backends share one source of truth for the actual math, even
 * though each expresses it in its own shading language). `lift`/`gamma`/
 * `gain`/`saturation`/`contrast` uniforms are set by `updateColorGradeUniforms`
 * below, once per `ThreeRenderer.renderFrame` call.
 */
export const ColorGradeShader = {
  name: "ColorGradeShader",
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    lift: { value: new THREE.Vector3(0, 0, 0) },
    gamma: { value: new THREE.Vector3(1, 1, 1) },
    gain: { value: new THREE.Vector3(1, 1, 1) },
    saturation: { value: 1 },
    contrast: { value: 1 },
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
    uniform vec3 lift;
    uniform vec3 gamma;
    uniform vec3 gain;
    uniform float saturation;
    uniform float contrast;
    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 lifted = texel.rgb * (1.0 - lift) + lift;
      vec3 gained = lifted * gain;
      vec3 graded = pow(max(gained, vec3(0.0)), 1.0 / gamma);
      float luma = dot(graded, vec3(0.2126, 0.7152, 0.0722));
      vec3 saturated = luma + (graded - luma) * saturation;
      vec3 finalColor = (saturated - 0.5) * contrast + 0.5;
      gl_FragColor = vec4(finalColor, texel.a);
    }
  `,
};

/** Sets `material`'s own `lift`/`gamma`/`gain`/`saturation`/`contrast` uniforms from a `ColorGradeEffectConfig`'s resolved fields. */
export function updateColorGradeUniforms(
  material: THREE.ShaderMaterial,
  lift: readonly [number, number, number],
  gamma: readonly [number, number, number],
  gain: readonly [number, number, number],
  saturation: number,
  contrast: number,
): void {
  const uniforms = material.uniforms as typeof ColorGradeShader.uniforms;
  uniforms.lift.value.set(lift[0], lift[1], lift[2]);
  uniforms.gamma.value.set(gamma[0], gamma[1], gamma[2]);
  uniforms.gain.value.set(gain[0], gain[1], gain[2]);
  uniforms.saturation.value = saturation;
  uniforms.contrast.value = contrast;
}
