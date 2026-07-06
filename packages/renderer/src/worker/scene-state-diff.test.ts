import { createIdentityTransform, type ResolvedLayer, type SceneState } from "@cadra/core";
import { describe, expect, it } from "vitest";

import {
  createSceneStateDiffTracker,
  createWorkerLayerCache,
  diffSceneStateLayers,
  reconstructSceneState,
  UnknownUnchangedLayerError,
} from "./scene-state-diff.js";
import { isUnchangedLayerRef } from "./worker-protocol.js";

/** A single full `ResolvedLayer`, defaulting to opaque/frame-0/zIndex matching its position. */
function layer(
  compositionId: string,
  trackId: string,
  clipId: string,
  overrides: Partial<ResolvedLayer> = {},
): ResolvedLayer {
  return {
    compositionId,
    trackId,
    clipId,
    node: {
      id: `${trackId}-${clipId}-node`,
      kind: "group",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
    },
    zIndex: 0,
    localFrame: 0,
    opacity: 1,
    ...overrides,
  };
}

function sceneState(layers: ResolvedLayer[], frame = 0): SceneState {
  return { compositionId: "comp-1", frame, width: 1920, height: 1080, layers };
}

describe("diffSceneStateLayers", () => {
  it("sends every layer in full on the first call (nothing cached yet)", () => {
    const tracker = createSceneStateDiffTracker();
    const layerA = layer("comp-1", "track-a", "clip-a");
    const layerB = layer("comp-1", "track-b", "clip-b");

    const diffed = diffSceneStateLayers(sceneState([layerA, layerB]), tracker);

    expect(diffed.layers).toEqual([layerA, layerB]);
    expect(diffed.layers.every((entry) => !isUnchangedLayerRef(entry))).toBe(true);
  });

  it("sends a layer as an UnchangedLayerRef when node/opacity/localFrame all match the prior call", () => {
    const tracker = createSceneStateDiffTracker();
    const layerA = layer("comp-1", "track-a", "clip-a");
    diffSceneStateLayers(sceneState([layerA], 0), tracker);

    // Same layer object reference reused at frame 1: nothing about it changed.
    const diffed = diffSceneStateLayers(sceneState([layerA], 1), tracker);

    expect(diffed.layers).toHaveLength(1);
    const [entry] = diffed.layers;
    expect(entry).toBeDefined();
    expect(isUnchangedLayerRef(entry as never)).toBe(true);
    expect(entry).toEqual({
      compositionId: "comp-1",
      trackId: "track-a",
      clipId: "clip-a",
      zIndex: 0,
    });
  });

  it("sends a layer in full when its node reference changed even if opacity/localFrame did not", () => {
    const tracker = createSceneStateDiffTracker();
    const first = layer("comp-1", "track-a", "clip-a");
    diffSceneStateLayers(sceneState([first]), tracker);

    // A structurally-identical but distinct node object: node identity
    // changed, so this must be sent in full, not as a reference.
    const second = layer("comp-1", "track-a", "clip-a");
    const diffed = diffSceneStateLayers(sceneState([second]), tracker);

    expect(diffed.layers).toEqual([second]);
  });

  it("sends a layer in full when opacity changed, even with the same node reference", () => {
    const tracker = createSceneStateDiffTracker();
    const first = layer("comp-1", "track-a", "clip-a", { opacity: 1 });
    diffSceneStateLayers(sceneState([first]), tracker);

    const second = { ...first, opacity: 0.5 };
    const diffed = diffSceneStateLayers(sceneState([second]), tracker);

    expect(diffed.layers).toEqual([second]);
  });

  it("sends a layer in full when localFrame changed, even with the same node reference and opacity", () => {
    const tracker = createSceneStateDiffTracker();
    const first = layer("comp-1", "track-a", "clip-a", { localFrame: 5 });
    diffSceneStateLayers(sceneState([first]), tracker);

    const second = { ...first, localFrame: 6 };
    const diffed = diffSceneStateLayers(sceneState([second]), tracker);

    expect(diffed.layers).toEqual([second]);
  });

  it("sends only the changed/new layers in full, and exactly the unchanged ones as references, in a mixed batch", () => {
    const tracker = createSceneStateDiffTracker();
    const unchangedLayer = layer("comp-1", "track-a", "clip-a");
    const aboutToChangeLayer = layer("comp-1", "track-b", "clip-b");
    diffSceneStateLayers(sceneState([unchangedLayer, aboutToChangeLayer]), tracker);

    const changedLayer = { ...aboutToChangeLayer, opacity: 0.2 };
    const newLayer = layer("comp-1", "track-c", "clip-c");
    const diffed = diffSceneStateLayers(
      sceneState([unchangedLayer, changedLayer, newLayer]),
      tracker,
    );

    expect(diffed.layers).toHaveLength(3);
    expect(isUnchangedLayerRef(diffed.layers[0] as never)).toBe(true);
    expect(diffed.layers[1]).toEqual(changedLayer);
    expect(diffed.layers[2]).toEqual(newLayer);
  });

  it("forwards the reference's live zIndex even when the layer's content is otherwise unchanged and its position shifted", () => {
    const tracker = createSceneStateDiffTracker();
    const layerA = layer("comp-1", "track-a", "clip-a", { zIndex: 0 });
    const layerB = layer("comp-1", "track-b", "clip-b", { zIndex: 1 });
    diffSceneStateLayers(sceneState([layerA, layerB]), tracker);

    // layerA's content is unchanged, but it now renders on top (zIndex 1
    // instead of 0): the emitted reference must carry the new zIndex.
    const movedLayerA = { ...layerA, zIndex: 1 };
    const diffed = diffSceneStateLayers(sceneState([layerB, movedLayerA]), tracker);

    expect(diffed.layers[1]).toEqual({
      compositionId: "comp-1",
      trackId: "track-a",
      clipId: "clip-a",
      zIndex: 1,
    });
  });

  it("carries every other SceneState field through unchanged (frame, width, height, activeCameraNodeId)", () => {
    const tracker = createSceneStateDiffTracker();
    const state: SceneState = {
      ...sceneState([layer("comp-1", "track-a", "clip-a")], 42),
      activeCameraNodeId: "camera-1",
    };
    const diffed = diffSceneStateLayers(state, tracker);

    expect(diffed.compositionId).toBe("comp-1");
    expect(diffed.frame).toBe(42);
    expect(diffed.width).toBe(1920);
    expect(diffed.height).toBe(1080);
    expect(diffed.activeCameraNodeId).toBe("camera-1");
  });
});

describe("reconstructSceneState", () => {
  it("throws UnknownUnchangedLayerError when a reference names a layer never seen in full", () => {
    const cache = createWorkerLayerCache();
    const diffed = {
      compositionId: "comp-1",
      frame: 0,
      width: 1920,
      height: 1080,
      layers: [{ compositionId: "comp-1", trackId: "track-a", clipId: "clip-a", zIndex: 0 }],
    };

    expect(() => reconstructSceneState(diffed, cache)).toThrow(UnknownUnchangedLayerError);
  });

  it("reconstructs a SceneState of only full layers as-is, and caches them", () => {
    const cache = createWorkerLayerCache();
    const layerA = layer("comp-1", "track-a", "clip-a");
    const diffed = { ...sceneState([layerA]), layers: [layerA] };

    const reconstructed = reconstructSceneState(diffed, cache);

    expect(reconstructed).toEqual(sceneState([layerA]));
    expect(cache.byKey.get("comp-1::track-a::clip-a")).toBe(layerA);
  });

  it("resolves an UnchangedLayerRef against a previously-cached full layer, applying the reference's own zIndex", () => {
    const cache = createWorkerLayerCache();
    const layerA = layer("comp-1", "track-a", "clip-a", { zIndex: 0 });
    reconstructSceneState({ ...sceneState([layerA]), layers: [layerA] }, cache);

    const diffed = {
      ...sceneState([], 1),
      layers: [{ compositionId: "comp-1", trackId: "track-a", clipId: "clip-a", zIndex: 3 }],
    };
    const reconstructed = reconstructSceneState(diffed, cache);

    expect(reconstructed.layers).toEqual([{ ...layerA, zIndex: 3 }]);
  });

  it("reconstructs the correct effective SceneState from a mix of full layers and lightweight references", () => {
    const cache = createWorkerLayerCache();
    const unchangedLayer = layer("comp-1", "track-a", "clip-a");
    const priorLayerB = layer("comp-1", "track-b", "clip-b");
    reconstructSceneState(
      { ...sceneState([unchangedLayer, priorLayerB]), layers: [unchangedLayer, priorLayerB] },
      cache,
    );

    const changedLayerB = { ...priorLayerB, opacity: 0.3 };
    const newLayerC = layer("comp-1", "track-c", "clip-c");
    const diffed = {
      ...sceneState([], 2),
      layers: [
        { compositionId: "comp-1", trackId: "track-a", clipId: "clip-a", zIndex: 0 },
        changedLayerB,
        newLayerC,
      ],
    };

    const reconstructed = reconstructSceneState(diffed, cache);

    expect(reconstructed.layers).toEqual([unchangedLayer, changedLayerB, newLayerC]);
  });

  it("round-trips through diffSceneStateLayers + reconstructSceneState to reproduce the original SceneState exactly", () => {
    const tracker = createSceneStateDiffTracker();
    const cache = createWorkerLayerCache();

    const unchangedLayer = layer("comp-1", "track-a", "clip-a");
    const firstState = sceneState([unchangedLayer, layer("comp-1", "track-b", "clip-b")], 0);
    const firstDiffed = diffSceneStateLayers(firstState, tracker);
    const firstReconstructed = reconstructSceneState(firstDiffed, cache);
    expect(firstReconstructed).toEqual(firstState);

    const changedLayerB = layer("comp-1", "track-b", "clip-b", { opacity: 0.6 });
    const secondState = sceneState([unchangedLayer, changedLayerB], 1);
    const secondDiffed = diffSceneStateLayers(secondState, tracker);
    // Confirm the wire payload actually shrank: track-a's layer went out as a reference.
    expect(isUnchangedLayerRef(secondDiffed.layers[0] as never)).toBe(true);
    const secondReconstructed = reconstructSceneState(secondDiffed, cache);
    expect(secondReconstructed).toEqual(secondState);
  });
});
