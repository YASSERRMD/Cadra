// @vitest-environment jsdom
import { createFrameContext, createIdentityTransform, type SceneState } from "@cadra/core";
import { describe, expect, it, vi } from "vitest";

import type { Renderer, RendererCapabilities } from "../renderer.js";
import { RendererNotInitializedError } from "../three-renderer.js";
import { createWorkerLayerCache, reconstructSceneState } from "./scene-state-diff.js";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.js";
import type { CreateWorkerFn, WorkerLike } from "./worker-renderer.js";
import {
  createBestAvailableRenderer,
  createWorkerRenderer,
  WorkerRendererError,
  WorkerRendererNotInitializedError,
  WorkerRendererRequiresCanvasElementError,
} from "./worker-renderer.js";

const capabilities: RendererCapabilities = {
  backend: "webgpu",
  isFallback: false,
  maxTextureSize: 8192,
};

/**
 * A fake `WorkerLike`: records every posted `WorkerRequest` (and its
 * transfer list), and lets the test manually deliver a `WorkerResponse` via
 * `deliver`, driving `onmessage` exactly like a real worker's message event
 * would, but synchronously and under full test control.
 */
function createFakeWorker(): WorkerLike & {
  posted: Array<{ message: WorkerRequest; transfer: Transferable[] | undefined }>;
  deliver: (response: WorkerResponse) => void;
  terminate: ReturnType<typeof vi.fn>;
} {
  const posted: Array<{ message: WorkerRequest; transfer: Transferable[] | undefined }> = [];
  let onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;

  return {
    posted,
    postMessage: (message: WorkerRequest, transfer?: Transferable[]) => {
      posted.push({ message, transfer });
    },
    get onmessage() {
      return onmessage;
    },
    set onmessage(handler) {
      onmessage = handler;
    },
    deliver: (response: WorkerResponse) => {
      onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
    },
    terminate: vi.fn(),
  };
}

/** A real jsdom `<canvas>`, with `transferControlToOffscreen` stubbed to return an OffscreenCanvas-shaped fake (jsdom implements neither). */
function createCanvasWithFakeOffscreenTransfer(): {
  canvas: HTMLCanvasElement;
  offscreenCanvas: OffscreenCanvas;
} {
  const canvas = document.createElement("canvas");
  const offscreenCanvas = { width: 0, height: 0 } as unknown as OffscreenCanvas;
  (
    canvas as unknown as { transferControlToOffscreen: () => OffscreenCanvas }
  ).transferControlToOffscreen = () => offscreenCanvas;
  return { canvas, offscreenCanvas };
}

const size = { width: 640, height: 480 };

/** Resolves the pending `init` request on `worker` with a successful `initAck`. */
function ackInit(worker: ReturnType<typeof createFakeWorker>): void {
  const initRequest = worker.posted.find((entry) => entry.message.type === "init");
  if (initRequest === undefined) {
    throw new Error("test setup error: no init request was posted");
  }
  worker.deliver({ type: "initAck", requestId: initRequest.message.requestId, capabilities });
}

describe("createWorkerRenderer", () => {
  it("init(): requires an HTMLCanvasElement target, rejecting an OffscreenCanvas-shaped one directly", async () => {
    const worker = createFakeWorker();
    const renderer = createWorkerRenderer({ createWorker: () => worker });
    const offscreenLikeTarget = { width: 100, height: 100 } as unknown as HTMLCanvasElement;

    await expect(renderer.init(offscreenLikeTarget, size)).rejects.toThrow(
      WorkerRendererRequiresCanvasElementError,
    );
  });

  it("init(): calls transferControlToOffscreen() and posts init with the OffscreenCanvas in the transfer list", async () => {
    const worker = createFakeWorker();
    const { canvas, offscreenCanvas } = createCanvasWithFakeOffscreenTransfer();
    const renderer = createWorkerRenderer({ createWorker: () => worker });

    const initPromise = renderer.init(canvas, size);
    ackInit(worker);
    await initPromise;

    expect(worker.posted).toHaveLength(1);
    const { message, transfer } = worker.posted[0]!;
    expect(message).toEqual({
      type: "init",
      requestId: expect.any(Number),
      canvas: offscreenCanvas,
      size,
    });
    expect(transfer).toEqual([offscreenCanvas]);
  });

  it("init(): resolves once initAck is delivered, and populates backend/capabilities from it", async () => {
    const worker = createFakeWorker();
    const { canvas } = createCanvasWithFakeOffscreenTransfer();
    const renderer = createWorkerRenderer({ createWorker: () => worker });

    const initPromise = renderer.init(canvas, size);
    ackInit(worker);
    await expect(initPromise).resolves.toBeUndefined();

    expect(renderer.backend).toBe("webgpu");
    expect(renderer.capabilities).toEqual(capabilities);
  });

  it("init(): rejects with WorkerRendererError when the worker responds with an error", async () => {
    const worker = createFakeWorker();
    const { canvas } = createCanvasWithFakeOffscreenTransfer();
    const renderer = createWorkerRenderer({ createWorker: () => worker });

    const initPromise = renderer.init(canvas, size);
    const { message } = worker.posted[0]!;
    worker.deliver({ type: "error", requestId: message.requestId, message: "init failed" });

    await expect(initPromise).rejects.toThrow(WorkerRendererError);
    await expect(initPromise).rejects.toThrow(/init failed/);
  });

  it("backend/capabilities throw WorkerRendererNotInitializedError before init() resolves", () => {
    const worker = createFakeWorker();
    const renderer = createWorkerRenderer({ createWorker: () => worker });

    expect(() => renderer.backend).toThrow(WorkerRendererNotInitializedError);
    expect(() => renderer.capabilities).toThrow(WorkerRendererNotInitializedError);
  });

  it("renderFrame/resize/dispose throw WorkerRendererNotInitializedError synchronously before init() resolves, matching the direct renderer's contract", () => {
    const worker = createFakeWorker();
    const renderer = createWorkerRenderer({ createWorker: () => worker });
    const sceneState: SceneState = {
      compositionId: "comp-1",
      frame: 0,
      width: 1920,
      height: 1080,
      layers: [],
    };
    const frameContext = createFrameContext({ frame: 0, fps: 30, durationInFrames: 90, seed: "s" });

    expect(() => renderer.renderFrame(sceneState, frameContext)).toThrow(
      WorkerRendererNotInitializedError,
    );
    expect(() => renderer.resize({ width: 100, height: 100 })).toThrow(
      WorkerRendererNotInitializedError,
    );
    expect(() => renderer.dispose()).toThrow(WorkerRendererNotInitializedError);
    // No request should have been posted to the worker at all: every one of
    // these calls must fail before ever reaching postMessage.
    expect(worker.posted).toHaveLength(0);
  });

  it("resize(): posts a resize request and awaits its ack before resolving the underlying promise", async () => {
    const worker = createFakeWorker();
    const { canvas } = createCanvasWithFakeOffscreenTransfer();
    const renderer = createWorkerRenderer({ createWorker: () => worker });
    const initPromise = renderer.init(canvas, size);
    ackInit(worker);
    await initPromise;

    renderer.resize({ width: 320, height: 240 });

    const resizeRequest = worker.posted.find((entry) => entry.message.type === "resize");
    expect(resizeRequest?.message).toEqual({
      type: "resize",
      requestId: expect.any(Number),
      size: { width: 320, height: 240 },
    });
  });

  it("dispose(): posts a dispose request and terminates the worker once acknowledged", async () => {
    const worker = createFakeWorker();
    const { canvas } = createCanvasWithFakeOffscreenTransfer();
    const renderer = createWorkerRenderer({ createWorker: () => worker });
    const initPromise = renderer.init(canvas, size);
    ackInit(worker);
    await initPromise;

    renderer.dispose();
    const disposeRequest = worker.posted.find((entry) => entry.message.type === "dispose");
    expect(disposeRequest).toBeDefined();
    expect(worker.terminate).not.toHaveBeenCalled();

    worker.deliver({ type: "disposeAck", requestId: disposeRequest!.message.requestId });
    // terminate() runs in a .finally() after the ack's microtask settles.
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("dispose(): still terminates the worker even if the dispose request errors", async () => {
    const worker = createFakeWorker();
    const { canvas } = createCanvasWithFakeOffscreenTransfer();
    const renderer = createWorkerRenderer({ createWorker: () => worker });
    const initPromise = renderer.init(canvas, size);
    ackInit(worker);
    await initPromise;

    renderer.dispose();
    const disposeRequest = worker.posted.find((entry) => entry.message.type === "dispose");
    worker.deliver({
      type: "error",
      requestId: disposeRequest!.message.requestId,
      message: "dispose failed",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  describe("renderFrame()", () => {
    const frameContext = createFrameContext({ frame: 0, fps: 30, durationInFrames: 90, seed: "s" });

    /** A single mesh-shaped group SceneNode, cheap to construct and compare. */
    function node(id: string) {
      return {
        id,
        kind: "group" as const,
        transform: createIdentityTransform(),
        visible: true,
        children: [],
      };
    }

    async function setUpInitializedRenderer(): Promise<{
      worker: ReturnType<typeof createFakeWorker>;
      renderer: Renderer;
    }> {
      const worker = createFakeWorker();
      const { canvas } = createCanvasWithFakeOffscreenTransfer();
      const renderer = createWorkerRenderer({ createWorker: () => worker });
      const initPromise = renderer.init(canvas, size);
      ackInit(worker);
      await initPromise;
      return { worker, renderer };
    }

    it("posts a renderFrame request carrying the SceneState/FrameContext, and resolves internally once acked", async () => {
      const { worker, renderer } = await setUpInitializedRenderer();
      const sceneState: SceneState = {
        compositionId: "comp-1",
        frame: 0,
        width: 1920,
        height: 1080,
        layers: [
          {
            compositionId: "comp-1",
            trackId: "track-1",
            clipId: "clip-1",
            node: node("node-1"),
            zIndex: 0,
            localFrame: 0,
            opacity: 1,
          },
        ],
      };

      renderer.renderFrame(sceneState, frameContext);

      const renderRequest = worker.posted.find((entry) => entry.message.type === "renderFrame");
      expect(renderRequest).toBeDefined();
      const message = renderRequest!.message;
      if (message.type !== "renderFrame") {
        throw new Error("expected a renderFrame message");
      }
      expect(message.frameContext).toEqual(frameContext);
      expect(message.sceneState.layers).toEqual(sceneState.layers);

      // Deliver the ack: renderFrame() itself is synchronous-void (matching
      // the Renderer interface), so this just confirms no unhandled
      // rejection/hang results from acking it.
      worker.deliver({ type: "renderFrameAck", requestId: message.requestId });
      await Promise.resolve();
    });

    it("does not throw (a synchronous-void call) even when the worker responds with an error", async () => {
      const { worker, renderer } = await setUpInitializedRenderer();
      const sceneState: SceneState = {
        compositionId: "comp-1",
        frame: 0,
        width: 1920,
        height: 1080,
        layers: [],
      };

      expect(() => renderer.renderFrame(sceneState, frameContext)).not.toThrow();
      const renderRequest = worker.posted.find((entry) => entry.message.type === "renderFrame");
      worker.deliver({
        type: "error",
        requestId: renderRequest!.message.requestId,
        message: "boom",
      });
      // Letting the rejected promise's .catch() run: an unhandled rejection
      // here would fail the test via Vitest's unhandled-rejection reporting.
      await Promise.resolve();
      await Promise.resolve();
    });

    it("diffs successive calls: an unchanged layer is sent as a lightweight reference on the second call", async () => {
      const { worker, renderer } = await setUpInitializedRenderer();
      const sharedNode = node("shared-node");
      const layerA = {
        compositionId: "comp-1",
        trackId: "track-a",
        clipId: "clip-a",
        node: sharedNode,
        zIndex: 0,
        localFrame: 0,
        opacity: 1,
      };

      renderer.renderFrame(
        { compositionId: "comp-1", frame: 0, width: 1920, height: 1080, layers: [layerA] },
        frameContext,
      );
      renderer.renderFrame(
        { compositionId: "comp-1", frame: 1, width: 1920, height: 1080, layers: [layerA] },
        frameContext,
      );

      const renderRequests = worker.posted.filter((entry) => entry.message.type === "renderFrame");
      expect(renderRequests).toHaveLength(2);
      const secondMessage = renderRequests[1]!.message;
      if (secondMessage.type !== "renderFrame") {
        throw new Error("expected a renderFrame message");
      }
      // The second call's layer for the same (compositionId, trackId,
      // clipId) is unchanged, so it must be a lightweight reference (no
      // `node` field), not the full layer.
      expect(secondMessage.sceneState.layers[0]).not.toHaveProperty("node");
      expect(secondMessage.sceneState.layers[0]).toEqual({
        compositionId: "comp-1",
        trackId: "track-a",
        clipId: "clip-a",
        zIndex: 0,
      });
    });

    it("the effective SceneState/FrameContext the worker would reconstruct is identical to what a direct in-process renderer receives for the same inputs", async () => {
      const { worker, renderer } = await setUpInitializedRenderer();
      const sharedNode = node("shared-node");
      const firstState: SceneState = {
        compositionId: "comp-1",
        frame: 0,
        width: 1920,
        height: 1080,
        layers: [
          {
            compositionId: "comp-1",
            trackId: "track-a",
            clipId: "clip-a",
            node: sharedNode,
            zIndex: 0,
            localFrame: 0,
            opacity: 1,
          },
        ],
      };
      const secondState: SceneState = {
        compositionId: "comp-1",
        frame: 1,
        width: 1920,
        height: 1080,
        layers: [
          // Same layer content/reference as firstState: this is the one
          // that should collapse to an UnchangedLayerRef on the wire.
          firstState.layers[0]!,
        ],
      };

      // What a *direct* in-process renderer's renderFrame would receive,
      // via a fake Renderer capturing its own call arguments.
      const directCalls: Array<{ sceneState: SceneState; frameContext: typeof frameContext }> = [];
      const directRenderer: Renderer = {
        init: async () => undefined,
        renderFrame: (sceneState, ctx) => directCalls.push({ sceneState, frameContext: ctx }),
        resize: () => undefined,
        dispose: () => undefined,
        backend: "webgpu",
        capabilities,
      };
      await directRenderer.init({} as unknown as HTMLCanvasElement, size);
      directRenderer.renderFrame(firstState, frameContext);
      directRenderer.renderFrame(secondState, frameContext);

      // What the worker-backed renderer posts for the same two calls.
      renderer.renderFrame(firstState, frameContext);
      renderer.renderFrame(secondState, frameContext);
      const renderRequests = worker.posted.filter((entry) => entry.message.type === "renderFrame");

      // Reconstruct the effective SceneState the worker-host would build
      // from each posted (possibly diffed) payload, using the same
      // reconstruction logic worker-host.ts calls internally.
      const cache = createWorkerLayerCache();
      const reconstructed = renderRequests.map((entry) => {
        const message = entry.message;
        if (message.type !== "renderFrame") {
          throw new Error("expected a renderFrame message");
        }
        return {
          sceneState: reconstructSceneState(message.sceneState, cache),
          frameContext: message.frameContext,
        };
      });

      expect(reconstructed).toEqual(directCalls);
    });
  });
});

describe("createBestAvailableRenderer", () => {
  it("returns a worker-backed Renderer when the injected detector reports OffscreenCanvas is available", () => {
    const worker = createFakeWorker();
    const createWorker: CreateWorkerFn = () => worker;

    const renderer = createBestAvailableRenderer({
      detectOffscreenCanvasSupport: () => true,
      createWorker,
    });

    // A worker-backed renderer starts uninitialized and reports so via this
    // specific error, which the direct in-process renderer never throws
    // (see the next test): a solid behavioral signal of which path was
    // actually chosen, without reaching into internals.
    expect(() => renderer.backend).toThrow(WorkerRendererNotInitializedError);
  });

  it("returns the direct in-process Renderer (from createRenderer) when the injected detector reports OffscreenCanvas is unavailable", () => {
    const renderer = createBestAvailableRenderer({ detectOffscreenCanvasSupport: () => false });

    // The direct in-process renderer (ThreeRenderer) throws
    // RendererNotInitializedError before init(), never
    // WorkerRendererNotInitializedError: a decisive, behavioral signal that
    // this is genuinely the same construction createRenderer() itself
    // produces, not the worker-backed path.
    expect(() => renderer.backend).toThrow(RendererNotInitializedError);
  });

  it("defaults to the real detectOffscreenCanvasSupport when no override is supplied, and returns the direct renderer in this Node/Vitest environment", () => {
    // No real OffscreenCanvas/transferControlToOffscreen exist here (see
    // offscreen-detection.test.ts), so the real default detector reports
    // unavailable and this must return the direct in-process renderer.
    const renderer = createBestAvailableRenderer();

    expect(() => renderer.backend).toThrow(RendererNotInitializedError);
  });
});
