import {
  createComposition,
  createProject,
  type Project,
  type SceneNode,
  type SceneState,
  Sequence,
  Video,
} from "@cadra/core";
import { renderComposition } from "@cadra/headless";
import type {
  VideoGenerationJob,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoProvider,
} from "@cadra/providers";
import { createGenerationStore } from "@cadra/providers";
import type { PixelBuffer, PixelReadableRenderer } from "@cadra/renderer";
import { describe, expect, it, vi } from "vitest";

import { buildGenerationRef } from "./generation-asset-binding.js";
import { createGenerationPendingAssets } from "./generation-pending-assets.js";

/** A minimal, fully injectable fake `VideoProvider`: no real network call, ever, matching every other test in this codebase touching `@cadra/providers`. */
function createFakeProvider(name: string): {
  provider: VideoProvider;
  setNextStatus: (externalJobId: string, status: VideoGenerationStatus) => void;
} {
  const statusByJobId = new Map<string, VideoGenerationStatus>();
  let counter = 0;

  const provider: VideoProvider = {
    name,
    submit: vi.fn(async (_request: VideoGenerationRequest): Promise<VideoGenerationJob> => {
      counter += 1;
      const externalJobId = `${name}-job-${counter}`;
      statusByJobId.set(externalJobId, { status: "pending" });
      return { provider: name, externalJobId };
    }),
    poll: vi.fn(async (job: VideoGenerationJob): Promise<VideoGenerationStatus> => {
      return statusByJobId.get(job.externalJobId) ?? { status: "pending" };
    }),
  };

  return {
    provider,
    setNextStatus: (externalJobId, status) => statusByJobId.set(externalJobId, status),
  };
}

const BASE_REQUEST: VideoGenerationRequest = {
  prompt: "A lighthouse beam sweeping across a stormy sea.",
  params: { durationSeconds: 5 },
};

const FPS = 30;
const DURATION_IN_FRAMES = 5;

/** A minimal `SceneState` with one layer whose node is `node`, at frame 0. */
function sceneStateWithNode(node: SceneNode): SceneState {
  return {
    compositionId: "comp-1",
    frame: 0,
    width: 64,
    height: 36,
    layers: [
      {
        compositionId: "comp-1",
        trackId: "track-1",
        clipId: "clip-1",
        node,
        zIndex: 0,
        localFrame: 0,
        opacity: 1,
      },
    ],
  };
}

/** A one-composition project whose single clip's node is a VideoNode with `assetRef`. */
function buildProjectWithVideoAssetRef(assetRef: string): Project {
  const video = Video({ id: "video-1", assetRef });
  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: 64,
    height: 36,
    tracks: [
      {
        id: "track-1",
        clips: [
          Sequence({ id: "clip-1", from: 0, durationInFrames: DURATION_IN_FRAMES, content: video }),
        ],
      },
    ],
  });
  return createProject({ id: "p1", name: "Project", compositions: [composition] });
}

/** A single-pixel fully-opaque black `PixelBuffer`. */
function makePixels(): PixelBuffer {
  return { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) };
}

/** A fake `PixelReadableRenderer` touching no GPU, mirroring `@cadra/headless`'s own `render-composition.test.ts` fixture. */
function createFakePixelReadableRenderer(): PixelReadableRenderer {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    renderFrame: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    readPixels: vi.fn(async () => makePixels()),
    backend: "webgl2",
    capabilities: { backend: "webgl2", isFallback: true, maxTextureSize: 4096 },
  };
}

describe("createGenerationPendingAssets", () => {
  it("contributes no Pending for a frame with no generation-backed nodes", async () => {
    const store = createGenerationStore({ providers: {} });
    const getPendingAssets = createGenerationPendingAssets(store);

    const sceneState = sceneStateWithNode(
      Video({ id: "video-1", assetRef: "cadra-asset://already-real" }),
    );
    const pending = Array.from(getPendingAssets(0, sceneState));

    expect(pending).toEqual([]);
  });

  it("rejects when the referenced slot is still pending, without hanging", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);
    const getPendingAssets = createGenerationPendingAssets(store);

    const sceneState = sceneStateWithNode(
      Video({ id: "video-1", assetRef: buildGenerationRef("hero-clip") }),
    );
    const [pending] = Array.from(getPendingAssets(0, sceneState));

    await expect(pending!.ready).rejects.toThrow(/not ready yet/);
  });

  it("rejects with the vendor's own error when the referenced slot has failed", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);
    fake.setNextStatus("veo-job-1", { status: "failed", error: "vendor rejected the prompt" });
    const getPendingAssets = createGenerationPendingAssets(store);

    const sceneState = sceneStateWithNode(
      Video({ id: "video-1", assetRef: buildGenerationRef("hero-clip") }),
    );
    const [pending] = Array.from(getPendingAssets(0, sceneState));

    await expect(pending!.ready).rejects.toThrow(/vendor rejected the prompt/);
  });

  it("resolves once the referenced slot is ready", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);
    fake.setNextStatus("veo-job-1", {
      status: "succeeded",
      outputUrl: "https://vendor.example/hero.mp4",
    });
    const getPendingAssets = createGenerationPendingAssets(store);

    const sceneState = sceneStateWithNode(
      Video({ id: "video-1", assetRef: buildGenerationRef("hero-clip") }),
    );
    const [pending] = Array.from(getPendingAssets(0, sceneState));

    await expect(pending!.ready).resolves.toBeUndefined();
  });

  it("finds a generation-backed VideoNode nested under a group layer node", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);
    const getPendingAssets = createGenerationPendingAssets(store);

    const sceneState = sceneStateWithNode({
      id: "group-1",
      kind: "group",
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      children: [Video({ id: "video-1", assetRef: buildGenerationRef("hero-clip") })],
    });
    const pending = Array.from(getPendingAssets(0, sceneState));

    expect(pending).toHaveLength(1);
    await expect(pending[0]!.ready).rejects.toThrow(/not ready yet/);
  });

  it("does not call refresh again for a slot already observed ready by an earlier frame", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);
    fake.setNextStatus("veo-job-1", {
      status: "succeeded",
      outputUrl: "https://vendor.example/hero.mp4",
    });
    const refreshSpy = vi.spyOn(store, "refresh");
    const getPendingAssets = createGenerationPendingAssets(store);
    const sceneState = sceneStateWithNode(
      Video({ id: "video-1", assetRef: buildGenerationRef("hero-clip") }),
    );

    const [firstFramePending] = Array.from(getPendingAssets(0, sceneState));
    await firstFramePending!.ready;
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    const [secondFramePending] = Array.from(getPendingAssets(1, sceneState));
    await secondFramePending!.ready;
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  describe("integration with renderComposition", () => {
    it("gates a whole render on a still-pending generation slot, rejecting rather than proceeding", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });
      await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);

      const project = buildProjectWithVideoAssetRef(buildGenerationRef("hero-clip"));
      const renderer = createFakePixelReadableRenderer();

      const frames: number[] = [];
      const iterate = async () => {
        for await (const frame of renderComposition({
          project,
          compositionId: "comp-1",
          renderer,
          seed: "seed-1",
          getPendingAssets: createGenerationPendingAssets(store),
        })) {
          frames.push(frame.frame);
        }
      };

      await expect(iterate()).rejects.toThrow(/not ready yet/);
      expect(frames).toEqual([]);
      expect(renderer.renderFrame).not.toHaveBeenCalled();
    });

    it("renders every frame once the generation slot backing its VideoNode is ready", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });
      await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);
      fake.setNextStatus("veo-job-1", {
        status: "succeeded",
        outputUrl: "https://vendor.example/hero.mp4",
      });

      const project = buildProjectWithVideoAssetRef(buildGenerationRef("hero-clip"));
      const renderer = createFakePixelReadableRenderer();

      const frames: number[] = [];
      for await (const frame of renderComposition({
        project,
        compositionId: "comp-1",
        renderer,
        seed: "seed-1",
        getPendingAssets: createGenerationPendingAssets(store),
      })) {
        frames.push(frame.frame);
      }

      expect(frames).toEqual([0, 1, 2, 3, 4]);
      expect(renderer.renderFrame).toHaveBeenCalledTimes(DURATION_IN_FRAMES);
    });

    it("renders normally (no gating at all) for a scene with only real, non-generation asset refs", async () => {
      const project = buildProjectWithVideoAssetRef("cadra-asset://already-real");
      const renderer = createFakePixelReadableRenderer();
      const store = createGenerationStore({ providers: {} });

      const frames: number[] = [];
      for await (const frame of renderComposition({
        project,
        compositionId: "comp-1",
        renderer,
        seed: "seed-1",
        getPendingAssets: createGenerationPendingAssets(store),
      })) {
        frames.push(frame.frame);
      }

      expect(frames).toEqual([0, 1, 2, 3, 4]);
    });
  });
});
