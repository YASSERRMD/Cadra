/**
 * Metadata naming which props of each primitive are expected to become
 * keyframeable once a later phase (Phase 10) adds real keyframe binding.
 *
 * This is documentation, not a functioning animation system: nothing here
 * reads or interpolates these props today. Each list names dot-paths into
 * the `SceneNode` (or `Clip`) shape the corresponding primitive produces,
 * scoped to fields that vary smoothly over time, as opposed to structural
 * fields (`id`, `kind`, `children`) that a keyframe system would never
 * target.
 */

/** Props on every scene node kind expected to become keyframeable: the shared `Transform`. */
const TRANSFORM_ANIMATABLE_PROPERTIES = [
  "transform.position",
  "transform.rotation",
  "transform.scale",
] as const;

/** `Shape` (`MeshNode`) animatable props: transform plus visibility toggling. */
export const SHAPE_ANIMATABLE_PROPERTIES = [...TRANSFORM_ANIMATABLE_PROPERTIES, "visible"] as const;

/** `Text` (`TextNode`) animatable props: transform, color, and font size. */
export const TEXT_ANIMATABLE_PROPERTIES = [
  ...TRANSFORM_ANIMATABLE_PROPERTIES,
  "color",
  "fontSize",
  "visible",
] as const;

/** `Image` (`ImageNode`) animatable props: transform and visibility. */
export const IMAGE_ANIMATABLE_PROPERTIES = [...TRANSFORM_ANIMATABLE_PROPERTIES, "visible"] as const;

/** `Camera` (`CameraNode`) animatable props: transform, look-at target, and lens. */
export const CAMERA_ANIMATABLE_PROPERTIES = [
  ...TRANSFORM_ANIMATABLE_PROPERTIES,
  "target",
  "fov",
  "near",
  "far",
] as const;

/** `Light` (`LightNode`) animatable props: transform, color, and intensity. */
export const LIGHT_ANIMATABLE_PROPERTIES = [
  ...TRANSFORM_ANIMATABLE_PROPERTIES,
  "color",
  "intensity",
] as const;
