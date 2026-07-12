import {
  type AssetKind,
  createComposition,
  createProject,
  Image,
  resolveSceneAtFrame,
  resolveVideoSourceFrame,
  Sequence,
  Shape,
  Video,
} from "@cadra/core";
import { describe, expect, it } from "vitest";

import {
  createVideoReadinessCache,
  findVideoBackedFrames,
  isSceneStateVideoReady,
} from "./video-readiness.js";

const FPS = 30;
const DURATION_IN_FRAMES = 90;

/** A fixed `assetKindOf`: "video-asset" is a video, "image-asset" is a static image, anything else is unknown. */
function assetKindOf(assetRef: string): AssetKind | undefined {
  if (assetRef === "video-asset") return "video";
  if (assetRef === "image-asset") return "image";
  return undefined;
}

describe("findVideoBackedFrames", () => {
  it("finds a video-backed image node at the layer's own localFrame", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: FPS,
      durationInFrames: DURATION_IN_FRAMES,
      width: 640,
      height: 360,
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({
              id: "clip-1",
              from: 10,
              durationInFrames: 50,
              content: Image({ id: "video-node", assetRef: "video-asset" }),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "Project", compositions: [composition] });

    const sceneState = resolveSceneAtFrame(project, "comp-1", 15);
    const found = findVideoBackedFrames(sceneState, assetKindOf);

    // Clip starts at frame 10, resolved at frame 15: localFrame is 5.
    expect(found).toEqual([{ assetRef: "video-asset", frame: 5 }]);
  });

  it("ignores an image node whose assetRef is a static image, not a video", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: FPS,
      durationInFrames: DURATION_IN_FRAMES,
      width: 640,
      height: 360,
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({
              id: "clip-1",
              from: 0,
              durationInFrames: DURATION_IN_FRAMES,
              content: Image({ id: "image-node", assetRef: "image-asset" }),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "Project", compositions: [composition] });

    const sceneState = resolveSceneAtFrame(project, "comp-1", 0);
    expect(findVideoBackedFrames(sceneState, assetKindOf)).toEqual([]);
  });

  it("ignores non-image node kinds entirely, e.g. a mesh", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: FPS,
      durationInFrames: DURATION_IN_FRAMES,
      width: 640,
      height: 360,
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({
              id: "clip-1",
              from: 0,
              durationInFrames: DURATION_IN_FRAMES,
              content: Shape({ id: "shape-1" }),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "Project", compositions: [composition] });

    const sceneState = resolveSceneAtFrame(project, "comp-1", 0);
    expect(findVideoBackedFrames(sceneState, assetKindOf)).toEqual([]);
  });

  it("finds a video-backed node nested as a child of a layer's root node", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: FPS,
      durationInFrames: DURATION_IN_FRAMES,
      width: 640,
      height: 360,
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({
              id: "clip-1",
              from: 0,
              durationInFrames: DURATION_IN_FRAMES,
              // A group root with a video-backed child: exercises the "a
              // layer's node can itself have children" case (ResolvedLayer.node's
              // own doc), not just a video node used directly as clip content.
              content: [Image({ id: "child-video", assetRef: "video-asset" })],
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "Project", compositions: [composition] });

    const sceneState = resolveSceneAtFrame(project, "comp-1", 20);
    expect(findVideoBackedFrames(sceneState, assetKindOf)).toEqual([
      { assetRef: "video-asset", frame: 20 },
    ]);
  });

  it("collects one entry per video-backed node across multiple layers", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: FPS,
      durationInFrames: DURATION_IN_FRAMES,
      width: 640,
      height: 360,
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({
              id: "clip-a",
              from: 0,
              durationInFrames: DURATION_IN_FRAMES,
              content: Image({ id: "video-a", assetRef: "video-asset" }),
            }),
          ],
        },
        {
          id: "track-2",
          clips: [
            Sequence({
              id: "clip-b",
              from: 5,
              durationInFrames: DURATION_IN_FRAMES,
              content: Image({ id: "video-b", assetRef: "video-asset" }),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "Project", compositions: [composition] });

    const sceneState = resolveSceneAtFrame(project, "comp-1", 10);
    const found = findVideoBackedFrames(sceneState, assetKindOf);

    expect(found).toEqual([
      { assetRef: "video-asset", frame: 10 }, // clip-a: starts at 0, localFrame 10
      { assetRef: "video-asset", frame: 5 }, // clip-b: starts at 5, localFrame 5
    ]);
  });

  it("finds a real VideoNode at its own resolved source frame - the composition-absolute frame, not the layer's own localFrame", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: FPS,
      durationInFrames: DURATION_IN_FRAMES,
      width: 640,
      height: 360,
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({
              id: "clip-1",
              from: 10,
              durationInFrames: 50,
              content: Video({ id: "video-node", assetRef: "video-asset" }),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "Project", compositions: [composition] });

    const sceneState = resolveSceneAtFrame(project, "comp-1", 15);
    const found = findVideoBackedFrames(sceneState, assetKindOf);

    // Clip starts at frame 10, resolved at frame 15: localFrame is 5, but a
    // VideoNode's own default mapping (inFrame 0, playbackRate 1, no trim)
    // resolves against the composition-absolute frame (15), matching
    // exactly what the real renderer's own computeVideoFrameRenderKey
    // would compute (see collectVideoBackedNodes's own doc) - not 5.
    expect(found).toEqual([{ assetRef: "video-asset", frame: 15 }]);
  });

  it("resolves a VideoNode's own inFrame/outFrame/playbackRate exactly like resolveVideoSourceFrame does", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: FPS,
      durationInFrames: DURATION_IN_FRAMES,
      width: 640,
      height: 360,
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({
              id: "clip-1",
              from: 0,
              durationInFrames: DURATION_IN_FRAMES,
              content: Video({
                id: "video-node",
                assetRef: "video-asset",
                inFrame: 100,
                outFrame: 200,
                playbackRate: 2,
              }),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "Project", compositions: [composition] });

    const sceneState = resolveSceneAtFrame(project, "comp-1", 20);
    const found = findVideoBackedFrames(sceneState, assetKindOf);

    const expectedSourceFrame = resolveVideoSourceFrame(
      { inFrame: 100, outFrame: 200, playbackRate: 2 },
      20,
    );
    expect(found).toEqual([{ assetRef: "video-asset", frame: expectedSourceFrame }]);
  });

  it("VideoNode's own assetRef needs no assetKindOf lookup at all - unlike an ImageNode, its node kind alone already means video", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: FPS,
      durationInFrames: DURATION_IN_FRAMES,
      width: 640,
      height: 360,
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({
              id: "clip-1",
              from: 0,
              durationInFrames: DURATION_IN_FRAMES,
              content: Video({ id: "video-node", assetRef: "unregistered-asset" }),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "Project", compositions: [composition] });

    // assetKindOf here reports "unregistered-asset" as unknown (undefined),
    // exactly what a real host would report for an asset it has never
    // heard of - yet the VideoNode is still found, since its own node kind
    // is sufficient, with no assetKindOf lookup needed.
    const sceneState = resolveSceneAtFrame(project, "comp-1", 0);
    const found = findVideoBackedFrames(sceneState, () => undefined);
    expect(found).toEqual([{ assetRef: "unregistered-asset", frame: 0 }]);
  });

  it("finds both a real VideoNode and a legacy video-backed ImageNode in the same scene, each keyed by its own correct frame", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: FPS,
      durationInFrames: DURATION_IN_FRAMES,
      width: 640,
      height: 360,
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({
              id: "clip-video-node",
              from: 10,
              durationInFrames: 50,
              content: Video({ id: "video-node", assetRef: "video-asset" }),
            }),
          ],
        },
        {
          id: "track-2",
          clips: [
            Sequence({
              id: "clip-legacy-image",
              from: 5,
              durationInFrames: DURATION_IN_FRAMES,
              content: Image({ id: "legacy-video-image", assetRef: "video-asset" }),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "Project", compositions: [composition] });

    const sceneState = resolveSceneAtFrame(project, "comp-1", 15);
    const found = findVideoBackedFrames(sceneState, assetKindOf);

    expect(found).toEqual([
      { assetRef: "video-asset", frame: 15 }, // VideoNode: composition-absolute frame
      { assetRef: "video-asset", frame: 10 }, // legacy ImageNode: localFrame (15 - 5)
    ]);
  });
});

describe("VideoReadinessCache", () => {
  it("reports not-ready for a pair that was never marked", () => {
    const cache = createVideoReadinessCache();
    expect(cache.isReady("video-asset", 3)).toBe(false);
  });

  it("reports ready only for the exact (assetRef, frame) pair marked", () => {
    const cache = createVideoReadinessCache();
    cache.markReady("video-asset", 3);

    expect(cache.isReady("video-asset", 3)).toBe(true);
    expect(cache.isReady("video-asset", 4)).toBe(false);
    expect(cache.isReady("other-asset", 3)).toBe(false);
  });
});

describe("isSceneStateVideoReady", () => {
  function buildProjectWithVideoAt(startFrame: number): ReturnType<typeof createProject> {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: FPS,
      durationInFrames: DURATION_IN_FRAMES,
      width: 640,
      height: 360,
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({
              id: "clip-1",
              from: startFrame,
              durationInFrames: DURATION_IN_FRAMES - startFrame,
              content: Image({ id: "video-node", assetRef: "video-asset" }),
            }),
          ],
        },
      ],
    });
    return createProject({ id: "p1", name: "Project", compositions: [composition] });
  }

  it("is vacuously ready for a scene with no video-backed content at all", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: FPS,
      durationInFrames: DURATION_IN_FRAMES,
      width: 640,
      height: 360,
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({
              id: "clip-1",
              from: 0,
              durationInFrames: DURATION_IN_FRAMES,
              content: Shape({ id: "shape-1" }),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "Project", compositions: [composition] });
    const cache = createVideoReadinessCache();

    const sceneState = resolveSceneAtFrame(project, "comp-1", 0);
    expect(isSceneStateVideoReady(sceneState, cache, assetKindOf)).toBe(true);
  });

  it("is not ready when the video-backed node's exact frame is not cached", () => {
    const project = buildProjectWithVideoAt(0);
    const cache = createVideoReadinessCache();

    const sceneState = resolveSceneAtFrame(project, "comp-1", 7);
    expect(isSceneStateVideoReady(sceneState, cache, assetKindOf)).toBe(false);
  });

  it("is ready once the exact (assetRef, localFrame) pair is marked", () => {
    const project = buildProjectWithVideoAt(0);
    const cache = createVideoReadinessCache();
    cache.markReady("video-asset", 7);

    const sceneState = resolveSceneAtFrame(project, "comp-1", 7);
    expect(isSceneStateVideoReady(sceneState, cache, assetKindOf)).toBe(true);
  });

  it("is not ready if only a neighboring frame is cached, not the exact one needed", () => {
    const project = buildProjectWithVideoAt(0);
    const cache = createVideoReadinessCache();
    cache.markReady("video-asset", 6);
    cache.markReady("video-asset", 8);

    const sceneState = resolveSceneAtFrame(project, "comp-1", 7);
    expect(isSceneStateVideoReady(sceneState, cache, assetKindOf)).toBe(false);
  });
});
