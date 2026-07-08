import type {
  CameraNode,
  ColliderConfig,
  CompositionRefNode,
  EasingName,
  GroupNode,
  ImageNode,
  LightNode,
  LightShadowConfig,
  LightType,
  MeshMaterialConfig,
  MeshNode,
  ParticleBlendMode,
  ParticleColliderConfig,
  ParticleColorStop,
  ParticleEmitterShape,
  ParticleForceConfig,
  ParticleSizeStop,
  ParticleSystemNode,
  RigidBodyConfig,
  SatoriElementKeyframes,
  SatoriLayerFontRef,
  SatoriNode,
  SceneNode,
  SceneNodeKind,
  TextFill,
  TextGlowConfig,
  TextGlowDirection,
  TextGradientStop,
  TextMorphConfig,
  TextNode,
  TextOutlineConfig,
  TextPathAlignment,
  TextPathConfig,
  TextPathOrientation,
  TextPathSegment,
  TextPathSpacing,
  TextPhysicsConfig,
  TextPhysicsEffect,
  TextShadowConfig,
  TextStaggerConfig,
  TextStaggerDirection,
  TextStaggerGrouping,
  TextStaggerPreset,
  VideoBlendMode,
  VideoFitMode,
  VideoNode,
  VideoOutOfRangeBehavior,
  VolumeNode,
  VolumeShape,
} from "@cadra/core";
import { z } from "zod";

import { propertySchema } from "./keyframes.js";
import { layerElementSchema } from "./layer-element.js";
import { animatableTransformSchema, colorRgbaSchema, vector3Schema } from "./primitives.js";

/**
 * Zod mirror of the discriminated `SceneNode` union in
 * `@cadra/core`'s `scene-graph/scene-node.ts`.
 *
 * Every kind shares the same base fields (`id`, `kind`, optional `name`,
 * `transform`, `visible`, `children`) and is discriminated on `kind` via
 * `z.discriminatedUnion`, matching the core union exactly: an unrecognized
 * `kind` value, or a variant's own fields on the wrong `kind`, is rejected at
 * parse time rather than silently coerced.
 *
 * `transform` on every variant is `animatableTransformSchema` (mirroring
 * `AnimatableTransform`): `position`/`rotation`/`scale` are each independently
 * a plain `Vector3` or a keyframe track. `visible` on every variant accepts
 * either a plain boolean or a keyframe track, via `propertySchema(z.boolean())`
 * (mirroring `Property<boolean>`).
 *
 * `children` on every variant is typed as an array of the *whole* union
 * (defined via a lazy getter so the self-reference is legal at module
 * evaluation time), since any node kind may nest any other node kind as a
 * child, exactly like the recursive `SceneNode[]` field in core.
 *
 * Every variant is built with `z.strictObject` rather than `z.object`: an
 * agent-authored document with a misspelled or stray field name is rejected
 * with a diagnostic, not silently stripped, matching the `additionalProperties:
 * false` every object already gets in the generated JSON Schema (`z.object`
 * would leave the two validation paths inconsistent, since Zod's runtime
 * `safeParse` strips unknown keys by default even though its own JSON Schema
 * output marks them disallowed).
 */

/** A compile-time-only equality check between two types, with no runtime cost. */
type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Forces `T` to be exactly the literal type `true`, or the file fails to typecheck. */
type AssertTrue<T extends true> = T;

/** Every kind of node the scene graph can represent, mirroring `SceneNodeKind`. */
export const sceneNodeKindSchema = z
  .enum([
    "group",
    "mesh",
    "camera",
    "light",
    "text",
    "image",
    "video",
    "compositionRef",
    "satori",
    "particles",
    "volume",
  ])
  .describe("Which of the fixed set of scene node kinds this node is.");

type _CheckSceneNodeKind = AssertTrue<
  AssertEqual<z.infer<typeof sceneNodeKindSchema>, SceneNodeKind>
>;

/**
 * The kind of light source a light node represents, mirroring `LightType`.
 * `"area"` is a rectangular area light; Three.js's own `RectAreaLight` has no
 * shadow support at all, so `castShadow` is a harmless no-op for it.
 */
export const lightTypeSchema = z
  .enum(["ambient", "directional", "point", "spot", "area"])
  .describe("The kind of light source this light node represents.");

type _CheckLightType = AssertTrue<AssertEqual<z.infer<typeof lightTypeSchema>, LightType>>;

/**
 * Shadow-map tuning for a light node with `castShadow: true`, mirroring
 * `LightShadowConfig`. Every field is structural, not a keyframe-track
 * property: shadow-map quality is a rendering-configuration concern, not
 * continuously animated content. Omitted fields fall back to Three.js's own
 * already-reasonable defaults.
 */
export const lightShadowConfigSchema = z.strictObject({
  mapSize: z
    .number()
    .optional()
    .describe(
      "Shadow map resolution (both width and height), in pixels; must be a power of two. Defaults to 512.",
    ),
  bias: z
    .number()
    .optional()
    .describe("Shadow map depth bias; small adjustments (around 0.0001) can reduce shadow acne. Defaults to 0."),
  radius: z
    .number()
    .optional()
    .describe("Softens the shadow's own edge by blurring the shadow map. Defaults to 1."),
});

type _CheckLightShadowConfig = AssertTrue<
  AssertEqual<z.infer<typeof lightShadowConfigSchema>, LightShadowConfig>
>;

/**
 * How a video node's source video is fitted into its plane, mirroring
 * `VideoFitMode`. See `VideoFitMode`'s own doc comment in `@cadra/core` for
 * what each keyword means.
 */
export const videoFitModeSchema = z
  .enum(["cover", "contain", "fill", "none"])
  .describe(
    "How the source video is fitted into this node's plane when aspect ratios differ, " +
      "mirroring the CSS object-fit keywords of the same names.",
  );

type _CheckVideoFitMode = AssertTrue<AssertEqual<z.infer<typeof videoFitModeSchema>, VideoFitMode>>;

/**
 * What a video node does once its clip-local frame maps past its trimmed
 * source range's natural end, mirroring `VideoOutOfRangeBehavior`. See
 * `VideoOutOfRangeBehavior`'s own doc comment in `@cadra/core` for the exact
 * boundary semantics of each option.
 */
export const videoOutOfRangeBehaviorSchema = z
  .enum(["hold", "loop"])
  .describe(
    "What happens once the clip-local frame maps past the trimmed source range's natural " +
      "end (only relevant when the source is shorter than this node's placement). 'hold' " +
      "freezes on the trimmed range's last frame; 'loop' wraps back to its first frame.",
  );

type _CheckVideoOutOfRangeBehavior = AssertTrue<
  AssertEqual<z.infer<typeof videoOutOfRangeBehaviorSchema>, VideoOutOfRangeBehavior>
>;

/**
 * How a video node's pixels combine with whatever composites beneath it,
 * mirroring `VideoBlendMode`. See `VideoBlendMode`'s own doc comment in
 * `@cadra/core` for what each keyword means.
 */
export const videoBlendModeSchema = z
  .enum(["normal", "add", "multiply", "screen"])
  .describe(
    "How this video layer's pixels combine with whatever renders beneath it, mirroring a " +
      "small subset of the CSS/Canvas blend-mode keywords of the same names. Defaults to 'normal' " +
      "(plain alpha compositing).",
  );

type _CheckVideoBlendMode = AssertTrue<
  AssertEqual<z.infer<typeof videoBlendModeSchema>, VideoBlendMode>
>;

/** A plain container node. Groups exist only to organize their children. */
export const groupNodeSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this scene node within the project."),
  kind: z.literal("group").describe("Discriminant identifying this node as a group."),
  name: z
    .string()
    .optional()
    .describe("Optional human-readable label, purely for authoring and debugging."),
  transform: animatableTransformSchema.describe(
    "The position, rotation, and scale of this node. Each field is a plain Vector3 or a keyframe track.",
  ),
  visible: propertySchema(z.boolean()).describe(
    "Whether this node (and its subtree) should be rendered. A plain boolean or a keyframe track.",
  ),
  get children(): z.ZodArray<typeof sceneNodeSchema> {
    return z.array(sceneNodeSchema).describe("Child scene nodes nested under this node.");
  },
});

type _CheckGroupNode = AssertTrue<AssertEqual<z.infer<typeof groupNodeSchema>, GroupNode>>;

/**
 * A physically based material, in the metalness/roughness workflow,
 * mirroring `MeshMaterialConfig`. Every color/scalar channel accepts either a
 * plain value or a keyframe track, via `propertySchema`; only the two
 * texture references are plain strings, matching `TextFill`'s own
 * `assetRef`.
 */
export const meshMaterialConfigSchema = z.strictObject({
  baseColor: propertySchema(colorRgbaSchema)
    .optional()
    .describe("The surface's own albedo color. Defaults to a neutral, cinematic 70% gray."),
  metalness: propertySchema(z.number())
    .optional()
    .describe("0 (fully dielectric) to 1 (fully metallic). Defaults to 0."),
  roughness: propertySchema(z.number())
    .optional()
    .describe("0 (mirror-smooth) to 1 (fully matte). Defaults to a cinematic 0.5."),
  emissive: propertySchema(colorRgbaSchema)
    .optional()
    .describe("Self-illumination color, added on top of lit shading. Defaults to black (no emission)."),
  emissiveIntensity: propertySchema(z.number()).optional().describe("Multiplies emissive. Defaults to 1."),
  clearcoat: propertySchema(z.number())
    .optional()
    .describe("A second, thin reflective layer over the base surface, 0 to 1. Defaults to 0."),
  clearcoatRoughness: propertySchema(z.number())
    .optional()
    .describe("The clearcoat layer's own roughness, independent of the base surface's roughness. Defaults to 0."),
  transmission: propertySchema(z.number())
    .optional()
    .describe(
      "How much light passes through the surface instead of reflecting (glass, water, thin plastic), 0 to 1. Defaults to 0.",
    ),
  ior: propertySchema(z.number())
    .optional()
    .describe(
      "The index of refraction, controlling how sharply light bends passing through a transmission-ed surface. Defaults to 1.5 (window glass). Read only when transmission is non-zero.",
    ),
  thickness: propertySchema(z.number())
    .optional()
    .describe(
      "The volume's thickness beneath the surface, in the mesh's own local units. Defaults to 0. Read only when transmission is non-zero.",
    ),
  sheen: propertySchema(z.number())
    .optional()
    .describe(
      "A soft, fabric-like retroreflective sheen at grazing angles (velvet, felt, brushed textiles), 0 to 1. Defaults to 0.",
    ),
  sheenRoughness: propertySchema(z.number())
    .optional()
    .describe(
      "The sheen layer's own roughness, independent of the base surface's roughness. Defaults to 1. Read only when sheen is non-zero.",
    ),
  sheenColor: propertySchema(colorRgbaSchema)
    .optional()
    .describe("The sheen layer's own tint. Defaults to black. Read only when sheen is non-zero."),
  opacity: propertySchema(z.number()).optional().describe("Overall opacity, 0 to 1. Defaults to 1."),
  normalMapRef: z
    .string()
    .optional()
    .describe("Id of a normal map texture asset, resolved against a texture registry by the renderer."),
  aoMapRef: z
    .string()
    .optional()
    .describe("Id of an ambient-occlusion map texture asset, resolved against a texture registry by the renderer."),
});

type _CheckMeshMaterialConfig = AssertTrue<
  AssertEqual<z.infer<typeof meshMaterialConfigSchema>, MeshMaterialConfig>
>;

/** A rigid-body collision shape, mirroring `ColliderConfig`. A discriminated union on `shape`. */
export const colliderConfigSchema = z.discriminatedUnion("shape", [
  z.strictObject({
    shape: z.literal("box"),
    halfExtents: vector3Schema.describe("Half-width, half-height, half-depth of the box, in the mesh node's own local units."),
  }),
  z.strictObject({
    shape: z.literal("sphere"),
    radius: z.number().positive(),
  }),
  z.strictObject({
    shape: z.literal("capsule"),
    halfHeight: z.number().positive().describe("Half the length of the capsule's own straight cylindrical section, excluding its rounded caps."),
    radius: z.number().positive(),
  }),
  z.strictObject({
    shape: z.literal("cylinder"),
    halfHeight: z.number().positive(),
    radius: z.number().positive(),
  }),
]);

type _CheckColliderConfig = AssertTrue<AssertEqual<z.infer<typeof colliderConfigSchema>, ColliderConfig>>;

/** Rigid-body physics for a `MeshNode`, mirroring `RigidBodyConfig`. */
export const rigidBodyConfigSchema = z.strictObject({
  bodyType: z.enum(["dynamic", "fixed", "kinematic"]),
  collider: colliderConfigSchema,
  mass: z.number().positive().optional(),
  friction: z.number().min(0).optional(),
  restitution: z.number().min(0).max(1).optional(),
  linearDamping: z.number().min(0).optional(),
  angularDamping: z.number().min(0).optional(),
  initialLinearVelocity: vector3Schema.optional(),
  initialAngularVelocity: vector3Schema.optional(),
  ccdEnabled: z.boolean().optional(),
});

type _CheckRigidBodyConfig = AssertTrue<AssertEqual<z.infer<typeof rigidBodyConfigSchema>, RigidBodyConfig>>;

/**
 * A renderable mesh. `geometryRef` and `materialRef` are ids resolved
 * against a geometry and material registry by a later phase; the scene DSL
 * itself stays agnostic to how those registries are populated.
 */
export const meshNodeSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this scene node within the project."),
  kind: z.literal("mesh").describe("Discriminant identifying this node as a mesh."),
  name: z
    .string()
    .optional()
    .describe("Optional human-readable label, purely for authoring and debugging."),
  transform: animatableTransformSchema.describe(
    "The position, rotation, and scale of this node. Each field is a plain Vector3 or a keyframe track.",
  ),
  visible: propertySchema(z.boolean()).describe(
    "Whether this node (and its subtree) should be rendered. A plain boolean or a keyframe track.",
  ),
  geometryRef: z
    .string()
    .describe("Id of a geometry asset, resolved against a geometry registry by the renderer."),
  materialRef: z
    .string()
    .describe("Id of a material asset, resolved against a material registry by the renderer."),
  material: meshMaterialConfigSchema
    .optional()
    .describe("A physically based material, taking over from materialRef entirely when present."),
  castShadow: z
    .boolean()
    .optional()
    .describe("Whether this mesh casts a shadow onto other shadow-receiving surfaces. Defaults to false."),
  receiveShadow: z
    .boolean()
    .optional()
    .describe("Whether this mesh receives shadows cast by shadow-casting lights. Defaults to false."),
  rigidBody: rigidBodyConfigSchema
    .optional()
    .describe("Rigid-body physics simulated by @cadra/physics. Omitted means this mesh is not physics-driven."),
  get children(): z.ZodArray<typeof sceneNodeSchema> {
    return z.array(sceneNodeSchema).describe("Child scene nodes nested under this node.");
  },
});

type _CheckMeshNode = AssertTrue<AssertEqual<z.infer<typeof meshNodeSchema>, MeshNode>>;

/**
 * A camera. `target` is the world-space point the camera looks at.
 *
 * `fov`, `near`, `far`, and `target` each accept either a plain value or a
 * keyframe track, via `propertySchema` (mirroring `Property<T>` on
 * `CameraNode` in `@cadra/core`), same as the shared `transform`
 * (`animatableTransformSchema`) and `visible` every node kind now has.
 */
export const cameraNodeSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this scene node within the project."),
  kind: z.literal("camera").describe("Discriminant identifying this node as a camera."),
  name: z
    .string()
    .optional()
    .describe("Optional human-readable label, purely for authoring and debugging."),
  transform: animatableTransformSchema.describe(
    "The position, rotation, and scale of this node. Each field is a plain Vector3 or a keyframe track.",
  ),
  visible: propertySchema(z.boolean()).describe(
    "Whether this node (and its subtree) should be rendered. A plain boolean or a keyframe track.",
  ),
  fov: propertySchema(z.number()).describe(
    "Vertical field of view, in degrees. A plain number or a keyframe track.",
  ),
  near: propertySchema(z.number()).describe(
    "Distance to the near clipping plane. A plain number or a keyframe track.",
  ),
  far: propertySchema(z.number()).describe(
    "Distance to the far clipping plane. A plain number or a keyframe track.",
  ),
  target: propertySchema(vector3Schema).describe(
    "The world-space point the camera looks at. A plain Vector3 or a keyframe track.",
  ),
  get children(): z.ZodArray<typeof sceneNodeSchema> {
    return z.array(sceneNodeSchema).describe("Child scene nodes nested under this node.");
  },
});

type _CheckCameraNode = AssertTrue<AssertEqual<z.infer<typeof cameraNodeSchema>, CameraNode>>;

/**
 * A light source.
 *
 * `color` and `intensity` each accept either a plain value or a keyframe
 * track, via `propertySchema` (mirroring `Property<T>` on `LightNode` in
 * `@cadra/core`).
 */
export const lightNodeSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this scene node within the project."),
  kind: z.literal("light").describe("Discriminant identifying this node as a light."),
  name: z
    .string()
    .optional()
    .describe("Optional human-readable label, purely for authoring and debugging."),
  transform: animatableTransformSchema.describe(
    "The position, rotation, and scale of this node. Each field is a plain Vector3 or a keyframe track.",
  ),
  visible: propertySchema(z.boolean()).describe(
    "Whether this node (and its subtree) should be rendered. A plain boolean or a keyframe track.",
  ),
  lightType: lightTypeSchema,
  color: propertySchema(colorRgbaSchema).describe(
    "The color this light emits. A plain ColorRGBA or a keyframe track.",
  ),
  intensity: propertySchema(z.number()).describe(
    "The brightness of this light source. A plain number or a keyframe track.",
  ),
  castShadow: z
    .boolean()
    .optional()
    .describe(
      "Whether this light casts shadows onto shadow-receiving meshes. Defaults to false. A harmless " +
        "no-op for lightType 'area', since Three.js's RectAreaLight has no shadow support at all.",
    ),
  shadow: lightShadowConfigSchema
    .optional()
    .describe("Shadow-map quality tuning, only meaningful when castShadow is true. Omitted means Three.js's own defaults."),
  distance: z
    .number()
    .optional()
    .describe(
      "For 'point'/'spot' lights: maximum range of the light, in scene units. 0 (Three.js's own default) " +
        "means no distance cutoff.",
    ),
  decay: z
    .number()
    .optional()
    .describe(
      "For 'point'/'spot' lights: how much the light dims over distance. 2 (Three.js's own default) is " +
        "physically correct inverse-square falloff.",
    ),
  angle: z
    .number()
    .optional()
    .describe(
      "For 'spot' lights only: the light cone's maximum angle from its own direction, in radians, up to " +
        "Math.PI / 2. Defaults to Three.js's own Math.PI / 3.",
    ),
  penumbra: z
    .number()
    .optional()
    .describe("For 'spot' lights only: how much the cone's edge is softened, from 0 to 1. Defaults to 0."),
  width: z
    .number()
    .optional()
    .describe("For 'area' lights only: the rectangle's width, in scene units. Defaults to 10."),
  height: z
    .number()
    .optional()
    .describe("For 'area' lights only: the rectangle's height, in scene units. Defaults to 10."),
  get children(): z.ZodArray<typeof sceneNodeSchema> {
    return z.array(sceneNodeSchema).describe("Child scene nodes nested under this node.");
  },
});

type _CheckLightNode = AssertTrue<AssertEqual<z.infer<typeof lightNodeSchema>, LightNode>>;

/** Mirrors `EasingName`: every named curve `@cadra/core`'s `easing.ts` exports, excluding `cubicBezier` (a factory, not a ready-made curve). */
export const easingNameSchema = z
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
  ])
  .describe("Which named easing curve to apply.");

type _CheckEasingName = AssertTrue<AssertEqual<z.infer<typeof easingNameSchema>, EasingName>>;

/** Mirrors `TextStaggerGrouping`. */
export const textStaggerGroupingSchema = z
  .enum(["grapheme", "character", "word", "line"])
  .describe("Which unit a TextStaggerConfig splits the node's own content into.");

type _CheckTextStaggerGrouping = AssertTrue<
  AssertEqual<z.infer<typeof textStaggerGroupingSchema>, TextStaggerGrouping>
>;

/** Mirrors `TextStaggerDirection`. */
export const textStaggerDirectionSchema = z
  .enum(["forward", "backward", "centerOut"])
  .describe("The order units start their own reveal in, relative to their reading-order rank.");

type _CheckTextStaggerDirection = AssertTrue<
  AssertEqual<z.infer<typeof textStaggerDirectionSchema>, TextStaggerDirection>
>;

/** Mirrors `TextStaggerPreset`. */
export const textStaggerPresetSchema = z
  .enum(["typewriter", "fadeInUp", "lineReveal", "wave"])
  .describe("A starter kinetic-typography preset.");

type _CheckTextStaggerPreset = AssertTrue<AssertEqual<z.infer<typeof textStaggerPresetSchema>, TextStaggerPreset>>;

/** Mirrors `TextStaggerConfig`. */
export const textStaggerConfigSchema = z.strictObject({
  preset: textStaggerPresetSchema,
  grouping: textStaggerGroupingSchema,
  startFrame: z.number().describe("The frame the very first unit (in stagger order) begins revealing at."),
  delayFrames: z.number().describe("Frames between each consecutive unit's own reveal start, in stagger order."),
  durationFrames: z
    .number()
    .describe("How many frames one unit's own reveal takes, once it starts. Ignored by \"wave\"."),
  direction: textStaggerDirectionSchema.optional().describe("Defaults to \"forward\"."),
  easing: easingNameSchema.optional().describe("Defaults to \"linear\"."),
  distance: z
    .number()
    .optional()
    .describe(
      "\"fadeInUp\" only: how far below its natural position a unit starts, in fontSize-relative em units. Defaults to 0.5.",
    ),
  amplitude: z
    .number()
    .optional()
    .describe("\"wave\" only: peak vertical offset, in fontSize-relative em units. Defaults to 0.1."),
  periodFrames: z.number().optional().describe("\"wave\" only: frames per full oscillation. Defaults to 30."),
});

type _CheckTextStaggerConfig = AssertTrue<AssertEqual<z.infer<typeof textStaggerConfigSchema>, TextStaggerConfig>>;

/** Mirrors `TextPhysicsEffect`. */
export const textPhysicsEffectSchema = z
  .enum(["spring", "jitter", "wave", "scramble", "countUp"])
  .describe("Which per-glyph animation a TextPhysicsConfig drives.");

type _CheckTextPhysicsEffect = AssertTrue<AssertEqual<z.infer<typeof textPhysicsEffectSchema>, TextPhysicsEffect>>;

/** Mirrors `TextPhysicsConfig`. */
export const textPhysicsConfigSchema = z.strictObject({
  effect: textPhysicsEffectSchema,
  grouping: textStaggerGroupingSchema,
  seed: z
    .number()
    .optional()
    .describe('Seeds this effect\'s own deterministic randomness ("jitter"\'s noise, "scramble"\'s character choices). Defaults to 0.'),
  startFrame: z
    .number()
    .optional()
    .describe('"spring"/"scramble" only: the frame the very first unit (in rank order) begins animating at. Defaults to 0.'),
  delayFrames: z
    .number()
    .optional()
    .describe(
      '"spring"/"scramble" only: frames between each consecutive unit\'s own start, in rank order. Defaults to 0 (every unit starts together).',
    ),
  durationFrames: z
    .number()
    .optional()
    .describe('"spring"/"scramble"/"countUp" only: how many frames one unit\'s own animation takes, once it starts. Defaults to 30.'),
  direction: textStaggerDirectionSchema.optional().describe("Defaults to \"forward\"."),
  fps: z
    .number()
    .optional()
    .describe(
      '"spring" only: the composition\'s own frame rate, needed to convert frame counts into physical time for the mass-spring-damper simulation. Defaults to 30.',
    ),
  stiffness: z.number().optional().describe('"spring" only. Defaults to 100.'),
  damping: z.number().optional().describe('"spring" only. Defaults to 10.'),
  mass: z.number().optional().describe('"spring" only. Defaults to 1.'),
  distance: z
    .number()
    .optional()
    .describe(
      '"spring" only: how far (in fontSize-relative em units) a unit starts offset from its natural position. Defaults to 1.',
    ),
  positionAmplitude: z
    .number()
    .optional()
    .describe(
      '"jitter"/"wave" only: peak offset, in fontSize-relative em units. Defaults to 0.05 for "jitter", 0.1 for "wave".',
    ),
  rotationAmplitude: z
    .number()
    .optional()
    .describe(
      '"jitter" only: peak rotation around the glyph\'s own local Z axis, in radians. Defaults to 0 (no rotation jitter).',
    ),
  periodFrames: z
    .number()
    .optional()
    .describe(
      '"jitter"\'s own noise checkpoint spacing, or "wave"\'s own oscillation period, in frames. Defaults to 20 for "jitter", 30 for "wave".',
    ),
  charset: z
    .string()
    .optional()
    .describe(
      '"scramble" only: which characters a not-yet-locked-in unit is randomly drawn from. Defaults to uppercase Latin letters and digits.',
    ),
  fromValue: z.number().optional().describe('"countUp" only: the value displayed at frame <= startFrame. Defaults to 0.'),
  toValue: z
    .number()
    .optional()
    .describe('"countUp" only: the value displayed at frame >= startFrame + durationFrames. Defaults to 0.'),
  decimalPlaces: z.number().optional().describe('"countUp" only: fixed decimal places in the formatted number. Defaults to 0.'),
  useGrouping: z
    .boolean()
    .optional()
    .describe(
      '"countUp" only: whether to group digits with a thousands separator (always a fixed en-US-equivalent format regardless of runtime locale). Defaults to false.',
    ),
  easing: easingNameSchema.optional().describe('"countUp" only: eases the count\'s own progress. Defaults to "linear".'),
});

type _CheckTextPhysicsConfig = AssertTrue<
  AssertEqual<z.infer<typeof textPhysicsConfigSchema>, TextPhysicsConfig>
>;

/** Mirrors `TextPathSegment`. */
export const textPathSegmentSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("line"),
    to: propertySchema(vector3Schema).describe("The end point of this straight segment."),
  }),
  z.strictObject({
    type: z.literal("quadratic"),
    control: propertySchema(vector3Schema).describe(
      "The single control point of this quadratic Bezier segment.",
    ),
    to: propertySchema(vector3Schema).describe("The end point of this segment."),
  }),
  z.strictObject({
    type: z.literal("cubic"),
    control1: propertySchema(vector3Schema).describe(
      "The first control point of this cubic Bezier segment.",
    ),
    control2: propertySchema(vector3Schema).describe(
      "The second control point of this cubic Bezier segment.",
    ),
    to: propertySchema(vector3Schema).describe("The end point of this segment."),
  }),
]);

type _CheckTextPathSegment = AssertTrue<AssertEqual<z.infer<typeof textPathSegmentSchema>, TextPathSegment>>;

/** Mirrors `TextPathOrientation`. */
export const textPathOrientationSchema = z
  .enum(["upright", "tangent"])
  .describe(
    "Whether a TextPathConfig's glyphs rotate to follow the curve's own tangent at each point (\"tangent\") or stay upright, only translating (\"upright\").",
  );

type _CheckTextPathOrientation = AssertTrue<
  AssertEqual<z.infer<typeof textPathOrientationSchema>, TextPathOrientation>
>;

/** Mirrors `TextPathSpacing`. */
export const textPathSpacingSchema = z
  .enum(["advance", "even"])
  .describe(
    "How a TextPathConfig spaces glyphs along its own curve: \"advance\" preserves each glyph's own natural advance-width proportions, \"even\" distributes them at equal arc-length intervals instead.",
  );

type _CheckTextPathSpacing = AssertTrue<AssertEqual<z.infer<typeof textPathSpacingSchema>, TextPathSpacing>>;

/** Mirrors `TextPathAlignment`. */
export const textPathAlignmentSchema = z
  .enum(["start", "center", "end"])
  .describe(
    "Which part of the text (its first unit, its own midpoint, or its last unit) a TextPathConfig positions exactly at startOffset.",
  );

type _CheckTextPathAlignment = AssertTrue<
  AssertEqual<z.infer<typeof textPathAlignmentSchema>, TextPathAlignment>
>;

/** Mirrors `TextPathConfig`. */
export const textPathConfigSchema = z.strictObject({
  start: propertySchema(vector3Schema).describe("The curve's own starting point."),
  segments: z
    .array(textPathSegmentSchema)
    .readonly()
    .describe("The curve's own sequence of segments, each continuing from where the previous one left off."),
  progress: propertySchema(z.number())
    .optional()
    .describe(
      "How much of the curve's own remaining length (from startOffset to the curve's own end) the text's full span is stretched across. 1 (the default) uses all of it; less compresses the whole text into a shorter leading portion.",
    ),
  startOffset: propertySchema(z.number())
    .optional()
    .describe(
      "Where along the curve's own arc length (0 to 1) the text's own alignment-anchored point sits. Defaults to 0.",
    ),
  orientation: textPathOrientationSchema.optional().describe("Defaults to \"tangent\"."),
  spacing: textPathSpacingSchema.optional().describe("Defaults to \"advance\"."),
  alignment: textPathAlignmentSchema.optional().describe("Defaults to \"start\"."),
});

type _CheckTextPathConfig = AssertTrue<AssertEqual<z.infer<typeof textPathConfigSchema>, TextPathConfig>>;

/** Mirrors `TextMorphConfig`. */
export const textMorphConfigSchema = z.strictObject({
  from: z.string().describe("The text this node's own content crossfade-morphs from."),
  grouping: textStaggerGroupingSchema,
  progress: propertySchema(z.number()).describe(
    "0 shows from exactly as laid out; 1 shows content exactly as laid out.",
  ),
});

type _CheckTextMorphConfig = AssertTrue<AssertEqual<z.infer<typeof textMorphConfigSchema>, TextMorphConfig>>;

/** Mirrors `TextGradientStop`. */
export const textGradientStopSchema = z.strictObject({
  offset: z.number().describe("0 at the gradient's own start, 1 at its own end. Structural, not animatable."),
  color: propertySchema(colorRgbaSchema),
});

type _CheckTextGradientStop = AssertTrue<AssertEqual<z.infer<typeof textGradientStopSchema>, TextGradientStop>>;

/** Mirrors `TextFill`. */
export const textFillSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("solid"), color: propertySchema(colorRgbaSchema) }),
  z.strictObject({
    type: z.literal("linearGradient"),
    angle: propertySchema(z.number()).optional().describe("In degrees. Defaults to 0."),
    stops: z.array(textGradientStopSchema).readonly(),
  }),
  z.strictObject({
    type: z.literal("radialGradient"),
    stops: z.array(textGradientStopSchema).readonly(),
  }),
  z.strictObject({ type: z.literal("texture"), assetRef: z.string() }),
  z.strictObject({ type: z.literal("video"), assetRef: z.string() }),
]);

type _CheckTextFill = AssertTrue<AssertEqual<z.infer<typeof textFillSchema>, TextFill>>;

/** Mirrors `TextOutlineConfig`. */
export const textOutlineConfigSchema = z.strictObject({
  width: propertySchema(z.number()).describe("In fontSize-relative em units."),
  color: propertySchema(colorRgbaSchema),
});

type _CheckTextOutlineConfig = AssertTrue<
  AssertEqual<z.infer<typeof textOutlineConfigSchema>, TextOutlineConfig>
>;

/** Mirrors `TextGlowDirection`. */
export const textGlowDirectionSchema = z
  .enum(["outer", "inner"])
  .describe("Whether a TextGlowConfig extends outward from a glyph's own edge or fades inward from it.");

type _CheckTextGlowDirection = AssertTrue<
  AssertEqual<z.infer<typeof textGlowDirectionSchema>, TextGlowDirection>
>;

/** Mirrors `TextGlowConfig`. */
export const textGlowConfigSchema = z.strictObject({
  direction: textGlowDirectionSchema.optional().describe("Defaults to \"outer\"."),
  radius: propertySchema(z.number()).describe("In fontSize-relative em units."),
  color: propertySchema(colorRgbaSchema),
  intensity: propertySchema(z.number()).optional().describe("Multiplies the glow's own peak opacity. Defaults to 1."),
});

type _CheckTextGlowConfig = AssertTrue<AssertEqual<z.infer<typeof textGlowConfigSchema>, TextGlowConfig>>;

/** Mirrors `TextShadowConfig`. */
export const textShadowConfigSchema = z.strictObject({
  offsetX: propertySchema(z.number()).describe("In fontSize-relative em units."),
  offsetY: propertySchema(z.number()).describe("In fontSize-relative em units."),
  blur: propertySchema(z.number())
    .optional()
    .describe("Softens the shadow's own edge, in fontSize-relative em units. Defaults to 0 (a hard shadow)."),
  color: propertySchema(colorRgbaSchema),
  steps: z
    .number()
    .optional()
    .describe(
      "Repeats offsetX/offsetY this many times, stepping further out each repetition, approximating a long shadow. Structural, not animatable. Defaults to 1.",
    ),
});

type _CheckTextShadowConfig = AssertTrue<
  AssertEqual<z.infer<typeof textShadowConfigSchema>, TextShadowConfig>
>;

/**
 * A block of rendered text.
 *
 * `fontSize` and `color` each accept either a plain value or a keyframe
 * track, via `propertySchema` (mirroring `Property<T>` on `TextNode` in
 * `@cadra/core`).
 */
export const textNodeSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this scene node within the project."),
  kind: z.literal("text").describe("Discriminant identifying this node as text."),
  name: z
    .string()
    .optional()
    .describe("Optional human-readable label, purely for authoring and debugging."),
  transform: animatableTransformSchema.describe(
    "The position, rotation, and scale of this node. Each field is a plain Vector3 or a keyframe track.",
  ),
  visible: propertySchema(z.boolean()).describe(
    "Whether this node (and its subtree) should be rendered. A plain boolean or a keyframe track.",
  ),
  content: z.string().describe("The text string to render."),
  fontRef: z
    .string()
    .optional()
    .describe("Id of a registered font asset. Omitted means the renderer's default."),
  fontSize: propertySchema(z.number()).describe(
    "The size to render the text at. A plain number or a keyframe track.",
  ),
  color: propertySchema(colorRgbaSchema).describe(
    "The color to render the text in. A plain ColorRGBA or a keyframe track.",
  ),
  extrudeDepth: propertySchema(z.number())
    .optional()
    .describe(
      "How far to extrude each glyph along its own local Z axis, in fontSize units. Omitted or 0 renders flat MSDF quads; a positive value builds solid 3D glyph geometry instead. A plain number or a keyframe track.",
    ),
  stagger: textStaggerConfigSchema
    .optional()
    .describe(
      "A deterministic per-unit staggered reveal animation across this node's own content. Omitted means no staggering.",
    ),
  physics: textPhysicsConfigSchema
    .optional()
    .describe(
      "Expressive per-glyph animation (springs, jitter, wave, scramble, count-up), composable with stagger. Omitted means no physics effect.",
    ),
  path: textPathConfigSchema
    .optional()
    .describe("Places this node's own glyphs along a curve instead of a flat line. Omitted means a normal flat layout."),
  morph: textMorphConfigSchema
    .optional()
    .describe("Crossfade-morphs this node's own content from another string. Omitted means no morphing: content renders as-is."),
  fill: textFillSchema
    .optional()
    .describe(
      "A richer fill than a flat color: gradient, texture, or video. Omitted means a plain color fill (only meaningful for the flat MSDF path, not the extruded one).",
    ),
  outline: textOutlineConfigSchema
    .optional()
    .describe("An MSDF-based outline around each glyph. Omitted means no outline."),
  glow: textGlowConfigSchema.optional().describe("A soft glow around each glyph. Omitted means no glow."),
  shadow: textShadowConfigSchema
    .optional()
    .describe("A drop or long shadow behind each glyph. Omitted means no shadow."),
  variationAxes: propertySchema(z.record(z.string(), z.number()).readonly())
    .optional()
    .describe(
      "This node's own variable-font axis coordinates (e.g. {wght: 700}), resolved fresh at whatever frame the text is rendered. Omitted means the font's own default instance.",
    ),
  get children(): z.ZodArray<typeof sceneNodeSchema> {
    return z.array(sceneNodeSchema).describe("Child scene nodes nested under this node.");
  },
});

type _CheckTextNode = AssertTrue<AssertEqual<z.infer<typeof textNodeSchema>, TextNode>>;

/** A 2D image plane. `assetRef` is resolved against an asset registry. */
export const imageNodeSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this scene node within the project."),
  kind: z.literal("image").describe("Discriminant identifying this node as an image."),
  name: z
    .string()
    .optional()
    .describe("Optional human-readable label, purely for authoring and debugging."),
  transform: animatableTransformSchema.describe(
    "The position, rotation, and scale of this node. Each field is a plain Vector3 or a keyframe track.",
  ),
  visible: propertySchema(z.boolean()).describe(
    "Whether this node (and its subtree) should be rendered. A plain boolean or a keyframe track.",
  ),
  assetRef: z
    .string()
    .describe("Id of an image asset, resolved against an asset registry by the renderer."),
  get children(): z.ZodArray<typeof sceneNodeSchema> {
    return z.array(sceneNodeSchema).describe("Child scene nodes nested under this node.");
  },
});

type _CheckImageNode = AssertTrue<AssertEqual<z.infer<typeof imageNodeSchema>, ImageNode>>;

/**
 * An external video file placed as a layer, mirroring `VideoNode` in
 * `@cadra/core`. `assetRef` is resolved against an asset registry, exactly
 * like `imageNodeSchema.assetRef`; it may also (transiently, until an
 * `@cadra/mcp-server` caller binds it) hold a `cadra-generation://<slotId>`
 * placeholder ref instead of a real one, per `VideoNode.assetRef`'s own doc.
 *
 * `opacity` accepts either a plain value or a keyframe track, via
 * `propertySchema` (mirroring `Property<number>` on `VideoNode`), same as
 * every other Phase 26 keyframeable field on other node kinds. `blendMode`
 * and `maskRef` (Phase 36) are plain, non-keyframeable optional fields,
 * mirroring `VideoNode.blendMode`/`VideoNode.maskRef` exactly; see that
 * doc comment for why validating and round-tripping them here does not
 * require the renderer to already implement the corresponding GPU math.
 *
 * `.superRefine` enforces two cross-field rules `@cadra/core`'s own types
 * cannot express structurally: `outFrame` (when both `inFrame` and
 * `outFrame` are given) must be strictly greater than `inFrame`, since a
 * trimmed range that ends at or before where it starts has no frames in it;
 * and `playbackRate` (when given) must be positive, since a zero or
 * negative playback rate has no well-defined "how fast the source advances"
 * meaning (a negative rate would mean playing backward, which
 * `resolveVideoSourceFrame` does not model).
 */
export const videoNodeSchema = z
  .strictObject({
    id: z.string().describe("Unique identifier for this scene node within the project."),
    kind: z.literal("video").describe("Discriminant identifying this node as a video."),
    name: z
      .string()
      .optional()
      .describe("Optional human-readable label, purely for authoring and debugging."),
    transform: animatableTransformSchema.describe(
      "The position, rotation, and scale of this node. Each field is a plain Vector3 or a keyframe track.",
    ),
    visible: propertySchema(z.boolean()).describe(
      "Whether this node (and its subtree) should be rendered. A plain boolean or a keyframe track.",
    ),
    assetRef: z
      .string()
      .describe(
        "Id of a video asset, resolved against an asset registry by the renderer. May " +
          "transiently be a cadra-generation://<slotId> placeholder ref for a not-yet-finished " +
          "generation job, rewritten to a real ref once that job completes.",
      ),
    blendMode: videoBlendModeSchema
      .optional()
      .describe(
        "How this video layer's pixels combine with whatever renders beneath it. Defaults to 'normal'.",
      ),
    maskRef: z
      .string()
      .optional()
      .describe(
        "Optional reference to a mask asset restricting which pixels of this video layer are " +
          "visible. Omitted means no masking.",
      ),
    inFrame: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Source-video-local frame the trimmed range starts at, inclusive. Defaults to 0."),
    outFrame: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Source-video-local frame the trimmed range ends at, inclusive. Defaults to the " +
          "source's own last frame.",
      ),
    playbackRate: z
      .number()
      .positive()
      .optional()
      .describe(
        "How fast the source advances relative to composition time. Must be positive. Defaults to 1.",
      ),
    fitMode: videoFitModeSchema
      .optional()
      .describe(
        "How the source video is fitted into this node's plane when aspect ratios differ. " +
          "Defaults to 'cover'.",
      ),
    outOfRangeBehavior: videoOutOfRangeBehaviorSchema
      .optional()
      .describe(
        "What happens once the clip-local frame maps past the trimmed range's natural end. " +
          "Defaults to 'hold'.",
      ),
    opacity: propertySchema(z.number()).describe(
      "Opacity this video layer is composited at, 0 to 1. A plain number or a keyframe track. " +
        "Defaults to 1.",
    ),
    get children(): z.ZodArray<typeof sceneNodeSchema> {
      return z.array(sceneNodeSchema).describe("Child scene nodes nested under this node.");
    },
  })
  .superRefine((node, ctx) => {
    if (
      node.inFrame !== undefined &&
      node.outFrame !== undefined &&
      node.outFrame <= node.inFrame
    ) {
      ctx.addIssue({
        code: "custom",
        message: `outFrame (${node.outFrame}) must be greater than inFrame (${node.inFrame}).`,
        path: ["outFrame"],
      });
    }
  });

type _CheckVideoNode = AssertTrue<AssertEqual<z.infer<typeof videoNodeSchema>, VideoNode>>;

/**
 * A reference to another composition, embedded by id. Carries no content of
 * its own; a timeline resolver replaces it with the referenced composition's
 * resolved output.
 */
export const compositionRefNodeSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this scene node within the project."),
  kind: z
    .literal("compositionRef")
    .describe("Discriminant identifying this node as a composition reference."),
  name: z
    .string()
    .optional()
    .describe("Optional human-readable label, purely for authoring and debugging."),
  transform: animatableTransformSchema.describe(
    "The position, rotation, and scale of this node. Each field is a plain Vector3 or a keyframe track.",
  ),
  visible: propertySchema(z.boolean()).describe(
    "Whether this node (and its subtree) should be rendered. A plain boolean or a keyframe track.",
  ),
  compositionId: z
    .string()
    .describe("Id of the composition this node embeds, resolved by the timeline resolver."),
  get children(): z.ZodArray<typeof sceneNodeSchema> {
    return z.array(sceneNodeSchema).describe("Child scene nodes nested under this node.");
  },
});

type _CheckCompositionRefNode = AssertTrue<
  AssertEqual<z.infer<typeof compositionRefNodeSchema>, CompositionRefNode>
>;

/** One font a Satori layer's own styles can select via CSS `fontFamily`, mirroring `SatoriLayerFontRef`. */
export const satoriLayerFontRefSchema = z.strictObject({
  family: z.string().describe("CSS fontFamily name this font is selected by within the layer's own styles."),
  fontRef: z
    .string()
    .describe(
      "Id of a registered font asset, resolved against the same font registry TextNode.fontRef uses.",
    ),
  weight: z.number().optional().describe("Font weight, 100 to 900. Defaults to 400."),
  style: z.enum(["normal", "italic"]).optional().describe("Font style. Defaults to 'normal'."),
  variationCoordinates: z
    .record(z.string(), z.number())
    .readonly()
    .optional()
    .describe(
      "Explicit variation coordinates for this font (e.g. { wght: 700 }). Axes not mentioned " +
        "default to the font's own declared default.",
    ),
});

type _CheckSatoriLayerFontRef = AssertTrue<
  AssertEqual<z.infer<typeof satoriLayerFontRefSchema>, SatoriLayerFontRef>
>;

/**
 * Per-frame animatable overrides for one element within a Satori layer's own
 * tree, mirroring `SatoriElementKeyframes`. Each field accepts either a
 * plain value or a keyframe track, via `propertySchema` (mirroring
 * `Property<T>`), same as every other keyframeable field on any node kind.
 */
export const satoriElementKeyframesSchema = z.strictObject({
  opacity: propertySchema(z.number()).optional().describe("A plain number or a keyframe track."),
  x: propertySchema(z.number())
    .optional()
    .describe(
      "Horizontal translation added on top of the element's own natural flex-resolved " +
        "position. A plain number or a keyframe track.",
    ),
  y: propertySchema(z.number())
    .optional()
    .describe(
      "Vertical translation added on top of the element's own natural flex-resolved " +
        "position. A plain number or a keyframe track.",
    ),
  color: propertySchema(colorRgbaSchema).optional().describe("A plain ColorRGBA or a keyframe track."),
});

type _CheckSatoriElementKeyframes = AssertTrue<
  AssertEqual<z.infer<typeof satoriElementKeyframesSchema>, SatoriElementKeyframes>
>;

/**
 * A Satori-rendered 2D layer placed as a textured plane, mirroring
 * `SatoriNode` in `@cadra/core`. `layer` is this node's own inline content
 * (like `TextNode.content`), validated against `layerElementSchema`
 * (`layer-element.ts`) - Phase 48's own "validate the layer spec in the
 * schema with clear diagnostics" requirement.
 *
 * `opacity` accepts either a plain value or a keyframe track, via
 * `propertySchema` (mirroring `Property<number>` on `SatoriNode`), same as
 * `videoNodeSchema.opacity`. `blendMode` reuses `videoBlendModeSchema`
 * directly rather than declaring a duplicate: `SatoriBlendMode` is a plain
 * alias of `VideoBlendMode` in `@cadra/core`, so there is only one real
 * mode enum to validate against.
 */
export const satoriNodeSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this scene node within the project."),
  kind: z.literal("satori").describe("Discriminant identifying this node as a Satori 2D layer."),
  name: z
    .string()
    .optional()
    .describe("Optional human-readable label, purely for authoring and debugging."),
  transform: animatableTransformSchema.describe(
    "The position, rotation, and scale of this node. Each field is a plain Vector3 or a keyframe track.",
  ),
  visible: propertySchema(z.boolean()).describe(
    "Whether this node (and its subtree) should be rendered. A plain boolean or a keyframe track.",
  ),
  layer: layerElementSchema.describe("The root of this layer's own element tree, authored inline."),
  width: z
    .number()
    .describe(
      "This layer's own fixed rendering resolution width, in layer units (what Satori lays out " +
        "and resvg rasterizes at). Not a Property<number>: changing it means a full re-render, " +
        "unlike transform.scale.",
    ),
  height: z
    .number()
    .describe("This layer's own fixed rendering resolution height, in layer units. See width."),
  opacity: propertySchema(z.number()).describe(
    "Opacity this layer is composited at, 0 to 1. A plain number or a keyframe track. Defaults to 1.",
  ),
  blendMode: videoBlendModeSchema
    .optional()
    .describe(
      "How this layer's pixels combine with whatever renders beneath it. Defaults to 'normal'.",
    ),
  fonts: z
    .array(satoriLayerFontRefSchema)
    .readonly()
    .optional()
    .describe(
      "Every font layer's own styles reference by fontFamily. Omitted or empty is only valid " +
        "when layer contains no text.",
    ),
  elementAnimations: z
    .record(z.string(), satoriElementKeyframesSchema)
    .readonly()
    .optional()
    .describe(
      "Per-frame animatable overrides for individual elements within layer, keyed by each " +
        "target element's own id.",
    ),
  get children(): z.ZodArray<typeof sceneNodeSchema> {
    return z.array(sceneNodeSchema).describe("Child scene nodes nested under this node.");
  },
});

type _CheckSatoriNode = AssertTrue<AssertEqual<z.infer<typeof satoriNodeSchema>, SatoriNode>>;

/** Where new particles spawn in a particle node's own local space, mirroring `ParticleEmitterShape`. */
export const particleEmitterShapeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("point") }),
  z.strictObject({
    type: z.literal("box"),
    halfExtents: vector3Schema.describe("Half-width, half-height, half-depth of the box, in the node's own local units."),
  }),
  z.strictObject({
    type: z.literal("sphere"),
    radius: z.number().positive(),
  }),
  z.strictObject({
    type: z.literal("cone"),
    radius: z.number().positive(),
    angle: z.number().min(0).describe("Half-angle of the cone, in radians."),
  }),
]);

type _CheckParticleEmitterShape = AssertTrue<
  AssertEqual<z.infer<typeof particleEmitterShapeSchema>, ParticleEmitterShape>
>;

/** A continuous force applied to every live particle each simulated step, mirroring `ParticleForceConfig`. */
export const particleForceConfigSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("gravity"),
    acceleration: vector3Schema,
  }),
  z.strictObject({
    type: z.literal("drag"),
    coefficient: z.number().min(0),
  }),
  z.strictObject({
    type: z.literal("curlNoise"),
    strength: z.number(),
    frequency: z.number().positive(),
    speed: z.number().optional(),
  }),
  z.strictObject({
    type: z.literal("vortex"),
    origin: vector3Schema,
    axis: vector3Schema,
    strength: z.number(),
  }),
]);

type _CheckParticleForceConfig = AssertTrue<
  AssertEqual<z.infer<typeof particleForceConfigSchema>, ParticleForceConfig>
>;

/** A simple analytic collision surface live particles bounce or slide off, mirroring `ParticleColliderConfig`. */
export const particleColliderConfigSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("groundPlane"),
    y: z.number(),
    bounce: z.number().min(0).max(1).optional(),
  }),
  z.strictObject({
    type: z.literal("sphere"),
    center: vector3Schema,
    radius: z.number().positive(),
    bounce: z.number().min(0).max(1).optional(),
  }),
]);

type _CheckParticleColliderConfig = AssertTrue<
  AssertEqual<z.infer<typeof particleColliderConfigSchema>, ParticleColliderConfig>
>;

/** One stop in a particle node's `colorOverLife` gradient, mirroring `ParticleColorStop`. */
export const particleColorStopSchema = z.strictObject({
  time: z.number().min(0).max(1).describe("Position within the particle's own lifetime, 0 (birth) to 1 (death)."),
  color: colorRgbaSchema,
});

type _CheckParticleColorStop = AssertTrue<
  AssertEqual<z.infer<typeof particleColorStopSchema>, ParticleColorStop>
>;

/** One stop in a particle node's `sizeOverLife` curve, mirroring `ParticleSizeStop`. */
export const particleSizeStopSchema = z.strictObject({
  time: z.number().min(0).max(1).describe("Position within the particle's own lifetime, 0 (birth) to 1 (death)."),
  size: z.number().min(0).describe("Size multiplier at this point in the particle's lifetime."),
});

type _CheckParticleSizeStop = AssertTrue<
  AssertEqual<z.infer<typeof particleSizeStopSchema>, ParticleSizeStop>
>;

/** How a particle's own pixels combine with whatever is composited beneath it, mirroring `ParticleBlendMode`. */
export const particleBlendModeSchema = z
  .enum(["normal", "additive"])
  .describe("How a particle's own pixels combine with whatever is composited beneath it. Defaults to 'normal'.");

type _CheckParticleBlendMode = AssertTrue<
  AssertEqual<z.infer<typeof particleBlendModeSchema>, ParticleBlendMode>
>;

/**
 * A GPU-simulated particle emitter (Phase 67), mirroring `ParticleSystemNode`.
 * All stochastic behavior is seeded deterministically from the composition's
 * own frame seed, this node's own `id` and `seed`, and each particle's own
 * slot index.
 */
export const particleSystemNodeSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this scene node within the project."),
  kind: z.literal("particles").describe("Discriminant identifying this node as a particle system."),
  name: z
    .string()
    .optional()
    .describe("Optional human-readable label, purely for authoring and debugging."),
  transform: animatableTransformSchema.describe(
    "The position, rotation, and scale of this node. Each field is a plain Vector3 or a keyframe track.",
  ),
  visible: propertySchema(z.boolean()).describe(
    "Whether this node (and its subtree) should be rendered. A plain boolean or a keyframe track.",
  ),
  maxParticles: z
    .number()
    .int()
    .positive()
    .describe("Fixed size of this emitter's particle pool. Never exceeded regardless of emissionRate."),
  emissionRate: z.number().min(0).describe("Average number of particles spawned per second, while this node is visible."),
  shape: particleEmitterShapeSchema.describe("Where within this node's own local space newly spawned particles appear."),
  lifetimeSeconds: z.number().positive().describe("How long a particle lives after spawning, in seconds, before it is recycled."),
  lifetimeVarianceSeconds: z
    .number()
    .min(0)
    .optional()
    .describe("Randomizes lifetimeSeconds by up to this many seconds, applied symmetrically. Defaults to 0."),
  initialSpeed: z.number().describe("Speed newly spawned particles move at, in scene units per second, along direction."),
  initialSpeedVariance: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Randomizes initialSpeed by up to this fraction of its own value. Defaults to 0."),
  direction: vector3Schema.describe("The nominal direction newly spawned particles move in, in this node's own local space."),
  spreadAngle: z
    .number()
    .min(0)
    .optional()
    .describe("Half-angle, in radians, of the cone around direction initial velocity is randomized within. Defaults to 0."),
  startSize: z.number().positive().describe("Sprite size a particle spawns at, in scene units, before sizeOverLife is applied."),
  sizeVariance: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Randomizes startSize by up to this fraction of its own value. Defaults to 0."),
  forces: z
    .array(particleForceConfigSchema)
    .readonly()
    .optional()
    .describe("Forces applied to every live particle each simulated step. Defaults to none."),
  colliders: z
    .array(particleColliderConfigSchema)
    .readonly()
    .optional()
    .describe("Simple analytic colliders live particles test against each simulated step. Defaults to none."),
  colorOverLife: z
    .array(particleColorStopSchema)
    .readonly()
    .optional()
    .describe("Color across a particle's own lifetime, interpolated linearly between stops sorted by time."),
  sizeOverLife: z
    .array(particleSizeStopSchema)
    .readonly()
    .optional()
    .describe("Size multiplier across a particle's own lifetime, interpolated linearly between stops sorted by time."),
  textureRef: z
    .string()
    .optional()
    .describe("Id of a texture asset resolved against a texture registry by the renderer. Omitted means a plain soft circular sprite."),
  blendMode: particleBlendModeSchema.optional(),
  seed: z
    .number()
    .optional()
    .describe("Combined with the composition's own frame seed and this node's own id to derive this emitter's deterministic stochastic stream."),
  get children(): z.ZodArray<typeof sceneNodeSchema> {
    return z.array(sceneNodeSchema).describe("Child scene nodes nested under this node.");
  },
});

type _CheckParticleSystemNode = AssertTrue<
  AssertEqual<z.infer<typeof particleSystemNodeSchema>, ParticleSystemNode>
>;

/** The bounding shape a volume node's density field fills, mirroring `VolumeShape`. */
export const volumeShapeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("box"),
    halfExtents: vector3Schema.describe("Half-width, half-height, half-depth of the box, in the node's own local units."),
  }),
  z.strictObject({
    type: z.literal("sphere"),
    radius: z.number().positive(),
  }),
]);

type _CheckVolumeShape = AssertTrue<AssertEqual<z.infer<typeof volumeShapeSchema>, VolumeShape>>;

/**
 * A simple animated volumetric smoke/mist volume (Phase 68), mirroring
 * `VolumeNode`. WebGPU-backend only; see that type's own doc.
 */
export const volumeNodeSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this scene node within the project."),
  kind: z.literal("volume").describe("Discriminant identifying this node as a volumetric smoke/mist volume."),
  name: z
    .string()
    .optional()
    .describe("Optional human-readable label, purely for authoring and debugging."),
  transform: animatableTransformSchema.describe(
    "The position, rotation, and scale of this node. Each field is a plain Vector3 or a keyframe track.",
  ),
  visible: propertySchema(z.boolean()).describe(
    "Whether this node (and its subtree) should be rendered. A plain boolean or a keyframe track.",
  ),
  shape: volumeShapeSchema.describe("The bounding shape this volume's density field fills."),
  color: propertySchema(colorRgbaSchema).describe(
    "This volume's own base color, lit by the scene's own point/spot lights (ambient/directional lights do not contribute; see VolumeNode's own doc). A plain ColorRGBA or a keyframe track.",
  ),
  density: propertySchema(z.number().min(0)).describe(
    "Overall density multiplier: higher looks thicker/more opaque. A plain number or a keyframe track. Defaults to 1.",
  ),
  noiseFrequency: z
    .number()
    .positive()
    .optional()
    .describe("Spatial frequency of the underlying value-noise field. Higher values give smaller, more turbulent detail. Defaults to 1."),
  driftSpeed: z
    .number()
    .optional()
    .describe("How fast the sampled noise field drifts along its own local Z axis, in units per second. Defaults to 0 (static)."),
  raymarchSteps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Raymarch step count through shape. Higher is smoother, slower. Defaults to 25."),
  seed: z
    .number()
    .optional()
    .describe("Combined with the composition's own frame seed and this node's own id to derive this volume's deterministic noise field."),
  get children(): z.ZodArray<typeof sceneNodeSchema> {
    return z.array(sceneNodeSchema).describe("Child scene nodes nested under this node.");
  },
});

type _CheckVolumeNode = AssertTrue<AssertEqual<z.infer<typeof volumeNodeSchema>, VolumeNode>>;

/**
 * A node in the scene graph, discriminated on `kind`. Mirrors the `SceneNode`
 * union in `@cadra/core` exactly: every variant is a strict, closed shape,
 * and an object whose `kind` does not match one of the eleven known literals
 * is rejected rather than coerced into the closest variant.
 */
export const sceneNodeSchema: z.ZodDiscriminatedUnion<
  [
    typeof groupNodeSchema,
    typeof meshNodeSchema,
    typeof cameraNodeSchema,
    typeof lightNodeSchema,
    typeof textNodeSchema,
    typeof imageNodeSchema,
    typeof videoNodeSchema,
    typeof compositionRefNodeSchema,
    typeof satoriNodeSchema,
    typeof particleSystemNodeSchema,
    typeof volumeNodeSchema,
  ]
> = z.discriminatedUnion("kind", [
  groupNodeSchema,
  meshNodeSchema,
  cameraNodeSchema,
  lightNodeSchema,
  textNodeSchema,
  imageNodeSchema,
  videoNodeSchema,
  compositionRefNodeSchema,
  satoriNodeSchema,
  particleSystemNodeSchema,
  volumeNodeSchema,
]);

type _CheckSceneNode = AssertTrue<AssertEqual<z.infer<typeof sceneNodeSchema>, SceneNode>>;
