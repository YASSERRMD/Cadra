import { describe, expect, it } from "vitest";

import { createIdentityTransform } from "./primitives.js";

describe("createIdentityTransform", () => {
  it("returns zero position, zero rotation, and unit scale", () => {
    expect(createIdentityTransform()).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
  });

  it("returns a fresh object and arrays on each call", () => {
    const a = createIdentityTransform();
    const b = createIdentityTransform();

    expect(a).not.toBe(b);
    expect(a.position).not.toBe(b.position);
    expect(a.rotation).not.toBe(b.rotation);
    expect(a.scale).not.toBe(b.scale);
  });
});
