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
  "group" | "mesh" | "camera" | "light" | "text" | "image" | "compositionRef";

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
  GroupNode | MeshNode | CameraNode | LightNode | TextNode | ImageNode | CompositionRefNode;
