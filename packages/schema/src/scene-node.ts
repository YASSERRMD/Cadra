import type {
  CameraNode,
  CompositionRefNode,
  EasingName,
  GroupNode,
  ImageNode,
  LightNode,
  LightType,
  MeshNode,
  SatoriElementKeyframes,
  SatoriLayerFontRef,
  SatoriNode,
  SceneNode,
  SceneNodeKind,
  TextNode,
  TextStaggerConfig,
  TextStaggerDirection,
  TextStaggerGrouping,
  TextStaggerPreset,
  VideoBlendMode,
  VideoFitMode,
  VideoNode,
  VideoOutOfRangeBehavior,
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
  .enum(["group", "mesh", "camera", "light", "text", "image", "video", "compositionRef", "satori"])
  .describe("Which of the fixed set of scene node kinds this node is.");

type _CheckSceneNodeKind = AssertTrue<
  AssertEqual<z.infer<typeof sceneNodeKindSchema>, SceneNodeKind>
>;

/** The kind of light source a light node represents, mirroring `LightType`. */
export const lightTypeSchema = z
  .enum(["ambient", "directional", "point", "spot"])
  .describe("The kind of light source this light node represents.");

type _CheckLightType = AssertTrue<AssertEqual<z.infer<typeof lightTypeSchema>, LightType>>;

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

/**
 * A node in the scene graph, discriminated on `kind`. Mirrors the `SceneNode`
 * union in `@cadra/core` exactly: every variant is a strict, closed shape,
 * and an object whose `kind` does not match one of the nine known literals
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
]);

type _CheckSceneNode = AssertTrue<AssertEqual<z.infer<typeof sceneNodeSchema>, SceneNode>>;
