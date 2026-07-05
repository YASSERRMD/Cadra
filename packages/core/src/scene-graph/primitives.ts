/**
 * Plain numeric-tuple primitives shared across the scene graph.
 *
 * Every type in this module is plain serializable data: arrays and numbers
 * only. Nothing here is a class instance, so values survive `structuredClone`
 * and JSON round trips with full equality, and can be diffed, persisted, and
 * sent to or from an agent without any custom (de)serialization logic.
 */

/** A 2-component numeric tuple, typically a screen-space or UV coordinate. */
export type Vector2 = [x: number, y: number];

/** A 3-component numeric tuple, typically a world-space position or axis. */
export type Vector3 = [x: number, y: number, z: number];

/**
 * A straight (non-premultiplied) RGBA color. Each channel is a number in the
 * inclusive range 0 to 1, not 0 to 255.
 */
export type ColorRGBA = [red: number, green: number, blue: number, alpha: number];

/**
 * A rigid-ish transform for a scene node.
 *
 * `rotation` is Euler angles in radians, applied in XYZ order (rotate around
 * X, then the rotated Y, then the twice-rotated Z, i.e. intrinsic XYZ, the
 * same convention as Three.js's default `Euler` order). This convention is
 * fixed for the whole scene graph so every consumer (renderer, timeline
 * resolver, agent SDK) can apply rotations without needing an order field on
 * every node.
 */
export interface Transform {
  position: Vector3;
  rotation: Vector3;
  scale: Vector3;
}

/** A `Transform` at the identity: no translation, no rotation, unit scale. */
export function createIdentityTransform(): Transform {
  return {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}
