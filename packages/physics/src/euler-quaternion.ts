import type { Vector3 } from "@cadra/core";

/** A quaternion, in `@dimforge/rapier3d-compat`'s own plain `{x, y, z, w}` shape (an interface, not a class - any object with these four fields is a valid `Rotation`). */
export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Converts Euler angles (radians, `"XYZ"` order - this engine's one fixed
 * rotation convention, see `AnimatableTransform`'s own doc in
 * `@cadra/core`) to the quaternion `@dimforge/rapier3d-compat` needs for a
 * rigid body's initial/kinematic rotation. Verified directly against this
 * project's installed `three@0.185.1` source (`Quaternion.js`'s own
 * `setFromEuler`, `'XYZ'` case) rather than a hand-recalled formula.
 */
export function eulerXyzToQuaternion([x, y, z]: Vector3): Quaternion {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);

  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

/**
 * Converts a quaternion (`@dimforge/rapier3d-compat`'s own rigid-body
 * rotation readback) to Euler angles (radians, `"XYZ"` order), the
 * representation `AnimatableTransform.rotation` (`@cadra/core`) and
 * `object3D.rotation.set(...)` (`node-factory.ts`'s own `applyTransform`)
 * both use.
 *
 * Verified directly against this project's installed `three@0.185.1`
 * source: `Matrix4.js`'s own `compose()` (quaternion to rotation matrix,
 * unit scale) combined with `Euler.js`'s own `setFromRotationMatrix`,
 * `'XYZ'` case (matrix to Euler angles, including its gimbal-lock branch
 * at `|m13| >= 0.9999999`) - not a hand-derived formula.
 */
export function quaternionToEulerXyz({ x, y, z, w }: Quaternion): Vector3 {
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  const m11 = 1 - (yy + zz);
  const m12 = xy - wz;
  const m13 = xz + wy;
  const m22 = 1 - (xx + zz);
  const m23 = yz - wx;
  const m32 = yz + wx;
  const m33 = 1 - (xx + yy);

  const clampedM13 = Math.min(1, Math.max(-1, m13));
  const ey = Math.asin(clampedM13);

  if (Math.abs(m13) < 0.9999999) {
    return [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)];
  }
  return [Math.atan2(m32, m22), ey, 0];
}
