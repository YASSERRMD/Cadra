import {
  type AssetKind,
  createComposition,
  createProject,
  Image,
  type Project,
  Sequence,
} from "@cadra/core";
import { describe, expect, it } from "vitest";

import { createVideoFrameReadyCheck } from "./create-video-frame-ready-check.js";
import { createVideoReadinessCache } from "./video-readiness.js";

const FPS = 30;
const DURATION_IN_FRAMES = 90;

function assetKindOf(assetRef: string): AssetKind | undefined {
  return assetRef === "video-asset" ? "video" : undefined;
}

function buildProject(): Project {
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
            content: Image({ id: "video-node", assetRef: "video-asset" }),
          }),
        ],
      },
    ],
  });
  return createProject({ id: "p1", name: "Project", compositions: [composition] });
}

describe("createVideoFrameReadyCheck", () => {
  it("reports not ready for a frame whose video content is not cached", () => {
    const project = buildProject();
    const cache = createVideoReadinessCache();
    const isFrameReady = createVideoFrameReadyCheck({
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
    });

    expect(isFrameReady(10)).toBe(false);
  });

  it("reports ready once the exact frame's video content is cached", () => {
    const project = buildProject();
    const cache = createVideoReadinessCache();
    cache.markReady("video-asset", 10);
    const isFrameReady = createVideoFrameReadyCheck({
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
    });

    expect(isFrameReady(10)).toBe(true);
  });

  it("checks a per-frame condition, not a global once-ready-always-ready flag", () => {
    const project = buildProject();
    const cache = createVideoReadinessCache();
    cache.markReady("video-asset", 10);
    const isFrameReady = createVideoFrameReadyCheck({
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
    });

    expect(isFrameReady(10)).toBe(true);
    expect(isFrameReady(11)).toBe(false);
  });

  it("is synchronous: returns a plain boolean, not a Promise", () => {
    const project = buildProject();
    const cache = createVideoReadinessCache();
    const isFrameReady = createVideoFrameReadyCheck({
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
    });

    const result = isFrameReady(0);
    expect(typeof result).toBe("boolean");
  });
});
