import type { ColorRGBA, Vector2, Vector3 } from "../scene-graph/primitives.js";

/**
 * Per-component linear interpolation helpers shared by `interpolate` (which
 * operates on frame ranges, see `./interpolate.ts`) and the color/vector
 * helpers below (which take an already-normalized `t` in `[0, 1]`). Kept as
 * one small module so every interpolation path in this package uses the
 * exact same lerp arithmetic.
 */

/** Linear interpolation between two numbers at progress `t` (unclamped). */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * Per-channel linear interpolation between two colors at progress `t`.
 * Plain lerp in whatever color space `from`/`to` are already expressed in
 * (straight RGBA, 0 to 1 per channel): no perceptual color space conversion.
 */
export function interpolateColor(t: number, from: ColorRGBA, to: ColorRGBA): ColorRGBA {
  return [
    lerp(from[0], to[0], t),
    lerp(from[1], to[1], t),
    lerp(from[2], to[2], t),
    lerp(from[3], to[3], t),
  ];
}

/** Per-component linear interpolation between two `Vector2`s at progress `t`. */
export function interpolateVector2(t: number, from: Vector2, to: Vector2): Vector2 {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t)];
}

/** Per-component linear interpolation between two `Vector3`s at progress `t`. */
export function interpolateVector3(t: number, from: Vector3, to: Vector3): Vector3 {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}
