import type { Property } from "../keyframes/keyframe-track.js";
import type { AnimatableTransform, ColorRGBA, Vector3 } from "./primitives.js";

/**
 * Every kind of node the scene graph can represent.
 *
 * `compositionRef` deliberately has no rendered geometry of its own: it is a
 * pointer to another `Composition` by id, so a composition can embed another
 * composition as a nested sub-tree. A later phase's timeline resolver is
 * responsible for looking up the referenced composition and splicing its
 * resolved tree in at this point.
 */
export type SceneNodeKind =
  "group" | "mesh" | "camera" | "light" | "text" | "image" | "video" | "compositionRef";

/**
 * Fields shared by every scene node, regardless of kind.
 *
 * `transform` is `AnimatableTransform`: each of `position`/`rotation`/`scale`
 * is independently a `Property<Vector3>` (Phase 10's generic keyframe/property
 * model), so any of the three may be a plain constant or a `KeyframeTrack`
 * animating it over time, for every node kind alike. A plain `Transform`
 * (all three fields as bare `Vector3`s, e.g. from `createIdentityTransform`)
 * is always a valid `AnimatableTransform`, since a bare `T` is always a valid
 * `Property<T>`.
 */
interface SceneNodeBase<Kind extends SceneNodeKind> {
  id: string;
  kind: Kind;
  /** Optional human-readable label, purely for authoring and debugging. */
  name?: string;
  transform: AnimatableTransform;
  /**
   * Whether this node (and its subtree) should be rendered. `Property<boolean>`
   * so visibility can be toggled over time via a keyframe track; a keyframed
   * `visible` track only makes sense with `'hold'` easing between keyframes
   * (see `compileKeyframeTrack`), since a boolean has no continuous blend
   * between `true` and `false`.
   */
  visible: Property<boolean>;
  children: SceneNode[];
}

/** A plain container node. Groups exist only to organize their children. */
export type GroupNode = SceneNodeBase<"group">;

/**
 * A renderable mesh. `geometryRef` and `materialRef` are ids resolved
 * against a geometry and material registry by a later phase (the renderer's
 * scene-graph-to-Three.js mapping); the scene graph itself stays agnostic to
 * how those registries are populated.
 */
export interface MeshNode extends SceneNodeBase<"mesh"> {
  geometryRef: string;
  materialRef: string;
}

/**
 * A camera. `target` is the world-space point the camera looks at.
 *
 * `fov`, `near`, `far`, and `target` are `Property<T>` (Phase 10's generic
 * keyframe/property model), so each may be a plain constant or a
 * `KeyframeTrack` animating it over time, same as the shared `transform`
 * (`AnimatableTransform`) and `visible` every node kind now has.
 */
export interface CameraNode extends SceneNodeBase<"camera"> {
  fov: Property<number>;
  near: Property<number>;
  far: Property<number>;
  target: Property<Vector3>;
}

/** The kind of light source a `LightNode` represents. */
export type LightType = "ambient" | "directional" | "point" | "spot";

/** A light source. */
export interface LightNode extends SceneNodeBase<"light"> {
  lightType: LightType;
  color: Property<ColorRGBA>;
  intensity: Property<number>;
}

/** A block of rendered text. */
export interface TextNode extends SceneNodeBase<"text"> {
  content: string;
  /** Id of a registered font asset. Omitted means the renderer's default. */
  fontRef?: string;
  fontSize: Property<number>;
  color: Property<ColorRGBA>;
}

/** A 2D image plane. `assetRef` is resolved against an asset registry. */
export interface ImageNode extends SceneNodeBase<"image"> {
  assetRef: string;
}

/**
 * How a `VideoNode`'s source frame is chosen once the local (composition- or
 * clip-relative) frame has advanced past the end of its trimmed source
 * range. Only matters when the source is *shorter* than however long this
 * node is placed/visible for; if the source is longer, the trimmed range is
 * simply never fully consumed and neither behavior is ever triggered.
 *
 * - `'hold'`: freeze on the trimmed range's last source frame
 *   (`outFrame`, or the source's own last frame if `outFrame` is omitted)
 *   for every local frame at or past the point where the range is exhausted.
 *   The visual reads as the video pausing on its final frame.
 * - `'loop'`: wrap back around to the trimmed range's first source frame
 *   (`inFrame`, or `0` if omitted) and continue advancing from there,
 *   repeating the trimmed range indefinitely. The visual reads as the video
 *   restarting from its trim-in point.
 *
 * A third "freeze" option is deliberately not modeled as distinct from
 * `'hold'`: every plausible reading of "freeze" (stop advancing, keep
 * showing a still frame) is exactly `'hold'`'s behavior once the range is
 * exhausted, so introducing a second name for the same semantics would only
 * invite a caller to wonder what distinguishes them. `'hold'` is the two
 * genuinely distinct behaviors this type needs.
 */
export type VideoOutOfRangeBehavior = "hold" | "loop";

/**
 * How a `VideoNode`'s source video is fitted into the node's own
 * (transform-scaled) plane when the two aspect ratios differ, mirroring the
 * CSS `object-fit` keywords of the same names:
 *
 * - `'cover'`: scale the source to fill the plane entirely, cropping
 *   whichever axis overflows. No letterboxing/pillarboxing; some source
 *   content may be cut off at the edges.
 * - `'contain'`: scale the source to fit entirely within the plane,
 *   letterboxing/pillarboxing whichever axis has slack. No source content is
 *   ever cropped.
 * - `'fill'`: stretch the source to exactly match the plane's aspect ratio,
 *   distorting it if the two ratios differ.
 * - `'none'`: render the source at its native resolution, centered,
 *   neither scaled nor cropped to the plane.
 */
export type VideoFitMode = "cover" | "contain" | "fill" | "none";

/**
 * How a `VideoNode`'s pixels combine with whatever is already composited
 * beneath it, mirroring the CSS/Canvas/SVG blend-mode keywords of the same
 * names (a small, deliberately non-exhaustive subset: just the handful a
 * generated-shot-over-synthetic-layer composite realistically needs, not a
 * full blend-mode enum).
 *
 * - `'normal'`: ordinary alpha compositing (source over destination),
 *   i.e. no blending beyond `opacity`. The default.
 * - `'add'`: additive (linear dodge): channel-wise sum, brightening.
 * - `'multiply'`: channel-wise product, darkening (matches shadows/soft
 *   contact realistically).
 * - `'screen'`: inverse-multiply-of-inverses, brightening without the harsh
 *   clipping `'add'` produces.
 *
 * Phase 36 adds this as validated, round-trippable scene data only: see
 * `VideoNode.blendMode`'s own doc for why the actual GPU blend math is not
 * required to land in the same phase this field does.
 */
export type VideoBlendMode = "normal" | "add" | "multiply" | "screen";

/**
 * An external video file placed as a layer, with independent trim, speed,
 * and fit. `assetRef` is resolved against an asset registry (mirroring
 * `ImageNode.assetRef`); this package never loads or decodes the referenced
 * bytes itself. `assetRef` may also, before a referenced generation job has
 * finished, hold a `cadra-generation://<slotId>` placeholder ref instead of a
 * real `cadra-asset://<hash>` one (see `@cadra/mcp-server`'s
 * `generation-asset-binding.ts`): a caller resolving that scheme against a
 * `GenerationStore` and rewriting it to the real asset ref once the slot
 * reports `"ready"` is exactly how Phase 36's `add_generated_clip` binds a
 * generation job's eventual output onto this node, with no separate
 * out-of-band tracking table needed (the scheme is parsed straight out of
 * this one field).
 *
 * `inFrame`/`outFrame` are source-video-local frame numbers (not composition
 * frames), both inclusive: the trimmed range is
 * `[inFrame ?? 0, outFrame ?? <the source's last frame>]`, and both frames
 * are themselves shown, not just the frames strictly between them. Omitting
 * both plays the whole source. See `resolveVideoSourceFrame` for the exact
 * mapping from a clip-local frame to a source frame, including how
 * `playbackRate` and `outOfRangeBehavior` interact with this range.
 *
 * `opacity` is `Property<number>` (Phase 10's keyframe/property model,
 * following the precedent `CameraNode`'s `fov`/`near`/`far`/`target` and the
 * Phase 26 fields set on other node kinds), so it may be a plain constant or
 * animated over time, e.g. to fade a video layer in or out independent of
 * the containing `Clip`'s own `transitionIn`. Plain alpha compositing
 * against other layers via this field was Phase 33's whole "blend with
 * other layers" story; Phase 36 adds `blendMode` and `maskRef` alongside it
 * for a generated layer that needs to combine with a synthetic one by more
 * than plain alpha (e.g. an additive glow, or a masked cutout).
 *
 * `blendMode` and `maskRef` are deliberately modeled and validated here
 * (round-tripping through the scene DSL, so an agent can express and read
 * back "blend this generated shot additively, masked by this shape") without
 * requiring the renderer to already implement the corresponding GPU
 * blend/mask math: `packages/renderer`'s `"video"` node handling is still a
 * fixed-color placeholder plane (see this doc comment's own precedent, and
 * that module's `node-factory.ts`), so leaving these two fields as
 * validated-but-not-yet-rendered data is consistent with that existing scope
 * boundary, not a regression introduced by this phase.
 */
export interface VideoNode extends SceneNodeBase<"video"> {
  assetRef: string;
  /**
   * How this video layer's pixels combine with whatever renders beneath it.
   * Defaults to `'normal'` (plain alpha compositing, i.e. `opacity` alone),
   * matching every video layer authored before Phase 36 exactly.
   */
  blendMode?: VideoBlendMode;
  /**
   * Optional reference to a mask asset (resolved against the same kind of
   * asset registry `assetRef` is, by a later renderer phase) restricting
   * which pixels of this video layer are visible, e.g. a luminance or alpha
   * matte cutting a generated shot into a non-rectangular shape before it
   * composites with a synthetic layer beneath it. Omitted means no masking:
   * the whole (fit-mode-adjusted) rectangular plane is eligible to show,
   * exactly like every video layer authored before Phase 36.
   */
  maskRef?: string;
  /** Source-video-local frame the trimmed range starts at, inclusive. Defaults to `0`. */
  inFrame?: number;
  /** Source-video-local frame the trimmed range ends at, inclusive. Defaults to the source's own last frame. */
  outFrame?: number;
  /**
   * How fast the source advances relative to composition/clip time. `2`
   * means the source plays twice as fast, consuming its trimmed range in
   * half the local-frame duration it would at `1`. Must be positive.
   * Defaults to `1`.
   */
  playbackRate?: number;
  /**
   * How the source video is fitted into this node's plane when the two
   * aspect ratios differ. Defaults to `'cover'`: filling the frame with no
   * letterboxing is the most common expectation for a video placed as a
   * full layer (as opposed to `ImageNode`, which has no fit-mode concept at
   * all yet), and cropping a few edge pixels is rarely as visually jarring
   * as the letterboxing bars `'contain'` would introduce by default.
   */
  fitMode?: VideoFitMode;
  /**
   * What happens once the clip-local frame maps past the trimmed range's
   * natural end, i.e. the source is shorter than however long this node is
   * placed/visible for. Defaults to `'hold'`: freezing on the last frame is
   * the safer default (it never re-shows earlier content unexpectedly the
   * way `'loop'` would), matching how a plain HTML `<video>` behaves with
   * looping off.
   */
  outOfRangeBehavior?: VideoOutOfRangeBehavior;
  /**
   * Opacity this video layer is composited at, `0` (fully transparent) to
   * `1` (fully opaque). `Property<number>` so it may be keyframed
   * independent of the containing `Clip`'s own `transitionIn`. Defaults to
   * `1`.
   */
  opacity: Property<number>;
}

/**
 * A reference to another composition, embedded by id. Carries no content of
 * its own; a timeline resolver replaces it with the referenced composition's
 * resolved output.
 */
export interface CompositionRefNode extends SceneNodeBase<"compositionRef"> {
  compositionId: string;
}

/**
 * A node in the scene graph, discriminated on `kind`. Every variant is a
 * strict, closed shape: none of them carry a catch-all index signature, so
 * accessing a field not declared for the current `kind` is a compile error
 * rather than an easily-typo'd `unknown`.
 */
export type SceneNode =
  | GroupNode
  | MeshNode
  | CameraNode
  | LightNode
  | TextNode
  | ImageNode
  | VideoNode
  | CompositionRefNode;
