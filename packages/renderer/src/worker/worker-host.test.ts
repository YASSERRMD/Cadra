import {
  createFrameContext,
  createIdentityTransform,
  type FrameContext,
  type SceneState,
} from "@cadra/core";
import { describe, expect, it, vi } from "vitest";

import type { Renderer, RendererCapabilities } from "../renderer.js";
import { createWorkerHost, WorkerHostNotInitializedError } from "./worker-host.js";
import type { DiffedSceneState, WorkerRequest, WorkerResponse } from "./worker-protocol.js";

const capabilities: RendererCapabilities = {
  backend: "webgpu",
  isFallback: false,
  maxTextureSize: 8192,
};

/** A minimal fake `Renderer`: records calls, touches no GPU. */
function createFakeRenderer(overrides: Partial<Renderer> = {}): Renderer {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    renderFrame: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    backend: "webgpu",
    capabilities,
    ...overrides,
  };
}

const canvas = { width: 100, height: 100 } as unknown as OffscreenCanvas;
const size = { width: 100, height: 100 };

const emptyDiffedSceneState: DiffedSceneState = {
  compositionId: "comp-1",
  frame: 0,
  width: 1920,
  height: 1080,
  layers: [],
};

const frameContext: FrameContext = createFrameContext({
  frame: 0,
  fps: 30,
  durationInFrames: 90,
  seed: "s",
});

describe("createWorkerHost", () => {
  it("on init: constructs a Renderer via the injected factory, calls init() against the canvas/size, and posts initAck with capabilities", async () => {
    const fakeRenderer = createFakeRenderer();
    const createRenderer = vi.fn(() => fakeRenderer);
    const postResponse = vi.fn();
    const host = createWorkerHost({ createRenderer, postResponse });

    const request: WorkerRequest = { type: "init", requestId: 1, canvas, size };
    await host.handleRequest(request);

    expect(createRenderer).toHaveBeenCalledTimes(1);
    expect(fakeRenderer.init).toHaveBeenCalledWith(canvas, size);
    expect(postResponse).toHaveBeenCalledWith({
      type: "initAck",
      requestId: 1,
      capabilities,
    });
  });

  it("on init: posts an error response (not a hang) when renderer.init() rejects", async () => {
    const failingRenderer = createFakeRenderer({
      init: vi.fn().mockRejectedValue(new Error("gpu unavailable")),
    });
    const postResponse = vi.fn();
    const host = createWorkerHost({
      createRenderer: () => failingRenderer,
      postResponse,
    });

    await host.handleRequest({ type: "init", requestId: 7, canvas, size });

    expect(postResponse).toHaveBeenCalledWith({
      type: "error",
      requestId: 7,
      message: "gpu unavailable",
    });
  });

  it("on init: posts an error response with a String(caught) message when a non-Error is thrown", async () => {
    const failingRenderer = createFakeRenderer({
      init: vi.fn().mockRejectedValue("plain string failure"),
    });
    const postResponse = vi.fn();
    const host = createWorkerHost({
      createRenderer: () => failingRenderer,
      postResponse,
    });

    await host.handleRequest({ type: "init", requestId: 8, canvas, size });

    expect(postResponse).toHaveBeenCalledWith({
      type: "error",
      requestId: 8,
      message: "plain string failure",
    });
  });

  it("on resize (after init): calls renderer.resize() and posts resizeAck", async () => {
    const fakeRenderer = createFakeRenderer();
    const postResponse = vi.fn();
    const host = createWorkerHost({ createRenderer: () => fakeRenderer, postResponse });
    await host.handleRequest({ type: "init", requestId: 1, canvas, size });

    await host.handleRequest({ type: "resize", requestId: 2, size: { width: 50, height: 50 } });

    expect(fakeRenderer.resize).toHaveBeenCalledWith({ width: 50, height: 50 });
    expect(postResponse).toHaveBeenCalledWith({ type: "resizeAck", requestId: 2 });
  });

  it("on resize (before init): posts an error response instead of throwing/hanging", async () => {
    const postResponse = vi.fn();
    const host = createWorkerHost({ createRenderer: () => createFakeRenderer(), postResponse });

    await host.handleRequest({ type: "resize", requestId: 2, size: { width: 50, height: 50 } });

    expect(postResponse).toHaveBeenCalledWith({
      type: "error",
      requestId: 2,
      message: new WorkerHostNotInitializedError().message,
    });
  });

  it("on renderFrame (after init): reconstructs the SceneState and calls renderer.renderFrame(), posting renderFrameAck", async () => {
    const fakeRenderer = createFakeRenderer();
    const postResponse = vi.fn();
    const host = createWorkerHost({ createRenderer: () => fakeRenderer, postResponse });
    await host.handleRequest({ type: "init", requestId: 1, canvas, size });

    await host.handleRequest({
      type: "renderFrame",
      requestId: 3,
      sceneState: emptyDiffedSceneState,
      frameContext,
    });

    expect(fakeRenderer.renderFrame).toHaveBeenCalledWith(
      { compositionId: "comp-1", frame: 0, width: 1920, height: 1080, layers: [] },
      frameContext,
    );
    expect(postResponse).toHaveBeenCalledWith({ type: "renderFrameAck", requestId: 3 });
  });

  it("on renderFrame: reconstructs full layers from a mix of full layers and UnchangedLayerRefs across two calls", async () => {
    const fakeRenderer = createFakeRenderer();
    const postResponse = vi.fn();
    const host = createWorkerHost({ createRenderer: () => fakeRenderer, postResponse });
    await host.handleRequest({ type: "init", requestId: 1, canvas, size });

    const nodeA = {
      id: "node-a",
      kind: "group" as const,
      transform: createIdentityTransform(),
      visible: true,
      children: [],
    };
    const fullLayerA = {
      compositionId: "comp-1",
      trackId: "track-a",
      clipId: "clip-a",
      node: nodeA,
      zIndex: 0,
      localFrame: 0,
      opacity: 1,
    };
    await host.handleRequest({
      type: "renderFrame",
      requestId: 2,
      sceneState: { ...emptyDiffedSceneState, layers: [fullLayerA] },
      frameContext,
    });

    // Second call: track-a comes in as a lightweight reference (unchanged),
    // track-b is new and comes in full.
    const fullLayerB = {
      compositionId: "comp-1",
      trackId: "track-b",
      clipId: "clip-b",
      node: { ...nodeA, id: "node-b" },
      zIndex: 1,
      localFrame: 2,
      opacity: 0.5,
    };
    await host.handleRequest({
      type: "renderFrame",
      requestId: 3,
      sceneState: {
        ...emptyDiffedSceneState,
        frame: 1,
        layers: [
          { compositionId: "comp-1", trackId: "track-a", clipId: "clip-a", zIndex: 0 },
          fullLayerB,
        ],
      },
      frameContext,
    });

    const expectedReconstructed: SceneState = {
      compositionId: "comp-1",
      frame: 1,
      width: 1920,
      height: 1080,
      layers: [fullLayerA, fullLayerB],
    };
    expect(fakeRenderer.renderFrame).toHaveBeenLastCalledWith(expectedReconstructed, frameContext);
    expect(postResponse).toHaveBeenLastCalledWith({ type: "renderFrameAck", requestId: 3 });
  });

  it("on renderFrame (before init): posts an error response instead of throwing/hanging", async () => {
    const postResponse = vi.fn();
    const host = createWorkerHost({ createRenderer: () => createFakeRenderer(), postResponse });

    await host.handleRequest({
      type: "renderFrame",
      requestId: 3,
      sceneState: emptyDiffedSceneState,
      frameContext,
    });

    expect(postResponse).toHaveBeenCalledWith({
      type: "error",
      requestId: 3,
      message: new WorkerHostNotInitializedError().message,
    });
  });

  it("on dispose (after init): calls renderer.dispose() and posts disposeAck", async () => {
    const fakeRenderer = createFakeRenderer();
    const postResponse = vi.fn();
    const host = createWorkerHost({ createRenderer: () => fakeRenderer, postResponse });
    await host.handleRequest({ type: "init", requestId: 1, canvas, size });

    await host.handleRequest({ type: "dispose", requestId: 4 });

    expect(fakeRenderer.dispose).toHaveBeenCalledTimes(1);
    expect(postResponse).toHaveBeenCalledWith({ type: "disposeAck", requestId: 4 });
  });

  it("on dispose (before init): posts an error response instead of throwing/hanging", async () => {
    const postResponse = vi.fn();
    const host = createWorkerHost({ createRenderer: () => createFakeRenderer(), postResponse });

    await host.handleRequest({ type: "dispose", requestId: 4 });

    expect(postResponse).toHaveBeenCalledWith({
      type: "error",
      requestId: 4,
      message: new WorkerHostNotInitializedError().message,
    });
  });

  it("posts a response formatted as a WorkerResponse for every request type it handles", async () => {
    const fakeRenderer = createFakeRenderer();
    const responses: WorkerResponse[] = [];
    const host = createWorkerHost({
      createRenderer: () => fakeRenderer,
      postResponse: (response) => responses.push(response),
    });

    await host.handleRequest({ type: "init", requestId: 1, canvas, size });
    await host.handleRequest({ type: "resize", requestId: 2, size });
    await host.handleRequest({
      type: "renderFrame",
      requestId: 3,
      sceneState: emptyDiffedSceneState,
      frameContext,
    });
    await host.handleRequest({ type: "dispose", requestId: 4 });

    expect(responses.map((response) => response.type)).toEqual([
      "initAck",
      "resizeAck",
      "renderFrameAck",
      "disposeAck",
    ]);
  });
});
