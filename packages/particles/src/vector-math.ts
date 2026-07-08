import type { Vector3 } from "@cadra/core";

/** Small plain-`Vector3` math helpers shared across this package's forces, colliders, and direction jitter. */

export function dot(a: Vector3, b: Vector3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vector3, b: Vector3): Vector3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function subtract(a: Vector3, b: Vector3): Vector3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function length(a: Vector3): number {
  return Math.sqrt(dot(a, a));
}

/** Normalizes `a` to unit length, or returns the zero vector unchanged rather than dividing by zero. */
export function normalizeOrZero(a: Vector3): Vector3 {
  const len = length(a);
  return len === 0 ? [0, 0, 0] : [a[0] / len, a[1] / len, a[2] / len];
}
