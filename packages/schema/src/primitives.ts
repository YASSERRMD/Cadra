import type { AnimatableTransform, ColorRGBA, Transform, Vector2, Vector3 } from "@cadra/core";
import { z } from "zod";

import { propertySchema } from "./keyframes.js";

/**
 * Zod mirrors of the plain numeric-tuple primitives in
 * `@cadra/core`'s `scene-graph/primitives.ts`.
 *
 * Every schema here models a fixed-length tuple, not a variable-length
 * array, matching the core TypeScript tuple types exactly: `z.tuple(...)`
 * enforces both the element count and per-slot type, so a 2-element array
 * where 3 are required (or vice versa) is rejected rather than silently
 * accepted.
 */

/** A compile-time-only equality check between two types, with no runtime cost. */
type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Forces `T` to be exactly the literal type `true`, or the file fails to typecheck. */
type AssertTrue<T extends true> = T;

/** A 2-component numeric tuple, typically a screen-space or UV coordinate. */
export const vector2Schema = z
  .tuple([
    z.number().describe("The x component of the vector."),
    z.number().describe("The y component of the vector."),
  ])
  .describe("A 2-component numeric tuple, typically a screen-space or UV coordinate.");

type _CheckVector2 = AssertTrue<AssertEqual<z.infer<typeof vector2Schema>, Vector2>>;

/** A 3-component numeric tuple, typically a world-space position or axis. */
export const vector3Schema = z
  .tuple([
    z.number().describe("The x component of the vector."),
    z.number().describe("The y component of the vector."),
    z.number().describe("The z component of the vector."),
  ])
  .describe("A 3-component numeric tuple, typically a world-space position or axis.");

type _CheckVector3 = AssertTrue<AssertEqual<z.infer<typeof vector3Schema>, Vector3>>;

/**
 * A straight (non-premultiplied) RGBA color. Each channel is a number in the
 * inclusive range 0 to 1, not 0 to 255, matching the convention documented on
 * `ColorRGBA` in `@cadra/core`.
 */
export const colorRgbaSchema = z
  .tuple([
    z.number().min(0).max(1).describe("The red channel, in the inclusive range 0 to 1."),
    z.number().min(0).max(1).describe("The green channel, in the inclusive range 0 to 1."),
    z.number().min(0).max(1).describe("The blue channel, in the inclusive range 0 to 1."),
    z.number().min(0).max(1).describe("The alpha channel, in the inclusive range 0 to 1."),
  ])
  .describe(
    "A straight (non-premultiplied) RGBA color. Each channel is a number in the inclusive range 0 to 1, not 0 to 255.",
  );

type _CheckColorRGBA = AssertTrue<AssertEqual<z.infer<typeof colorRgbaSchema>, ColorRGBA>>;

/**
 * A rigid-ish transform for a scene node.
 *
 * `rotation` is Euler angles in radians, applied in XYZ order (rotate around
 * X, then the rotated Y, then the twice-rotated Z, i.e. intrinsic XYZ, the
 * same convention as Three.js's default `Euler` order). This convention is
 * fixed for the whole scene graph, matching `Transform` in `@cadra/core`.
 */
export const transformSchema = z
  .strictObject({
    position: vector3Schema.describe("World-space translation of the node."),
    rotation: vector3Schema.describe("Euler rotation in radians, applied in intrinsic XYZ order."),
    scale: vector3Schema.describe("Per-axis scale factor of the node."),
  })
  .describe("A rigid-ish transform for a scene node: position, rotation, and scale.");

type _CheckTransform = AssertTrue<AssertEqual<z.infer<typeof transformSchema>, Transform>>;

/**
 * The transform shape every scene node actually carries, mirroring
 * `AnimatableTransform` in `@cadra/core`: each of `position`, `rotation`, and
 * `scale` independently accepts either a plain `Vector3` or a keyframe track
 * (via `propertySchema`), exactly like `CameraNode`'s `fov`/`near`/`far`/
 * `target` fields. A plain `Transform`-shaped object (every field a bare
 * `Vector3`) still parses successfully, since `propertySchema` accepts a bare
 * value of the wrapped type as-is.
 */
export const animatableTransformSchema = z
  .strictObject({
    position: propertySchema(vector3Schema).describe(
      "World-space translation of the node. A plain Vector3 or a keyframe track.",
    ),
    rotation: propertySchema(vector3Schema).describe(
      "Euler rotation in radians, applied in intrinsic XYZ order. A plain Vector3 or a keyframe track.",
    ),
    scale: propertySchema(vector3Schema).describe(
      "Per-axis scale factor of the node. A plain Vector3 or a keyframe track.",
    ),
  })
  .describe(
    "The transform shape every scene node carries: position, rotation, and scale, each " +
      "independently a plain Vector3 or a keyframe track.",
  );

type _CheckAnimatableTransform = AssertTrue<
  AssertEqual<z.infer<typeof animatableTransformSchema>, AnimatableTransform>
>;
