/**
 * @cadra/core
 *
 * Scene graph, deterministic clock, timeline, primitives, and interpolation
 * for the Cadra 3D video animation framework.
 *
 * The scene graph data model (Project, Composition, Track, Clip, SceneNode),
 * its pure tree operations, and the deterministic frame/time model
 * (FrameContext, seeded per-frame randomness, frame/time conversions) are
 * implemented; the timeline resolver and interpolation land in later phases.
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics until the
 * remaining framework APIs are implemented.
 */
export const PACKAGE_NAME = "@cadra/core";

export * from "./frame/index.js";
export * from "./scene-graph/index.js";
