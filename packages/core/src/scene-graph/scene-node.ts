import type { EasingName } from "../interpolation/named-easing.js";
import type { Property } from "../keyframes/keyframe-track.js";
import type { LayerElement } from "./layer-element.js";
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
  "group" | "mesh" | "camera" | "light" | "text" | "image" | "video" | "compositionRef" | "satori";

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

/**
 * Which unit a `TextStaggerConfig` splits a `TextNode`'s own content into:
 * `"grapheme"` (one user-perceived character, e.g. a base letter plus its
 * combining marks, or a ZWJ emoji sequence, kept together even when
 * HarfBuzz shapes it as more than one cluster), `"character"` (one
 * HarfBuzz shaping cluster - coarser than a raw code point whenever
 * shaping fuses several into one, e.g. a ligature), `"word"` (a maximal
 * run of non-whitespace clusters), or `"line"` (one rendered line). See
 * `@cadra/text`'s `splitTextUnits`, the function that actually computes
 * these boundaries from shaped glyph data.
 */
export type TextStaggerGrouping = "grapheme" | "character" | "word" | "line";

/**
 * The order a `TextStaggerConfig`'s units start their own reveal in,
 * relative to each unit's own *reading*-order rank (never raw visual/array
 * order - see `TextUnit`'s own doc in `@cadra/text`): `"forward"` starts
 * with the first-read unit; `"backward"` starts with the last-read one;
 * `"centerOut"` starts with the unit(s) nearest the middle of the reading-
 * order sequence, rippling outward toward both ends.
 */
export type TextStaggerDirection = "forward" | "backward" | "centerOut";

/**
 * A starter kinetic-typography preset: `"typewriter"` (each unit snaps
 * from invisible to visible, no fade), `"fadeInUp"` (each unit fades in
 * while sliding up from `distance` below its own natural position),
 * `"lineReveal"` (each unit fades in in place, no positional offset), and
 * `"wave"` (every unit continuously bobs up and down, phase-shifted by its
 * own stagger rank, rather than settling into a final revealed state).
 */
export type TextStaggerPreset = "typewriter" | "fadeInUp" | "lineReveal" | "wave";

/**
 * Drives a deterministic, per-unit staggered animation across a
 * `TextNode`'s own content, split into `grouping`-sized units. Every field
 * here is a plain value, not a `Property<T>` keyframe track: a stagger is
 * one deterministic function of `frame` given these fixed parameters
 * (rank, delay, duration, easing), not itself something a caller keyframes
 * mid-animation - see `@cadra/core`'s `resolveTextStagger`.
 */
export interface TextStaggerConfig {
  preset: TextStaggerPreset;
  grouping: TextStaggerGrouping;
  /** The frame the very first unit (in stagger order) begins revealing at. */
  startFrame: number;
  /** Frames between each consecutive unit's own reveal start, in stagger order. */
  delayFrames: number;
  /** How many frames one unit's own reveal takes, once it starts. Ignored by `"wave"` (continuous, never settles). */
  durationFrames: number;
  /** Defaults to `"forward"`. */
  direction?: TextStaggerDirection;
  /** Defaults to `"linear"`. */
  easing?: EasingName;
  /** `"fadeInUp"` only: how far below its natural position a unit starts, in `fontSize`-relative em units. Defaults to `0.5`. */
  distance?: number;
  /** `"wave"` only: peak vertical offset, in `fontSize`-relative em units. Defaults to `0.1`. */
  amplitude?: number;
  /** `"wave"` only: frames per full oscillation. Defaults to `30`. */
  periodFrames?: number;
}

/**
 * Which per-glyph animation a `TextPhysicsConfig` drives: `"spring"` (a
 * mass-spring-damper entrance - position/scale/opacity settle into place,
 * physically, rather than following an algebraic easing curve, so
 * overshoot/bounce falls naturally out of the simulation), `"jitter"` (a
 * continuous, smoothly-noisy position/rotation wobble, never settling),
 * `"wave"` (a continuous sine-driven vertical bob, phase-shifted by each
 * unit's own rank - independent of, and composable with, `TextStaggerConfig`'s
 * own `"wave"` preset, which cannot run alongside a *different* stagger
 * preset the way this can), `"scramble"` (each unit shows a random
 * character from `charset` until it locks into its real content at its own
 * scheduled frame - a content effect, see `resolveScrambleText`, not a
 * transform), and `"countUp"` (the node's own content becomes a formatted
 * number animating from `fromValue` to `toValue` - also a content effect,
 * see `resolveCountUpText`).
 */
export type TextPhysicsEffect = "spring" | "jitter" | "wave" | "scramble" | "countUp";

/**
 * Drives expressive per-glyph animation on top of a `TextNode`'s own
 * layout positions (and, for `"spring"`/`"scramble"`, on top of whatever
 * `TextStaggerConfig` reveal is already happening - see `effect`'s own
 * doc). Every field is a plain value, not a `Property<T>` keyframe track,
 * for the same reason `TextStaggerConfig`'s own fields are: this is one
 * deterministic function of `frame` given fixed parameters, not itself
 * something a caller keyframes mid-animation.
 */
export interface TextPhysicsConfig {
  effect: TextPhysicsEffect;
  grouping: TextStaggerGrouping;
  /** Seeds this effect's own deterministic randomness (`"jitter"`'s noise, `"scramble"`'s character choices). Defaults to `0`. */
  seed?: number;

  /** `"spring"`/`"scramble"` only: the frame the very first unit (in rank order) begins animating at. Defaults to `0`. */
  startFrame?: number;
  /** `"spring"`/`"scramble"` only: frames between each consecutive unit's own start, in rank order. Defaults to `0` (every unit starts together). */
  delayFrames?: number;
  /** `"spring"`/`"scramble"`/`"countUp"` only: how many frames one unit's own animation takes, once it starts. Defaults to `30`. */
  durationFrames?: number;
  /** Defaults to `"forward"`. */
  direction?: TextStaggerDirection;

  /** `"spring"` only: the composition's own frame rate, needed to convert `frame` counts into physical time for the mass-spring-damper simulation. Defaults to `30`. */
  fps?: number;
  /** `"spring"` only. Defaults to `100`. */
  stiffness?: number;
  /** `"spring"` only. Defaults to `10`. */
  damping?: number;
  /** `"spring"` only. Defaults to `1`. */
  mass?: number;
  /** `"spring"` only: how far (in `fontSize`-relative em units) a unit starts offset from its natural position. Defaults to `1`. */
  distance?: number;

  /** `"jitter"`/`"wave"` only: peak offset, in `fontSize`-relative em units. Defaults to `0.05` for `"jitter"`, `0.1` for `"wave"`. */
  positionAmplitude?: number;
  /** `"jitter"` only: peak rotation around the glyph's own local Z axis, in radians. Defaults to `0` (no rotation jitter). */
  rotationAmplitude?: number;
  /** `"jitter"`'s own noise checkpoint spacing, or `"wave"`'s own oscillation period, in frames. Defaults to `20` for `"jitter"`, `30` for `"wave"`. */
  periodFrames?: number;

  /** `"scramble"` only: which characters a not-yet-locked-in unit is randomly drawn from. Defaults to uppercase Latin letters and digits. */
  charset?: string;

  /** `"countUp"` only: the value displayed at `frame <= startFrame`. Defaults to `0`. */
  fromValue?: number;
  /** `"countUp"` only: the value displayed at `frame >= startFrame + durationFrames`. Defaults to `0`. */
  toValue?: number;
  /** `"countUp"` only: fixed decimal places in the formatted number. Defaults to `0`. */
  decimalPlaces?: number;
  /** `"countUp"` only: whether to group digits with a thousands separator (always `,`, a fixed `"en-US"`-equivalent format regardless of runtime locale, so rendering a given frame never depends on the machine it runs on). Defaults to `false`. */
  useGrouping?: boolean;
  /** `"countUp"` only: eases the count's own progress. Defaults to `"linear"`. */
  easing?: EasingName;
}

/**
 * One segment of a `TextPathConfig`'s own curve, continuing from wherever
 * the previous segment (or `TextPathConfig.start`, for the first segment)
 * left off: `"line"` (a straight run to `to`), `"quadratic"` (one control
 * point), or `"cubic"` (two control points) - the same three primitives
 * SVG/Canvas path curves are built from. Every point is `Property<Vector3>`
 * (not a plain `Vector3`), so a path can deform over frames (Phase 52's own
 * task 2), exactly like `Transform.position` already can.
 */
export type TextPathSegment =
  | { type: "line"; to: Property<Vector3> }
  | { type: "quadratic"; control: Property<Vector3>; to: Property<Vector3> }
  | { type: "cubic"; control1: Property<Vector3>; control2: Property<Vector3>; to: Property<Vector3> };

/** Whether a `TextPathConfig`'s glyphs rotate to follow the curve's own tangent at each point (`"tangent"`, the typical "text on a curve" look) or stay upright, only translating (`"upright"`). */
export type TextPathOrientation = "upright" | "tangent";

/** How a `TextPathConfig` spaces glyphs along its own curve: `"advance"` preserves each glyph's own natural (per-font) advance width, so the text reads as if the original flat line were simply bent onto the curve; `"even"` distributes every unit at equal arc-length intervals regardless of its own width. */
export type TextPathSpacing = "advance" | "even";

/** Where a `TextPathConfig` anchors its own text along the curve's own extent: `"start"`/`"end"` flush the text's own first/last unit to the curve's own start/end, `"center"` centers it. */
export type TextPathAlignment = "start" | "center" | "end";

/**
 * Places a `TextNode`'s own glyphs along a 2D or 3D curve instead of a flat
 * line, with correct (per `spacing`) spacing and (per `orientation`)
 * orientation. `progress`/`startOffset` are independently animatable
 * `Property<number>`s (Phase 52's own task 2's "animating progress along
 * the path"), reusing the same keyframe system every other animatable
 * field in this codebase already does, rather than a bespoke timing model.
 */
export interface TextPathConfig {
  start: Property<Vector3>;
  segments: readonly TextPathSegment[];
  /** How much of the curve's own extent the text is mapped onto, from `startOffset`: `1` (the default) maps the text across the curve's full remaining length; less than `1` compresses it into a shorter leading portion (e.g. animating this from `0` to `1` reveals the text sliding fully onto the curve). */
  progress?: Property<number>;
  /** Where along the curve's own arc length (`0` to `1`) the text's own `alignment`-anchored point sits. Defaults to `0`. */
  startOffset?: Property<number>;
  /** Defaults to `"tangent"`. */
  orientation?: TextPathOrientation;
  /** Defaults to `"advance"`. */
  spacing?: TextPathSpacing;
  /** Defaults to `"start"`. */
  alignment?: TextPathAlignment;
}

/**
 * Crossfade-morphs a `TextNode`'s own rendered content from `from` to its
 * real `content`, matching `grouping`-sized units by their own reading-
 * order index (Phase 50's own `TextUnit.index`): a matched pair
 * interpolates position from its `from` unit's own natural position to its
 * `content` unit's own, with `from` fading out and `content` fading in
 * simultaneously (not a true vertex-level outline morph - see
 * `@cadra/text`'s `resolveGlyphMorphStates` for exactly why). A unit index
 * present in only one of the two texts (`from`/`content` of different
 * lengths) simply fades in or out in place at its own natural position,
 * with nothing to interpolate toward - Phase 52's own task 4's "handle
 * counts that differ ... gracefully".
 */
export interface TextMorphConfig {
  from: string;
  grouping: TextStaggerGrouping;
  /** `0` shows `from` exactly as laid out; `1` shows `content` exactly as laid out. */
  progress: Property<number>;
}

/** A block of rendered text. */
export interface TextNode extends SceneNodeBase<"text"> {
  content: string;
  /** Id of a registered font asset. Omitted means the renderer's default. */
  fontRef?: string;
  fontSize: Property<number>;
  color: Property<ColorRGBA>;
  /**
   * How far to extrude each glyph along its own local Z axis, in the same
   * units as `fontSize`. Omitted or `0` renders flat MSDF-textured glyph
   * quads (crisp at any scale, the default); a positive value instead
   * builds real solid 3D glyph geometry from the font's own outlines, lit
   * and shadowed like any other mesh.
   */
  extrudeDepth?: Property<number>;
  /** A deterministic per-unit staggered reveal animation across this node's own content. Omitted means no staggering: every glyph renders exactly as laid out, unaffected. */
  stagger?: TextStaggerConfig;
  /** Expressive per-glyph animation (springs, jitter, wave, scramble, count-up), composable with `stagger`. Omitted means no physics effect. */
  physics?: TextPhysicsConfig;
  /** Places this node's own glyphs along a curve instead of a flat line. Omitted means a normal flat layout. */
  path?: TextPathConfig;
  /** Crossfade-morphs this node's own content from another string. Omitted means no morphing: `content` renders as-is. */
  morph?: TextMorphConfig;
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
 * How a `SatoriNode`'s pixels combine with whatever is already composited
 * beneath it. An alias, not a fresh type: identical semantics to
 * `VideoNode.blendMode` (see its own doc for what each mode means), and
 * having only one definition of "normal/add/multiply/screen" avoids two
 * copies silently drifting apart if a mode is ever added to one but not
 * the other.
 */
export type SatoriBlendMode = VideoBlendMode;

/**
 * One font a `SatoriNode.layer`'s own styles can select via CSS
 * `fontFamily` (matched against `family`) plus `fontWeight`/`fontStyle`
 * (matched against `weight`/`style`, both defaulting to `400`/`"normal"`,
 * same as real CSS) - the scene-graph-side counterpart of
 * `@cadra/satori-layer`'s own `SatoriLayerFont`, minus the resolved font
 * bytes themselves: `fontRef` is resolved against the same font registry
 * `TextNode.fontRef` already is (Phase 41), by the renderer, not by this
 * package.
 */
export interface SatoriLayerFontRef {
  family: string;
  fontRef: string;
  weight?: number;
  style?: "normal" | "italic";
  /** Explicit variation coordinates for this font (e.g. `{ wght: 700 }`). Axes not mentioned default to the font's own declared default. */
  variationCoordinates?: Readonly<Record<string, number>>;
}

/**
 * Per-frame animatable overrides for one element within a `SatoriNode`'s
 * own `layer` tree, keyed by that element's own `LayerElement.id` (see
 * `SatoriNode.elementAnimations`). Deliberately a small, fixed set of
 * animatable aspects (Phase 48's own "position, opacity, style" scope)
 * rather than a fully generic per-property style animation system: `x`/`y`
 * become a CSS `transform: translate(...)` on top of whatever the
 * element's own authored `style.transform` already is, `opacity` and
 * `color` merge onto the element's own `style.opacity`/`style.color`,
 * overriding it for whichever frame this resolves to a value at.
 */
export interface SatoriElementKeyframes {
  opacity?: Property<number>;
  /** Horizontal translation, in the same layer units as the element's own layout, added on top of its natural flex-resolved position. */
  x?: Property<number>;
  /** Vertical translation, in the same layer units as the element's own layout, added on top of its natural flex-resolved position. */
  y?: Property<number>;
  color?: Property<ColorRGBA>;
}

/**
 * A Satori-rendered 2D layer (Phase 46-47's HTML/CSS-to-SVG-to-RGBA
 * pipeline) placed into the scene as a textured plane, brought onto the
 * timeline as an animatable node like any other.
 *
 * `layer` is this node's own inline content (like `TextNode.content`, not a
 * ref to something authored elsewhere): the whole point of a scene-graph-
 * native rich 2D layer is that an agent authors its element tree directly
 * as part of the scene.
 *
 * `width`/`height` are the layer's own fixed rendering resolution, in
 * layer units (matching what Satori lays out and resvg rasterizes at) -
 * deliberately plain numbers, not `Property<number>`, since changing them
 * requires a full re-render (new layout, new rasterization), unlike
 * `transform.scale`, which resizes the already-rasterized result for free
 * exactly like an `ImageNode`'s already-decoded bitmap does. Animate the
 * displayed size via `transform.scale`, not by keyframing `width`/`height`.
 *
 * `opacity` mirrors `VideoNode.opacity` exactly: a `Property<number>`
 * multiplier applied at the material level, independent of any `opacity`
 * authored inside `layer`'s own styles (that is baked into the rasterized
 * pixels themselves and never changes without a re-render; this field is
 * cheap to animate per frame since it never triggers one).
 */
export interface SatoriNode extends SceneNodeBase<"satori"> {
  layer: LayerElement;
  width: number;
  height: number;
  opacity: Property<number>;
  /** Defaults to `'normal'` (plain alpha compositing, i.e. `opacity` alone). */
  blendMode?: SatoriBlendMode;
  /** Every font `layer`'s own styles reference by `fontFamily`. Omitted or empty is only valid when `layer` contains no text. */
  fonts?: readonly SatoriLayerFontRef[];
  /**
   * Per-frame animatable overrides for individual elements within `layer`,
   * keyed by each target element's own `LayerElement.id`. An id with no
   * matching element in `layer` (e.g. after the tree is edited but this map
   * is not updated) is simply never applied - not an error, since which
   * elements exist and which are animated are edited independently and can
   * transiently disagree.
   */
  elementAnimations?: Readonly<Record<string, SatoriElementKeyframes>>;
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
  | CompositionRefNode
  | SatoriNode;
