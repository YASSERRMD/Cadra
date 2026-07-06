import type { FrameContext, SceneState } from "@cadra/core";

import { createRenderer } from "../create-renderer.js";
import type {
  Renderer,
  RendererBackend,
  RendererCapabilities,
  RenderSize,
  RenderTarget,
} from "../renderer.js";
import {
  detectOffscreenCanvasSupport,
  type OffscreenCanvasDetector,
} from "./offscreen-detection.js";
import { createSceneStateDiffTracker, diffSceneStateLayers } from "./scene-state-diff.js";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.js";

/**
 * The subset of `Worker` that `createWorkerRenderer` actually drives:
 * post a message (optionally transferring ownership of some objects, e.g.
 * the `OffscreenCanvas`), receive messages back, and terminate. Narrower
 * than the real `Worker` type so tests can supply a fake object they
 * control synchronously (or via manually-resolved promises) instead of a
 * real worker, which does not exist in this Node/Vitest environment.
 */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  terminate(): void;
}

/** Constructs the underlying `WorkerLike` `createWorkerRenderer` drives. Defaults to a real `new Worker(...)`. */
export type CreateWorkerFn = () => WorkerLike;

/**
 * Real `CreateWorkerFn`: a module-worker constructed from this file's own
 * sibling `worker-entry.js`, which calls `installWorkerHostMessageListener`
 * at its top level (see that module's doc). `import.meta.url`-relative so
 * this resolves correctly regardless of where the consuming bundle/app
 * itself is served from.
 */
function createRealWorker(): WorkerLike {
  return new Worker(new URL("./worker-entry.js", import.meta.url), { type: "module" });
}

/** Options accepted by `createWorkerRenderer`. */
export interface CreateWorkerRendererOptions {
  /** Constructs the underlying worker. Defaults to a real `new Worker(...)` running `worker-entry.js`. */
  createWorker?: CreateWorkerFn;
  /** Feature-detects `OffscreenCanvas`/`transferControlToOffscreen` availability. Defaults to `detectOffscreenCanvasSupport`. */
  detectOffscreenCanvasSupport?: OffscreenCanvasDetector;
}

/** Thrown when `target` passed to a worker-backed `Renderer.init` is not an `HTMLCanvasElement`. */
export class WorkerRendererRequiresCanvasElementError extends Error {
  constructor() {
    super(
      "createWorkerRenderer's init() requires an HTMLCanvasElement target (it calls transferControlToOffscreen() on it), not an OffscreenCanvas directly.",
    );
    this.name = "WorkerRendererRequiresCanvasElementError";
  }
}

/** Thrown when a worker-backed `Renderer` method other than `init` is called before `init` resolves. */
export class WorkerRendererNotInitializedError extends Error {
  constructor() {
    super("Worker-backed Renderer used before init() resolved.");
    this.name = "WorkerRendererNotInitializedError";
  }
}

/** Rejects with the `message` from an `error`-typed `WorkerResponse`. */
export class WorkerRendererError extends Error {
  constructor(message: string) {
    super(`Worker-backed Renderer reported an error: ${message}`);
    this.name = "WorkerRendererError";
  }
}

let nextRequestId = 0;

/**
 * Creates a `Renderer` backed by a Web Worker driving an `OffscreenCanvas`,
 * satisfying the exact same `Renderer` interface as the direct in-process
 * renderer from `createRenderer`, so `@cadra/player`'s `Transport`/
 * `mountPreview` can use either interchangeably with zero code changes.
 *
 * `init(target, size)` requires `target` to be an `HTMLCanvasElement` (not
 * an `OffscreenCanvas` already): it calls `target.transferControlToOffscreen()`
 * itself and posts the result to the worker in the `init` message's transfer
 * list, so canvas ownership genuinely moves to the worker thread rather than
 * being merely referenced from it. Every other method posts its
 * corresponding message and awaits a matching acknowledgment (or rejects on
 * an `error` response), so a caller awaiting e.g. `renderFrame` knows the
 * worker actually finished drawing, not just that the message was sent.
 *
 * `renderFrame` diffs each new `SceneState` against the last one sent (see
 * `./scene-state-diff.ts`) before posting: layers whose `node`/`opacity`/
 * `localFrame` are unchanged from the same position's prior call are sent
 * as a lightweight reference instead of their full (potentially large)
 * `node` subtree. This is purely a wire-size optimization; the worker-host
 * reconstructs the full, equivalent `SceneState` before ever handing it to
 * the real `Renderer` it drives, so the renderer this produces observes
 * identical draw calls either way.
 */
export function createWorkerRenderer(options: CreateWorkerRendererOptions = {}): Renderer {
  const createWorker = options.createWorker ?? createRealWorker;

  let worker: WorkerLike | undefined;
  let capabilities: RendererCapabilities | undefined;
  const diffTracker = createSceneStateDiffTracker();
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

  function handleWorkerMessage(event: MessageEvent<WorkerResponse>): void {
    const response = event.data;
    const waiter = pending.get(response.requestId);
    if (waiter === undefined) {
      // No caller is awaiting this requestId (e.g. it already
      // rejected/resolved via some other path). Nothing to do: dropping an
      // unmatched response is safe since every request this module sends
      // always registers a waiter before the corresponding postMessage.
      return;
    }
    pending.delete(response.requestId);

    if (response.type === "error") {
      waiter.reject(new WorkerRendererError(response.message));
      return;
    }
    if (response.type === "initAck") {
      capabilities = response.capabilities;
    }
    waiter.resolve();
  }

  /** Posts `request` to the worker and returns a promise settled by the matching response. */
  function sendRequest(request: WorkerRequest): Promise<void> {
    return sendRequestWithTransfer(request, undefined);
  }

  /** Like `sendRequest`, but also passes `transfer` through to `postMessage` (used only by `init`, for the `OffscreenCanvas`). */
  function sendRequestWithTransfer(
    request: WorkerRequest,
    transfer: Transferable[] | undefined,
  ): Promise<void> {
    const activeWorker = requireWorker();
    return new Promise<void>((resolve, reject) => {
      pending.set(request.requestId, { resolve, reject });
      if (transfer !== undefined) {
        activeWorker.postMessage(request, transfer);
      } else {
        activeWorker.postMessage(request);
      }
    });
  }

  function requireWorker(): WorkerLike {
    if (worker === undefined) {
      throw new WorkerRendererNotInitializedError();
    }
    return worker;
  }

  async function init(target: RenderTarget, size: RenderSize): Promise<void> {
    if (!(target instanceof HTMLCanvasElement)) {
      throw new WorkerRendererRequiresCanvasElementError();
    }

    const createdWorker = createWorker();
    createdWorker.onmessage = handleWorkerMessage;
    worker = createdWorker;

    const offscreenCanvas = target.transferControlToOffscreen();
    const requestId = nextRequestId++;
    await sendRequestWithTransfer({ type: "init", requestId, canvas: offscreenCanvas, size }, [
      offscreenCanvas,
    ]);
  }

  function renderFrame(sceneState: SceneState, frameContext: FrameContext): void {
    const diffed = diffSceneStateLayers(sceneState, diffTracker);
    // Fire-and-forget from renderFrame's own synchronous-void signature
    // (matching Renderer.renderFrame exactly): the returned promise still
    // settles pending's waiter, but nothing here needs to await it, since a
    // dropped/rejected renderFrame has nowhere synchronous to report to.
    // Any rejection is still observed (not an unhandled rejection): the
    // `.catch` below is a deliberate no-op sink, not a re-throw, since a
    // frame that failed to render worker-side has no synchronous caller
    // left to receive the error by the time it arrives.
    void sendRequest({
      type: "renderFrame",
      requestId: nextRequestId++,
      sceneState: diffed,
      frameContext,
    }).catch(() => {
      // Swallowed deliberately, see comment above.
    });
  }

  function resize(size: RenderSize): void {
    void sendRequest({ type: "resize", requestId: nextRequestId++, size }).catch(() => {
      // Same reasoning as renderFrame's catch above: resize() is
      // synchronous-void on the Renderer interface too.
    });
  }

  function dispose(): void {
    void sendRequest({ type: "dispose", requestId: nextRequestId++ })
      .catch(() => {
        // Same reasoning as renderFrame's catch above.
      })
      .finally(() => {
        requireWorker().terminate();
      });
  }

  return {
    init,
    renderFrame,
    resize,
    dispose,
    get backend(): RendererBackend {
      return requireCapabilities().backend;
    },
    get capabilities(): RendererCapabilities {
      return requireCapabilities();
    },
  };

  function requireCapabilities(): RendererCapabilities {
    if (capabilities === undefined) {
      throw new WorkerRendererNotInitializedError();
    }
    return capabilities;
  }
}

/** Options accepted by `createBestAvailableRenderer`: identical shape to `CreateWorkerRendererOptions`, forwarded verbatim when the worker path is chosen. */
export type CreateBestAvailableRendererOptions = CreateWorkerRendererOptions;

/**
 * Creates the best `Renderer` available in the current environment: a
 * worker-backed one (via `createWorkerRenderer`) when `OffscreenCanvas`/
 * `transferControlToOffscreen` are available (per the injectable
 * `detectOffscreenCanvasSupport`), otherwise the direct in-process one (via
 * `createRenderer`, Phase 5's renderer). Either result satisfies the same
 * `Renderer` interface, so callers never need to branch on which one they
 * got.
 */
export function createBestAvailableRenderer(
  options: CreateBestAvailableRendererOptions = {},
): Renderer {
  const detectSupport = options.detectOffscreenCanvasSupport ?? detectOffscreenCanvasSupport;
  if (detectSupport()) {
    return createWorkerRenderer(options);
  }
  return createRenderer();
}
