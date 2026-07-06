import { createFrameContext, createIdentityTransform, type ResolvedLayer } from "@cadra/core";
import { describe, expect, it } from "vitest";

import type {
  DiffedSceneState,
  UnchangedLayerRef,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol.js";
import { isUnchangedLayerRef } from "./worker-protocol.js";

/** A single full `ResolvedLayer`, defaulting to opaque/frame-0. */
function fullLayer(overrides: Partial<ResolvedLayer> = {}): ResolvedLayer {
  return {
    compositionId: "comp-1",
    trackId: "track-1",
    clipId: "clip-1",
    node: {
      id: "node-1",
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

const frameContext = createFrameContext({ frame: 0, fps: 30, durationInFrames: 90, seed: "s" });

describe("WorkerRequest", () => {
  it("constructs and narrows an init request", () => {
    const canvas = { width: 100, height: 100 } as unknown as OffscreenCanvas;
    const request: WorkerRequest = {
      type: "init",
      requestId: 1,
      canvas,
      size: { width: 100, height: 100 },
    };
    expect(request.type).toBe("init");
    if (request.type === "init") {
      expect(request.canvas).toBe(canvas);
      expect(request.size).toEqual({ width: 100, height: 100 });
    }
  });

  it("constructs and narrows a resize request", () => {
    const request: WorkerRequest = {
      type: "resize",
      requestId: 2,
      size: { width: 50, height: 50 },
    };
    expect(request.type).toBe("resize");
    if (request.type === "resize") {
      expect(request.size).toEqual({ width: 50, height: 50 });
    }
  });

  it("constructs and narrows a renderFrame request", () => {
    const sceneState: DiffedSceneState = {
      compositionId: "comp-1",
      frame: 3,
      width: 1920,
      height: 1080,
      layers: [fullLayer()],
    };
    const request: WorkerRequest = {
      type: "renderFrame",
      requestId: 3,
      sceneState,
      frameContext,
    };
    expect(request.type).toBe("renderFrame");
    if (request.type === "renderFrame") {
      expect(request.sceneState.layers).toHaveLength(1);
      expect(request.frameContext.frame).toBe(0);
    }
  });

  it("constructs and narrows a dispose request", () => {
    const request: WorkerRequest = { type: "dispose", requestId: 4 };
    expect(request.type).toBe("dispose");
  });
});

describe("WorkerResponse", () => {
  it("constructs and narrows an initAck response, carrying capabilities", () => {
    const response: WorkerResponse = {
      type: "initAck",
      requestId: 1,
      capabilities: { backend: "webgl2", isFallback: true, maxTextureSize: 4096 },
    };
    expect(response.type).toBe("initAck");
    if (response.type === "initAck") {
      expect(response.capabilities.backend).toBe("webgl2");
    }
  });

  it("constructs and narrows a resizeAck response", () => {
    const response: WorkerResponse = { type: "resizeAck", requestId: 2 };
    expect(response.type).toBe("resizeAck");
  });

  it("constructs and narrows a renderFrameAck response", () => {
    const response: WorkerResponse = { type: "renderFrameAck", requestId: 3 };
    expect(response.type).toBe("renderFrameAck");
  });

  it("constructs and narrows a disposeAck response", () => {
    const response: WorkerResponse = { type: "disposeAck", requestId: 4 };
    expect(response.type).toBe("disposeAck");
  });

  it("constructs and narrows an error response, carrying a plain message string", () => {
    const response: WorkerResponse = {
      type: "error",
      requestId: 5,
      message: "renderer.init() rejected",
    };
    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.message).toBe("renderer.init() rejected");
    }
  });
});

describe("isUnchangedLayerRef", () => {
  it("returns false for a full ResolvedLayer", () => {
    expect(isUnchangedLayerRef(fullLayer())).toBe(false);
  });

  it("returns true for an UnchangedLayerRef", () => {
    const reference: UnchangedLayerRef = {
      compositionId: "comp-1",
      trackId: "track-1",
      clipId: "clip-1",
      zIndex: 0,
    };
    expect(isUnchangedLayerRef(reference)).toBe(true);
  });
});
