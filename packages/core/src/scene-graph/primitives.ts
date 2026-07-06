import type { Property } from "../keyframes/keyframe-track.js";

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
 * A rigid-ish transform for a scene node, with every field a plain constant.
 *
 * `rotation` is Euler angles in radians, applied in XYZ order (rotate around
 * X, then the rotated Y, then the twice-rotated Z, i.e. intrinsic XYZ, the
 * same convention as Three.js's default `Euler` order). This convention is
 * fixed for the whole scene graph so every consumer (renderer, timeline
 * resolver, agent SDK) can apply rotations without needing an order field on
 * every node.
 *
 * Kept alongside `AnimatableTransform` (the shape every `SceneNode` actually
 * carries) as a convenience for callers that only ever deal in constant
 * transforms, e.g. `createIdentityTransform`'s return type below.
 */
export interface Transform {
  position: Vector3;
  rotation: Vector3;
  scale: Vector3;
}

/**
 * The transform shape every `SceneNode` carries: each of `position`,
 * `rotation`, and `scale` is independently a `Property<Vector3>` (Phase 10's
 * generic keyframe/property model), so any of the three may be a plain
 * constant or a `KeyframeTrack` animating it over time, for every node kind
 * alike. Mirrors the same "field independently animatable via `Property<T>`"
 * pattern `CameraNode`'s `fov`/`near`/`far`/`target` established.
 *
 * A plain `Transform` (all three fields as bare `Vector3`s) is always a valid
 * `AnimatableTransform`, since a bare `T` is always a valid `Property<T>`.
 */
export interface AnimatableTransform {
  position: Property<Vector3>;
  rotation: Property<Vector3>;
  scale: Property<Vector3>;
}

/** A `Transform` at the identity: no translation, no rotation, unit scale. */
export function createIdentityTransform(): Transform {
  return {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}
