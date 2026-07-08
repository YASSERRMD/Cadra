import { describe, expect, it } from "vitest";

import { applyColliders } from "./colliders.js";

describe("applyColliders", () => {
  it("returns position and velocity unchanged when colliders is undefined or empty", () => {
    expect(applyColliders(undefined, [1, 2, 3], [4, 5, 6])).toEqual({
      position: [1, 2, 3],
      velocity: [4, 5, 6],
    });
    expect(applyColliders([], [1, 2, 3], [4, 5, 6])).toEqual({ position: [1, 2, 3], velocity: [4, 5, 6] });
  });

  it("groundPlane leaves a particle above it untouched", () => {
    const result = applyColliders([{ type: "groundPlane", y: 0 }], [0, 5, 0], [0, -1, 0]);
    expect(result).toEqual({ position: [0, 5, 0], velocity: [0, -1, 0] });
  });

  it("groundPlane clamps a particle below it to the plane's own height", () => {
    const result = applyColliders([{ type: "groundPlane", y: 0 }], [0, -2, 0], [0, -3, 0]);
    expect(result.position[1]).toBe(0);
  });

  it("groundPlane with no bounce fully absorbs downward velocity", () => {
    const result = applyColliders([{ type: "groundPlane", y: 0 }], [0, -1, 0], [0, -5, 0]);
    expect(result.velocity[1]).toBe(0);
  });

  it("groundPlane with bounce reflects downward velocity, scaled by the bounce coefficient", () => {
    const result = applyColliders([{ type: "groundPlane", y: 0, bounce: 0.5 }], [0, -1, 0], [0, -4, 0]);
    expect(result.velocity[1]).toBe(2);
  });

  it("groundPlane clamps position but does not reflect velocity already moving away", () => {
    const result = applyColliders([{ type: "groundPlane", y: 0, bounce: 0.5 }], [0, -1, 0], [0, 3, 0]);
    expect(result.position[1]).toBe(0);
    expect(result.velocity[1]).toBe(3);
  });

  it("sphere collider leaves a particle outside it untouched", () => {
    const result = applyColliders(
      [{ type: "sphere", center: [0, 0, 0], radius: 1 }],
      [5, 0, 0],
      [-1, 0, 0],
    );
    expect(result).toEqual({ position: [5, 0, 0], velocity: [-1, 0, 0] });
  });

  it("sphere collider pushes a particle inside it back out to the surface", () => {
    const result = applyColliders(
      [{ type: "sphere", center: [0, 0, 0], radius: 2 }],
      [1, 0, 0],
      [0, 0, 0],
    );
    expect(result.position).toEqual([2, 0, 0]);
  });

  it("sphere collider reflects inward velocity along the surface normal, with no bounce fully absorbing it", () => {
    const result = applyColliders(
      [{ type: "sphere", center: [0, 0, 0], radius: 2 }],
      [1, 0, 0],
      [-3, 0, 0],
    );
    expect(result.velocity[0]).toBeCloseTo(0, 10);
  });

  it("sphere collider with bounce reflects inward velocity outward, scaled", () => {
    const result = applyColliders(
      [{ type: "sphere", center: [0, 0, 0], radius: 2 }, ],
      [1, 0, 0],
      [-3, 0, 0],
    );
    const withBounce = applyColliders(
      [{ type: "sphere", center: [0, 0, 0], radius: 2, bounce: 1 }],
      [1, 0, 0],
      [-3, 0, 0],
    );
    expect(withBounce.velocity[0]).toBeCloseTo(3, 10);
    expect(result.velocity[0]).toBeCloseTo(0, 10);
  });

  it("applies multiple colliders in sequence", () => {
    const result = applyColliders(
      [
        { type: "groundPlane", y: 0 },
        { type: "sphere", center: [0, 5, 0], radius: 1 },
      ],
      [0, -1, 0],
      [0, -2, 0],
    );
    expect(result.position[1]).toBe(0);
  });
});
