import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { computeSharpenKernelWeights, SharpenShader, updateSharpenUniforms } from "./sharpen.js";

describe("computeSharpenKernelWeights", () => {
  it("is an exact identity (center 1, neighbor 0) at amount 0", () => {
    expect(computeSharpenKernelWeights(0)).toEqual({ centerWeight: 1, neighborWeight: 0 });
  });

  it("scales center weight up and neighbor weight up together as amount increases", () => {
    expect(computeSharpenKernelWeights(0.5)).toEqual({ centerWeight: 3, neighborWeight: 0.5 });
    expect(computeSharpenKernelWeights(1)).toEqual({ centerWeight: 5, neighborWeight: 1 });
  });

  it("leaves a flat (uniform-color) region unchanged for any amount: centerWeight - 4 * neighborWeight === 1", () => {
    for (const amount of [0, 0.25, 0.5, 1, 2]) {
      const { centerWeight, neighborWeight } = computeSharpenKernelWeights(amount);
      expect(centerWeight - 4 * neighborWeight).toBeCloseTo(1, 10);
    }
  });

  it("is deterministic: repeated calls with the same amount produce the exact same weights", () => {
    expect(computeSharpenKernelWeights(0.7)).toEqual(computeSharpenKernelWeights(0.7));
  });
});

describe("updateSharpenUniforms", () => {
  function createMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SharpenShader.uniforms),
      vertexShader: SharpenShader.vertexShader,
      fragmentShader: SharpenShader.fragmentShader,
    });
  }

  it("sets texelSize to the reciprocal of the given width and height", () => {
    const material = createMaterial();
    updateSharpenUniforms(material, 0.5, 200, 100);

    const uniforms = material.uniforms as typeof SharpenShader.uniforms;
    expect(uniforms.texelSize.value.x).toBeCloseTo(1 / 200);
    expect(uniforms.texelSize.value.y).toBeCloseTo(1 / 100);
  });

  it("sets centerWeight and neighborWeight from computeSharpenKernelWeights(amount)", () => {
    const material = createMaterial();
    updateSharpenUniforms(material, 0.5, 200, 100);

    const uniforms = material.uniforms as typeof SharpenShader.uniforms;
    expect(uniforms.centerWeight.value).toBe(3);
    expect(uniforms.neighborWeight.value).toBe(0.5);
  });
});
