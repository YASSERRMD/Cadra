/**
 * @cadra/core
 *
 * Scene graph, deterministic clock, timeline, primitives, interpolation, and
 * keyframes for the Cadra 3D video animation framework.
 *
 * The scene graph data model (Project, Composition, Track, Clip, SceneNode),
 * its pure tree operations, the deterministic frame/time model (FrameContext,
 * seeded per-frame randomness, frame/time conversions), the authoring
 * primitives library (createComposition, Sequence, Series, Shape, Text,
 * Image, Camera, Light), the timeline resolver (resolveSceneAtFrame), the
 * deterministic interpolation toolkit (interpolate, spring, easing curves,
 * cubicBezier), the declarative keyframe/property model (Property,
 * KeyframeTrack, resolveProperty), the environment-agnostic asset pipeline
 * primitives (content hashing, AssetRegistry, waitForAssets), and the audio
 * timeline model (AudioClip, AudioTrack, computeGainAtLocalFrame,
 * resolveAudioMixdown) are implemented.
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics until the
 * remaining framework APIs are implemented.
 */
export const PACKAGE_NAME = "@cadra/core";

export * from "./assets/index.js";
export * from "./audio/index.js";
export * from "./frame/index.js";
export * from "./interpolation/index.js";
export * from "./keyframes/index.js";
// Not a plain `export *`: `./scene-graph/index.js` already exports the
// `Composition` data-shape type, so the primitives barrel's own factory
// function is named `createComposition` (see `composition.ts`) to keep both
// importable side by side from this single entry point.
export type {
  CameraProps,
  CompositionProps,
  ImageProps,
  LightProps,
  SequenceFrameResolution,
  SequenceProps,
  SequenceWindow,
  SeriesEntry,
  ShapeProps,
  TextProps,
} from "./primitives/index.js";
export {
  Camera,
  CAMERA_ANIMATABLE_PROPERTIES,
  createComposition,
  deriveSequenceRootId,
  Image,
  IMAGE_ANIMATABLE_PROPERTIES,
  Light,
  LIGHT_ANIMATABLE_PROPERTIES,
  resolveSequenceFrame,
  Sequence,
  Series,
  Shape,
  SHAPE_ANIMATABLE_PROPERTIES,
  Text,
  TEXT_ANIMATABLE_PROPERTIES,
} from "./primitives/index.js";
export * from "./scene-graph/index.js";
export * from "./timeline-engine/index.js";
