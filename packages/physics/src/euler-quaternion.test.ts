import type { Vector3 } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { eulerXyzToQuaternion, quaternionToEulerXyz } from "./euler-quaternion.js";

/** Asserts every component of `actual` is close to `expected`. */
function expectQuaternionClose(
  actual: { x: number; y: number; z: number; w: number },
  expected: { x: number; y: number; z: number; w: number },
): void {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
  expect(actual.z).toBeCloseTo(expected.z, 9);
  expect(actual.w).toBeCloseTo(expected.w, 9);
}

describe("eulerXyzToQuaternion", () => {
  it("maps the identity rotation to the identity quaternion", () => {
    expectQuaternionClose(eulerXyzToQuaternion([0, 0, 0]), { x: 0, y: 0, z: 0, w: 1 });
  });

  it("maps a pure X rotation to a quaternion about the X axis alone (order-independent for a single axis)", () => {
    const angle = Math.PI / 3;
    expectQuaternionClose(eulerXyzToQuaternion([angle, 0, 0]), {
      x: Math.sin(angle / 2),
      y: 0,
      z: 0,
      w: Math.cos(angle / 2),
    });
  });

  it("maps a pure Y rotation to a quaternion about the Y axis alone", () => {
    const angle = Math.PI / 4;
    expectQuaternionClose(eulerXyzToQuaternion([0, angle, 0]), {
      x: 0,
      y: Math.sin(angle / 2),
      z: 0,
      w: Math.cos(angle / 2),
    });
  });

  it("maps a pure Z rotation to a quaternion about the Z axis alone", () => {
    const angle = Math.PI / 6;
    expectQuaternionClose(eulerXyzToQuaternion([0, 0, angle]), {
      x: 0,
      y: 0,
      z: Math.sin(angle / 2),
      w: Math.cos(angle / 2),
    });
  });

  it("is deterministic: repeated calls with the same input produce the same output", () => {
    const euler: Vector3 = [0.3, -0.7, 1.1];
    expect(eulerXyzToQuaternion(euler)).toEqual(eulerXyzToQuaternion(euler));
  });
});

describe("quaternionToEulerXyz", () => {
  it("maps the identity quaternion back to the identity rotation", () => {
    // atan2's own sign-of-zero handling can produce -0 for an exactly-zero
    // angle here (mathematically identical to 0, but toEqual's Object.is
    // semantics distinguish them); toBeCloseTo does not.
    const [x, y, z] = quaternionToEulerXyz({ x: 0, y: 0, z: 0, w: 1 });
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(0, 9);
  });

  it("round-trips arbitrary, gimbal-lock-free Euler angles through eulerXyzToQuaternion", () => {
    const original: Vector3 = [0.4, 0.5, -0.6];
    const roundTripped = quaternionToEulerXyz(eulerXyzToQuaternion(original));
    expect(roundTripped[0]).toBeCloseTo(original[0], 9);
    expect(roundTripped[1]).toBeCloseTo(original[1], 9);
    expect(roundTripped[2]).toBeCloseTo(original[2], 9);
  });

  it("round-trips a single-axis rotation for each axis independently", () => {
    const angle = 0.9;
    for (const original of [
      [angle, 0, 0],
      [0, angle, 0],
      [0, 0, angle],
    ] satisfies Vector3[]) {
      const roundTripped = quaternionToEulerXyz(eulerXyzToQuaternion(original));
      expect(roundTripped[0]).toBeCloseTo(original[0], 9);
      expect(roundTripped[1]).toBeCloseTo(original[1], 9);
      expect(roundTripped[2]).toBeCloseTo(original[2], 9);
    }
  });

  it("is deterministic: repeated calls with the same input produce the same output", () => {
    const quaternion = eulerXyzToQuaternion([0.2, 0.3, 0.4]);
    expect(quaternionToEulerXyz(quaternion)).toEqual(quaternionToEulerXyz(quaternion));
  });
});
