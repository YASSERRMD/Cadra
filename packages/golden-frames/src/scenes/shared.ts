import {
  type Composition,
  createComposition,
  createProject,
  type Project,
  type SceneNode,
  Sequence,
} from "@cadra/core";

/** Options accepted by `buildSingleTrackProject`. */
export interface BuildSingleTrackProjectOptions {
  projectId: string;
  compositionId: string;
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
  /** Every node this scene needs, as siblings under one clip (`Sequence` accepts an array `content`; see its own doc). */
  nodes: SceneNode[];
  /** Id of the `CameraNode` among `nodes` that should be active for the whole composition. */
  activeCameraNodeId: string;
}

/**
 * Builds a `Project` with exactly one composition, one track, and one clip
 * spanning `[0, durationInFrames)` holding every one of `options.nodes` as
 * siblings, with `options.activeCameraNodeId` wired up as the active camera
 * for the whole duration.
 *
 * Every curated golden scene in this package is a single, static
 * arrangement of nodes (a camera, some lights, some shapes/text), not a
 * multi-shot composition, so one shared track (rather than the
 * one-track-per-node-kind pattern `@cadra/encode`'s own e2e scenes use,
 * which exists there specifically to let later helpers swap out one track
 * by id) is both sufficient and simpler.
 */
export function buildSingleTrackProject(options: BuildSingleTrackProjectOptions): Project {
  const composition = createComposition({
    id: options.compositionId,
    name: "Main",
    fps: options.fps,
    durationInFrames: options.durationInFrames,
    width: options.width,
    height: options.height,
    tracks: [
      {
        id: "track-main",
        clips: [
          Sequence({
            id: "clip-main",
            from: 0,
            durationInFrames: options.durationInFrames,
            content: options.nodes,
          }),
        ],
      },
    ],
  });

  const withActiveCameraTrack: Composition = {
    ...composition,
    activeCameraTrack: [
      {
        startFrame: 0,
        durationInFrames: options.durationInFrames,
        cameraNodeId: options.activeCameraNodeId,
      },
    ],
  };

  return createProject({
    id: options.projectId,
    name: "Golden Frame Project",
    compositions: [withActiveCameraTrack],
  });
}
