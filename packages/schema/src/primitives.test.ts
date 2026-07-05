import { createIdentityTransform } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { colorRgbaSchema, transformSchema, vector2Schema, vector3Schema } from "./primitives.js";

describe("vector2Schema", () => {
  it("accepts a 2-element numeric tuple", () => {
    const result = vector2Schema.safeParse([1, 2]);
    expect(result.success).toBe(true);
  });

  it("rejects a tuple with too few elements", () => {
    const result = vector2Schema.safeParse([1]);
    expect(result.success).toBe(false);
  });

  it("rejects a tuple with too many elements", () => {
    const result = vector2Schema.safeParse([1, 2, 3]);
    expect(result.success).toBe(false);
  });
});

describe("vector3Schema", () => {
  it("accepts a 3-element numeric tuple", () => {
    const result = vector3Schema.safeParse([1, 2, 3]);
    expect(result.success).toBe(true);
  });

  it("rejects a 2-element tuple", () => {
    const result = vector3Schema.safeParse([1, 2]);
    expect(result.success).toBe(false);
  });
});

describe("colorRgbaSchema", () => {
  it("accepts channel values at the inclusive boundaries 0 and 1", () => {
    expect(colorRgbaSchema.safeParse([0, 0, 0, 0]).success).toBe(true);
    expect(colorRgbaSchema.safeParse([1, 1, 1, 1]).success).toBe(true);
  });

  it("accepts a value strictly between 0 and 1", () => {
    expect(colorRgbaSchema.safeParse([0.5, 0.25, 0.75, 1]).success).toBe(true);
  });

  it("rejects a channel value above 1 (0-to-255 style input)", () => {
    const result = colorRgbaSchema.safeParse([255, 0, 0, 1]);
    expect(result.success).toBe(false);
  });

  it("rejects a negative channel value", () => {
    const result = colorRgbaSchema.safeParse([-0.1, 0, 0, 1]);
    expect(result.success).toBe(false);
  });

  it("rejects a 3-element array (missing alpha)", () => {
    const result = colorRgbaSchema.safeParse([1, 1, 1]);
    expect(result.success).toBe(false);
  });
});

describe("transformSchema", () => {
  it("accepts the identity transform produced by @cadra/core", () => {
    const result = transformSchema.safeParse(createIdentityTransform());
    expect(result.success).toBe(true);
  });

  it("rejects a transform missing the scale field", () => {
    const result = transformSchema.safeParse({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    });
    expect(result.success).toBe(false);
  });
});
