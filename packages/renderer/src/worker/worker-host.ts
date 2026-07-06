import type { CreateRendererOptions } from "../create-renderer.js";
import { createRenderer } from "../create-renderer.js";
import type { PixelReadableRenderer } from "../pixel-readable-renderer.js";
import type { Renderer } from "../renderer.js";
import { createWorkerLayerCache, reconstructSceneState } from "./scene-state-diff.js";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.js";

/**
 * Constructs a `Renderer`, injectable so tests drive `WorkerHost` against a
 * fake `Renderer` (no real GPU) the same way `createRenderer`'s own
 * `detectWebGpuSupport` seam avoids one. Defaults to the real
 * `createRenderer` from `./create-renderer.js`.
 */
export type RendererFactory = (options?: CreateRendererOptions) => Renderer;

/** Posts a `WorkerResponse` back to the main thread. Injectable so tests capture posted messages without a real worker boundary. */
export type PostResponseFn = (response: WorkerResponse) => void;

/**
 * The subset of `DedicatedWorkerGlobalScope` this module actually touches.
 * `self`'s ambient type comes from the `DOM` lib (this project has no
 * per-package `lib` override, and `DOM`/`WebWorker` cannot both be listed:
 * they declare incompatible global `self`/`postMessage`/`onmessage` types),
 * so accessing worker-only members needs a local cast; this narrow
 * structural interface is that cast's target, kept separate from `any` so
 * the two members actually used stay type-checked.
 */
interface WorkerGlobalScopeLike {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

/** The current global scope, cast down to the worker-only members this module needs. See `WorkerGlobalScopeLike`'s doc for why. */
function getWorkerGlobalScope(): WorkerGlobalScopeLike {
  return self as unknown as WorkerGlobalScopeLike;
}

/**
 * True when `renderer` also satisfies `PixelReadableRenderer`, i.e. it has
 * its own `readPixels` method. A plain duck-type check rather than an
 * `instanceof`: the renderer this host drives is constructed via the
 * injected `RendererFactory`, so its concrete class is never known here,
 * only whatever shape it happens to expose.
 */
function isPixelReadable(renderer: Renderer): renderer is PixelReadableRenderer {
  return "readPixels" in renderer && typeof renderer.readPixels === "function";
}

/** Options accepted by `createWorkerHost`. */
export interface WorkerHostOptions {
  /** Constructs the real `Renderer` this host drives. Defaults to `createRenderer`. */
  createRenderer?: RendererFactory;
  /** Sends a response back to the main thread. Defaults to `self.postMessage`. */
  postResponse?: PostResponseFn;
}

/**
 * The message-handling core that runs inside a worker context: on `init`,
 * constructs a real `Renderer` and initializes it against the transferred
 * `OffscreenCanvas`; on `resize`/`renderFrame`/`dispose`, forwards to the
 * corresponding `Renderer` method. Every request is acknowledged with a
 * matching response (or an `error` response on failure), since
 * `postMessage` alone gives the caller no way to know a request completed.
 *
 * `readPixels` additionally requires the constructed renderer to implement
 * `PixelReadableRenderer` (see `isPixelReadable`): a plain `Renderer` (the
 * `RendererFactory` default used for live preview) has no such method, so
 * this host only ever accepts `readPixels` when its `createRenderer` was
 * configured to build a pixel-readable one, e.g. `@cadra/headless`'s
 * worker-backed render path.
 *
 * Exposed as `handleRequest` (a plain function) rather than only as a
 * `self.onmessage` side effect, so tests can drive it directly with
 * constructed `WorkerRequest` values and inspect exactly what
 * `postResponse` was called with, with no real `Worker`/`OffscreenCanvas`
 * involved. `installWorkerHostMessageListener` (below) is the thin
 * adapter that makes this the entry point of a real `new Worker(url)`.
 */
export interface WorkerHost {
  /** Handles one `WorkerRequest`, calling through to the underlying `Renderer` and posting a matching response. */
  handleRequest(request: WorkerRequest): Promise<void>;
}

/** Creates a `WorkerHost`. With no `options`, drives a real `Renderer` (via `createRenderer`) and posts via `self.postMessage`. */
export function createWorkerHost(options: WorkerHostOptions = {}): WorkerHost {
  const makeRenderer = options.createRenderer ?? createRenderer;
  const postResponse: PostResponseFn =
    options.postResponse ?? ((response) => getWorkerGlobalScope().postMessage(response));

  let renderer: Renderer | undefined;
  const layerCache = createWorkerLayerCache();

  async function handleRequest(request: WorkerRequest): Promise<void> {
    try {
      switch (request.type) {
        case "init": {
          renderer = makeRenderer();
          await renderer.init(request.canvas, request.size);
          postResponse({
            type: "initAck",
            requestId: request.requestId,
            capabilities: renderer.capabilities,
          });
          return;
        }
        case "resize": {
          requireRenderer().resize(request.size);
          postResponse({ type: "resizeAck", requestId: request.requestId });
          return;
        }
        case "renderFrame": {
          const sceneState = reconstructSceneState(request.sceneState, layerCache);
          requireRenderer().renderFrame(sceneState, request.frameContext);
          postResponse({ type: "renderFrameAck", requestId: request.requestId });
          return;
        }
        case "dispose": {
          requireRenderer().dispose();
          postResponse({ type: "disposeAck", requestId: request.requestId });
          return;
        }
        case "readPixels": {
          const activeRenderer = requireRenderer();
          if (!isPixelReadable(activeRenderer)) {
            throw new WorkerRendererNotPixelReadableError();
          }
          const pixels = await activeRenderer.readPixels();
          postResponse({ type: "readPixelsAck", requestId: request.requestId, pixels });
          return;
        }
      }
    } catch (caught) {
      postResponse({
        type: "error",
        requestId: request.requestId,
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  function requireRenderer(): Renderer {
    if (renderer === undefined) {
      throw new WorkerHostNotInitializedError();
    }
    return renderer;
  }

  return { handleRequest };
}

/** Thrown when a `WorkerHost` receives `resize`/`renderFrame`/`dispose` before a successful `init`. */
export class WorkerHostNotInitializedError extends Error {
  constructor() {
    super("WorkerHost received a request before init() completed.");
    this.name = "WorkerHostNotInitializedError";
  }
}

/** Thrown when a `WorkerHost` receives `readPixels` but the renderer its `RendererFactory` constructed does not implement `PixelReadableRenderer`. */
export class WorkerRendererNotPixelReadableError extends Error {
  constructor() {
    super(
      "WorkerHost received readPixels, but the renderer constructed by its RendererFactory does not implement PixelReadableRenderer.",
    );
    this.name = "WorkerRendererNotPixelReadableError";
  }
}

/**
 * Wires a `WorkerHost` up as the real `onmessage` handler of the current
 * worker global scope, i.e. this is the call a real `new Worker(url)`
 * entry-point module makes at its top level. Not exercised by this
 * package's tests (there is no real worker global scope to install it
 * into in this Node/Vitest environment); `WorkerHost.handleRequest` above
 * is what tests drive directly.
 */
export function installWorkerHostMessageListener(options?: WorkerHostOptions): void {
  const host = createWorkerHost(options);
  getWorkerGlobalScope().onmessage = (event) => {
    void host.handleRequest(event.data);
  };
}
