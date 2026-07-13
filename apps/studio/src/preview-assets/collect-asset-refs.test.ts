import type { AudioTrack, Composition } from "@cadra/core";
import {
  Camera,
  createComposition,
  createProject,
  Image,
  Model,
  Sequence,
  Video,
} from "@cadra/core";
import { describe, expect, it } from "vitest";

import { collectAssetRefs } from "./collect-asset-refs.js";

const FPS = 30;

function buildComposition(overrides: Partial<Composition> & { id: string }): Composition {
  return {
    ...createComposition({
      id: overrides.id,
      name: overrides.id,
      fps: FPS,
      durationInFrames: 10,
      width: 64,
      height: 64,
    }),
    ...overrides,
  };
}

describe("collectAssetRefs", () => {
  it("returns every set empty for a project with no asset-referencing nodes at all", () => {
    const composition = buildComposition({
      id: "comp-1",
      tracks: [
        { id: "track-1", clips: [Sequence({ id: "clip-1", from: 0, durationInFrames: 10, content: Camera({ id: "camera-1" }) })] },
      ],
    });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });

    const refs = collectAssetRefs(project);

    expect(refs.images.size).toBe(0);
    expect(refs.videos.size).toBe(0);
    expect(refs.models.size).toBe(0);
    expect(refs.environments.size).toBe(0);
    expect(refs.luts.size).toBe(0);
    expect(refs.audio.size).toBe(0);
  });

  it("collects ImageNode/VideoNode/ModelNode.assetRef from top-level clips", () => {
    const composition = buildComposition({
      id: "comp-1",
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({
              id: "clip-image",
              from: 0,
              durationInFrames: 10,
              content: Image({ id: "image-1", assetRef: "cadra-asset://image-hash" }),
            }),
            Sequence({
              id: "clip-video",
              from: 0,
              durationInFrames: 10,
              content: Video({ id: "video-1", assetRef: "cadra-asset://video-hash" }),
            }),
            Sequence({
              id: "clip-model",
              from: 0,
              durationInFrames: 10,
              content: Model({ id: "model-1", assetRef: "cadra-asset://model-hash" }),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });

    const refs = collectAssetRefs(project);

    expect(refs.images).toEqual(new Set(["cadra-asset://image-hash"]));
    expect(refs.videos).toEqual(new Set(["cadra-asset://video-hash"]));
    expect(refs.models).toEqual(new Set(["cadra-asset://model-hash"]));
  });

  it("recurses into nested children to find asset refs", () => {
    const nested = Image({
      id: "outer",
      assetRef: "cadra-asset://outer",
      children: [Video({ id: "inner-video", assetRef: "cadra-asset://inner-video" })],
    });
    const composition = buildComposition({
      id: "comp-1",
      tracks: [
        { id: "track-1", clips: [Sequence({ id: "clip-1", from: 0, durationInFrames: 10, content: nested })] },
      ],
    });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });

    const refs = collectAssetRefs(project);

    expect(refs.images).toEqual(new Set(["cadra-asset://outer"]));
    expect(refs.videos).toEqual(new Set(["cadra-asset://inner-video"]));
  });

  it("dedupes repeated assetRefs referenced by multiple nodes into one set entry", () => {
    const composition = buildComposition({
      id: "comp-1",
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({
              id: "clip-1",
              from: 0,
              durationInFrames: 5,
              content: Image({ id: "image-1", assetRef: "cadra-asset://shared" }),
            }),
            Sequence({
              id: "clip-2",
              from: 5,
              durationInFrames: 5,
              content: Image({ id: "image-2", assetRef: "cadra-asset://shared" }),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });

    const refs = collectAssetRefs(project);

    expect(refs.images.size).toBe(1);
  });

  it("collects environment.envMapRef and postProcessing lut effect refs", () => {
    const composition = buildComposition({
      id: "comp-1",
      tracks: [],
      environment: { envMapRef: "cadra-asset://env-hash" },
      postProcessing: {
        effects: [
          { type: "lut", lutRef: "cadra-asset://lut-hash", intensity: 1 },
          { type: "bloom", intensity: 0.5, threshold: 0.8, radius: 1 },
        ],
      },
    });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });

    const refs = collectAssetRefs(project);

    expect(refs.environments).toEqual(new Set(["cadra-asset://env-hash"]));
    expect(refs.luts).toEqual(new Set(["cadra-asset://lut-hash"]));
  });

  it("does not collect a built-in environment/lut ref (e.g. \"studio\") any differently - the caller's own registry fallback handles those, not this collector", () => {
    const composition = buildComposition({
      id: "comp-1",
      tracks: [],
      environment: { envMapRef: "studio" },
    });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });

    const refs = collectAssetRefs(project);

    expect(refs.environments).toEqual(new Set(["studio"]));
  });

  it("collects AudioClip.assetRef from audioTracks", () => {
    const audioTracks: AudioTrack[] = [
      { id: "audio-track-1", clips: [{ id: "audio-clip-1", startFrame: 0, durationInFrames: 10, assetRef: "cadra-asset://audio-hash" }] },
    ];
    const composition = buildComposition({ id: "comp-1", tracks: [], audioTracks });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });

    const refs = collectAssetRefs(project);

    expect(refs.audio).toEqual(new Set(["cadra-asset://audio-hash"]));
  });

  it("walks every composition in the project, not only the first", () => {
    const compositionA = buildComposition({
      id: "comp-a",
      tracks: [
        {
          id: "track-a",
          clips: [
            Sequence({
              id: "clip-a",
              from: 0,
              durationInFrames: 10,
              content: Image({ id: "image-a", assetRef: "cadra-asset://a" }),
            }),
          ],
        },
      ],
    });
    const compositionB = buildComposition({
      id: "comp-b",
      tracks: [
        {
          id: "track-b",
          clips: [
            Sequence({
              id: "clip-b",
              from: 0,
              durationInFrames: 10,
              content: Image({ id: "image-b", assetRef: "cadra-asset://b" }),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "P", compositions: [compositionA, compositionB] });

    const refs = collectAssetRefs(project);

    expect(refs.images).toEqual(new Set(["cadra-asset://a", "cadra-asset://b"]));
  });
});
