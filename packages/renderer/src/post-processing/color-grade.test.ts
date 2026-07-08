import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { applyColorGrade, ColorGradeShader, updateColorGradeUniforms } from "./color-grade.js";

const IDENTITY = {
  lift: [0, 0, 0] as [number, number, number],
  gamma: [1, 1, 1] as [number, number, number],
  gain: [1, 1, 1] as [number, number, number],
  saturation: 1,
  contrast: 1,
};

describe("applyColorGrade", () => {
  it("is an exact identity at every default for a well-formed 0-1 color", () => {
    const color = { r: 0.3, g: 0.6, b: 0.9 };
    const result = applyColorGrade(color, IDENTITY.lift, IDENTITY.gamma, IDENTITY.gain, IDENTITY.saturation, IDENTITY.contrast);
    expect(result.r).toBeCloseTo(0.3, 10);
    expect(result.g).toBeCloseTo(0.6, 10);
    expect(result.b).toBeCloseTo(0.9, 10);
  });

  it("lift raises black level: a pure black pixel takes on the lift color", () => {
    const result = applyColorGrade(
      { r: 0, g: 0, b: 0 },
      [0.1, 0.2, 0.3],
      IDENTITY.gamma,
      IDENTITY.gain,
      IDENTITY.saturation,
      IDENTITY.contrast,
    );
    expect(result.r).toBeCloseTo(0.1, 10);
    expect(result.g).toBeCloseTo(0.2, 10);
    expect(result.b).toBeCloseTo(0.3, 10);
  });

  it("gain scales a pure white pixel's own highlights", () => {
    const result = applyColorGrade(
      { r: 1, g: 1, b: 1 },
      IDENTITY.lift,
      IDENTITY.gamma,
      [1.5, 1, 0.5],
      IDENTITY.saturation,
      IDENTITY.contrast,
    );
    expect(result.r).toBeCloseTo(1.5, 10);
    expect(result.g).toBeCloseTo(1, 10);
    expect(result.b).toBeCloseTo(0.5, 10);
  });

  it("saturation 0 collapses a color to its own luma (grayscale)", () => {
    const result = applyColorGrade(
      { r: 1, g: 0, b: 0 },
      IDENTITY.lift,
      IDENTITY.gamma,
      IDENTITY.gain,
      0,
      IDENTITY.contrast,
    );
    expect(result.r).toBeCloseTo(result.g, 10);
    expect(result.g).toBeCloseTo(result.b, 10);
  });

  it("contrast pivots around mid-gray: 0.5 is a fixed point for any contrast value", () => {
    const result = applyColorGrade(
      { r: 0.5, g: 0.5, b: 0.5 },
      IDENTITY.lift,
      IDENTITY.gamma,
      IDENTITY.gain,
      IDENTITY.saturation,
      2,
    );
    expect(result.r).toBeCloseTo(0.5, 10);
  });

  it("is deterministic: repeated calls with the same input produce the same output", () => {
    const color = { r: 0.4, g: 0.5, b: 0.6 };
    const a = applyColorGrade(color, [0.02, 0, -0.01], [1, 1.1, 0.95], [1.05, 1, 0.98], 1.1, 1.05);
    const b = applyColorGrade(color, [0.02, 0, -0.01], [1, 1.1, 0.95], [1.05, 1, 0.98], 1.1, 1.05);
    expect(a).toEqual(b);
  });
});

describe("updateColorGradeUniforms", () => {
  it("sets every uniform from the given fields", () => {
    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(ColorGradeShader.uniforms),
      vertexShader: ColorGradeShader.vertexShader,
      fragmentShader: ColorGradeShader.fragmentShader,
    });

    updateColorGradeUniforms(material, [0.02, 0, -0.01], [1, 1.1, 0.95], [1.05, 1, 0.98], 1.1, 1.05);

    const uniforms = material.uniforms as typeof ColorGradeShader.uniforms;
    expect(uniforms.lift.value.toArray()).toEqual([0.02, 0, -0.01]);
    expect(uniforms.gamma.value.toArray()).toEqual([1, 1.1, 0.95]);
    expect(uniforms.gain.value.toArray()).toEqual([1.05, 1, 0.98]);
    expect(uniforms.saturation.value).toBe(1.1);
    expect(uniforms.contrast.value).toBe(1.05);
  });
});
