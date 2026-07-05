import type { Easing, Keyframe, KeyframeTrack, Property } from "@cadra/core";
import { z } from "zod";

/**
 * Zod mirror of the generic keyframe/property model in
 * `@cadra/core`'s `keyframes/` module.
 *
 * Unlike `./scene-node.ts` and `./timeline.ts`, these schemas are generic
 * over the value type, exactly like their core counterparts: `keyframeSchema`,
 * `keyframeTrackSchema`, and `propertySchema` are all functions taking a
 * `valueSchema` for `T` and returning the schema for `Keyframe<T>`,
 * `KeyframeTrack<T>`, and `Property<T>` respectively, rather than being
 * pre-built for one concrete `T`. A concrete instantiation (e.g.
 * `keyframeTrackSchema(z.number())`) is drift-checked against
 * `KeyframeTrack<number>` below, the same `AssertEqual`/`AssertTrue` pattern
 * used in `./scene-node.ts`, just applied to one instantiation of the
 * generic rather than the schema itself (a generic function has no single
 * inferred type to compare against a generic core type).
 */

/** A compile-time-only equality check between two types, with no runtime cost. */
type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Forces `T` to be exactly the literal type `true`, or the file fails to typecheck. */
type AssertTrue<T extends true> = T;

/** Every `Easing` name `@cadra/core`'s `EASING_FUNCTIONS` lookup and `'hold'` cover. */
export const easingSchema = z
  .enum([
    "linear",
    "easeInCubic",
    "easeOutCubic",
    "easeInOutCubic",
    "easeInExpo",
    "easeOutExpo",
    "easeInOutExpo",
    "easeInBack",
    "easeOutBack",
    "easeInOutBack",
    "easeInElastic",
    "easeOutElastic",
    "easeInOutElastic",
    "hold",
  ])
  .describe(
    "How a keyframe blends into the next one: a named easing curve, or 'hold' " +
      "to step instantly at the next keyframe's frame instead of blending.",
  );

type _CheckEasing = AssertTrue<AssertEqual<z.infer<typeof easingSchema>, Easing>>;

/**
 * A single authored point on a keyframe track: a value pinned at a specific
 * frame, plus how it blends into the next keyframe (`easing`, defaulting to
 * `'linear'` when omitted, matching `Keyframe<T>` in `@cadra/core`).
 *
 * `frame`'s non-negative-integer and strictly-increasing-across-the-track
 * constraints are not encoded here (a single keyframe cannot know about its
 * neighbors): they are enforced track-wide by `keyframeTrackSchema`'s
 * `.superRefine`, below.
 */
export function keyframeSchema<ValueSchema extends z.ZodType>(
  valueSchema: ValueSchema,
): z.ZodObject<{
  frame: z.ZodNumber;
  value: ValueSchema;
  easing: z.ZodOptional<typeof easingSchema>;
}> {
  return z.strictObject({
    frame: z.number().describe("The integer frame this keyframe's value applies at."),
    value: valueSchema.describe("The value at `frame`."),
    easing: easingSchema
      .optional()
      .describe("How this keyframe blends into the next one. Defaults to 'linear'."),
  });
}

type _CheckKeyframe = AssertTrue<
  AssertEqual<z.infer<ReturnType<typeof keyframeSchema<z.ZodNumber>>>, Keyframe<number>>
>;

/**
 * An ordered list of keyframes describing how a property varies over time,
 * mirroring `KeyframeTrack<T>` in `@cadra/core`.
 *
 * Carries the same `type: "keyframeTrack"` literal discriminant as the core
 * type (not identified by shape), and enforces the strictly-increasing,
 * non-negative-integer-frame rule across the whole `keyframes` array via
 * `.superRefine`: every keyframe whose `frame` is not a non-negative integer,
 * and every keyframe whose `frame` does not come strictly after the previous
 * keyframe's `frame` (a duplicate or out-of-order frame), gets its own
 * `ctx.addIssue` with `path: ["keyframes", index, "frame"]`, naming the exact
 * offending keyframe's `frame` field.
 *
 * This is the schema-level twin of `validateKeyframeTrack` in
 * `@cadra/core`'s `keyframes/validate.ts`: same rule, same "no two keyframes
 * may share or invert frame order" definition of overlapping, but reported
 * as Zod issues (consumed via `safeParse`, and by `parseScene`'s diagnostic
 * formatting) rather than as a standalone diagnostic array.
 */
export function keyframeTrackSchema<ValueSchema extends z.ZodType>(valueSchema: ValueSchema) {
  return z
    .strictObject({
      type: z.literal("keyframeTrack").describe("Discriminant identifying this value as a keyframe track."),
      keyframes: z
        .array(keyframeSchema(valueSchema))
        .describe("The ordered keyframes describing how this property varies over time."),
    })
    .superRefine((track, ctx) => {
      let previousFrame: number | undefined;

      track.keyframes.forEach((keyframe, index) => {
        const { frame } = keyframe;

        if (!Number.isInteger(frame)) {
          ctx.addIssue({
            code: "custom",
            message: `Keyframe at index ${index} has a non-integer frame (${frame}). Frames must be whole numbers.`,
            path: ["keyframes", index, "frame"],
          });
        } else if (frame < 0) {
          ctx.addIssue({
            code: "custom",
            message: `Keyframe at index ${index} has a negative frame (${frame}). Frames must be non-negative.`,
            path: ["keyframes", index, "frame"],
          });
        }

        if (previousFrame !== undefined && frame <= previousFrame) {
          ctx.addIssue({
            code: "custom",
            message:
              `Keyframe at index ${index} has frame ${frame}, which does not come strictly after ` +
              `the previous keyframe's frame ${previousFrame}. Keyframes must be in strictly ` +
              "increasing frame order with no duplicates.",
            path: ["keyframes", index, "frame"],
          });
        }

        previousFrame = frame;
      });
    });
}

type _CheckKeyframeTrack = AssertTrue<
  AssertEqual<z.infer<ReturnType<typeof keyframeTrackSchema<z.ZodNumber>>>, KeyframeTrack<number>>
>;

/**
 * A property that is either a plain constant value or a keyframe track,
 * mirroring `Property<T> = T | KeyframeTrack<T>` in `@cadra/core`.
 *
 * A bare value of `valueSchema`'s type is accepted as-is; an object shaped
 * like a keyframe track is validated (and, if invalid, diagnosed) by
 * `keyframeTrackSchema`. Zod's union tries each member in order and reports
 * the closest failing member's issues if neither matches, so a malformed
 * keyframe-track-shaped object is reported against the keyframe track
 * branch rather than as "not a valid value of T".
 */
export function propertySchema<ValueSchema extends z.ZodType>(valueSchema: ValueSchema) {
  return z.union([valueSchema, keyframeTrackSchema(valueSchema)]);
}

type _CheckProperty = AssertTrue<
  AssertEqual<z.infer<ReturnType<typeof propertySchema<z.ZodNumber>>>, Property<number>>
>;
