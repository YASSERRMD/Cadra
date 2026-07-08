import { describe, expect, it } from "vitest";

import { computeAcceleration } from "./forces.js";

describe("computeAcceleration", () => {
  it("returns zero acceleration when forces is undefined or empty", () => {
    expect(computeAcceleration(undefined, [0, 0, 0], [0, 0, 0], 1, 0, 0)).toEqual([0, 0, 0]);
    expect(computeAcceleration([], [0, 0, 0], [0, 0, 0], 1, 0, 0)).toEqual([0, 0, 0]);
  });

  it("gravity contributes its own acceleration directly, regardless of position or velocity", () => {
    const acceleration = computeAcceleration(
      [{ type: "gravity", acceleration: [0, -9.81, 0] }],
      [5, 5, 5],
      [1, 2, 3],
      1,
      0,
      0,
    );
    expect(acceleration).toEqual([0, -9.81, 0]);
  });

  it("drag opposes velocity, proportional to its coefficient", () => {
    const acceleration = computeAcceleration(
      [{ type: "drag", coefficient: 0.5 }],
      [0, 0, 0],
      [2, -4, 6],
      1,
      0,
      0,
    );
    expect(acceleration).toEqual([-1, 2, -3]);
  });

  it("drag against a stationary particle contributes nothing", () => {
    const acceleration = computeAcceleration([{ type: "drag", coefficient: 0.5 }], [0, 0, 0], [0, 0, 0], 1, 0, 0);
    expect(acceleration).toEqual([0, 0, 0]);
  });

  it("vortex is zero exactly on its own axis", () => {
    const acceleration = computeAcceleration(
      [{ type: "vortex", origin: [0, 0, 0], axis: [0, 1, 0], strength: 5 }],
      [0, 3, 0],
      [0, 0, 0],
      1,
      0,
      0,
    );
    expect(acceleration).toEqual([0, 0, 0]);
  });

  it("vortex pushes tangentially, perpendicular to the radial offset from its axis", () => {
    const acceleration = computeAcceleration(
      [{ type: "vortex", origin: [0, 0, 0], axis: [0, 1, 0], strength: 5 }],
      [2, 0, 0],
      [0, 0, 0],
      1,
      0,
      0,
    );
    // Radially offset along +x from a y-axis vortex: tangential force lies in the xz-plane, not along x.
    expect(acceleration[0]).toBeCloseTo(0, 10);
    expect(Math.hypot(acceleration[0], acceleration[2])).toBeCloseTo(5, 10);
  });

  it("curlNoise is deterministic and finite", () => {
    const forces = [{ type: "curlNoise" as const, strength: 2, frequency: 0.5 }];
    const a = computeAcceleration(forces, [1, 2, 3], [0, 0, 0], 7, 3, 0);
    const b = computeAcceleration(forces, [1, 2, 3], [0, 0, 0], 7, 3, 0);
    expect(a).toEqual(b);
    for (const component of a) {
      expect(Number.isFinite(component)).toBe(true);
    }
  });

  it("curlNoise with a speed evolves over elapsed time", () => {
    const forces = [{ type: "curlNoise" as const, strength: 2, frequency: 0.5, speed: 1 }];
    const atZero = computeAcceleration(forces, [1, 2, 3], [0, 0, 0], 7, 3, 0);
    const atLater = computeAcceleration(forces, [1, 2, 3], [0, 0, 0], 7, 3, 10);
    expect(atZero).not.toEqual(atLater);
  });

  it("sums multiple forces together", () => {
    const acceleration = computeAcceleration(
      [
        { type: "gravity", acceleration: [0, -9.81, 0] },
        { type: "drag", coefficient: 1 },
      ],
      [0, 0, 0],
      [1, 0, 0],
      1,
      0,
      0,
    );
    expect(acceleration).toEqual([-1, -9.81, 0]);
  });
});
