/**
 * Metadata naming which props of each primitive are keyframeable: every
 * field listed below is genuinely `Property<T>`-typed (Phase 10's
 * value-or-keyframe-track model) on the corresponding `SceneNode` variant in
 * `../scene-graph/scene-node.ts`, resolved per frame by the renderer's
 * `applyNodeProperties` (see `@cadra/renderer`'s `reconciler/node-factory.ts`)
 * via `resolveNumberProperty`/`resolveVector3Property`/`resolveColorProperty`/
 * `resolveBooleanProperty`.
 *
 * This module is documentation/metadata, not itself part of the resolution
 * path: nothing here reads or interpolates these props directly. Each list
 * names dot-paths into the `SceneNode` (or `Clip`) shape the corresponding
 * primitive produces, scoped to fields that vary smoothly (or, for `visible`,
 * discretely via `'hold'` easing) over time, as opposed to structural fields
 * (`id`, `kind`, `children`) that a keyframe system would never target.
 */

/** Props on every scene node kind expected to become keyframeable: the shared `Transform`. */
const TRANSFORM_ANIMATABLE_PROPERTIES = [
  "transform.position",
  "transform.rotation",
  "transform.scale",
] as const;

/** `Shape` (`MeshNode`) animatable props: transform plus visibility toggling. */
export const SHAPE_ANIMATABLE_PROPERTIES = [...TRANSFORM_ANIMATABLE_PROPERTIES, "visible"] as const;

/** `Text` (`TextNode`) animatable props: transform, color, font size, and extrusion depth. */
export const TEXT_ANIMATABLE_PROPERTIES = [
  ...TRANSFORM_ANIMATABLE_PROPERTIES,
  "color",
  "fontSize",
  "extrudeDepth",
  "visible",
] as const;

/** `Image` (`ImageNode`) animatable props: transform and visibility. */
export const IMAGE_ANIMATABLE_PROPERTIES = [...TRANSFORM_ANIMATABLE_PROPERTIES, "visible"] as const;

/**
 * `Particles` (`ParticleSystemNode`) animatable props: transform and
 * visibility only. Every emitter-specific field (`emissionRate`,
 * `lifetimeSeconds`, `forces`, and so on) is a plain, structural value, not
 * `Property<T>` - mirroring `RigidBodyConfig`'s own precedent that physics-
 * and simulation-adjacent configuration is authored once, not keyframed.
 */
export const PARTICLES_ANIMATABLE_PROPERTIES = [...TRANSFORM_ANIMATABLE_PROPERTIES, "visible"] as const;

/** `Video` (`VideoNode`) animatable props: transform, visibility, and opacity. */
export const VIDEO_ANIMATABLE_PROPERTIES = [
  ...TRANSFORM_ANIMATABLE_PROPERTIES,
  "visible",
  "opacity",
] as const;

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

/**
 * `Satori` (`SatoriNode`) animatable props: transform, visibility, and
 * opacity - the same shape as `VIDEO_ANIMATABLE_PROPERTIES`. `layer`,
 * `blendMode`, `fonts`, and `elementAnimations` are deliberately excluded:
 * `layer`/`fonts`/`blendMode` are not `Property<T>`-typed at all (changing
 * them means a full re-render, not a per-frame resolve), and
 * `elementAnimations`' own per-element `Property<T>` fields are resolved
 * through a dedicated path (`resolveSatoriElementStyles`), not this
 * dot-path-based one, since they target elements *within* `layer` rather
 * than a field directly on the node itself.
 */
export const SATORI_ANIMATABLE_PROPERTIES = [
  ...TRANSFORM_ANIMATABLE_PROPERTIES,
  "visible",
  "opacity",
] as const;

/** `Volume` (`VolumeNode`) animatable props: transform, visibility, color, and density. */
export const VOLUME_ANIMATABLE_PROPERTIES = [
  ...TRANSFORM_ANIMATABLE_PROPERTIES,
  "visible",
  "color",
  "density",
] as const;

/**
 * `Model` (`ModelNode`) animatable props: transform and visibility only.
 * `clips[].weight` and `morphTargets[name]` are genuinely `Property<number>`
 * (fully keyframeable, resolved the same way every other property here is),
 * but are not simple top-level dot-paths this flat list format can name: an
 * array of clip configs and a dynamically-named map of morph targets, not a
 * fixed field - mirroring `PARTICLES_ANIMATABLE_PROPERTIES`'s own precedent
 * of leaving a primitive's own nested, structurally-varying configuration
 * out of this dot-path mechanism (editable via the DSL panel's raw JSON
 * instead, which has no trouble with arbitrary nested shape).
 */
export const MODEL_ANIMATABLE_PROPERTIES = [...TRANSFORM_ANIMATABLE_PROPERTIES, "visible"] as const;
