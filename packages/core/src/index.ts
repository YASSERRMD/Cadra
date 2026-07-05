/**
 * @cadra/core
 *
 * Scene graph, deterministic clock, timeline, primitives, and interpolation
 * for the Cadra 3D video animation framework.
 *
 * The scene graph data model (Project, Composition, Track, Clip, SceneNode),
 * its pure tree operations, the deterministic frame/time model (FrameContext,
 * seeded per-frame randomness, frame/time conversions), the authoring
 * primitives library (createComposition, Sequence, Series, Shape, Text,
 * Image, Camera, Light), and the timeline resolver (resolveSceneAtFrame) are
 * implemented; interpolation lands in a later phase.
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics until the
 * remaining framework APIs are implemented.
 */
export const PACKAGE_NAME = "@cadra/core";

export * from "./frame/index.js";
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
