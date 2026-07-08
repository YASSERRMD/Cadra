import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { DenoiseMaterial } from "three-gpu-pathtracer";

/**
 * Denoises an accumulated path-traced render target, injectable so unit
 * tests can substitute a fake and never touch a real GPU - mirroring
 * `WebGLPathTracerLike`'s own pattern in `path-tracer-like.ts`.
 */
export interface DenoiserLike {
  /**
   * Denoises `source`'s own accumulated pixels into a fresh, same-size
   * render target this instance owns and returns (reused across calls when
   * `source`'s size is unchanged). Deterministic: a fixed edge-aware
   * blur function of `source`'s own pixel data, no randomness - denoising
   * never affects `PathTracedFrameResult.samples`'s own reproducibility.
   */
  denoise(source: THREE.WebGLRenderTarget): THREE.WebGLRenderTarget;
  /** Frees the shader material, full-screen quad, and render target this instance owns. */
  dispose(): void;
}

/** Constructs the real `DenoiserLike` for a given `WebGLRenderer`. */
export type CreateDenoiser = (renderer: THREE.WebGLRenderer) => DenoiserLike;

/**
 * The dependency `denoisePathTracedResult` uses when no override is
 * supplied: `three-gpu-pathtracer`'s own `DenoiseMaterial` (a
 * `glslSmartDeNoise` edge-aware bilateral blur, verified deterministic and
 * randomness-free by reading its shader source), rendered via Three.js's
 * own `FullScreenQuad` helper.
 */
export const defaultCreateDenoiser: CreateDenoiser = (renderer) => {
  const material = new DenoiseMaterial();
  const quad = new FullScreenQuad(material);
  let target: THREE.WebGLRenderTarget | undefined;

  return {
    denoise(source) {
      if (target === undefined || target.width !== source.width || target.height !== source.height) {
        target?.dispose();
        target = new THREE.WebGLRenderTarget(source.width, source.height);
      }
      material.map = source.texture;

      const previousTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      quad.render(renderer);
      renderer.setRenderTarget(previousTarget);

      return target;
    },
    dispose() {
      material.dispose();
      quad.dispose();
      target?.dispose();
    },
  };
};
