import type { FrameContext, ResolvedLayer, SceneState } from "@cadra/core";

import type { PixelBuffer } from "../pixel-readable-renderer.js";
import type { RendererCapabilities, RenderSize } from "../renderer.js";

/**
 * Stand-in for a `ResolvedLayer` whose `node`/`opacity`/`localFrame` are all
 * unchanged since the last `renderFrame` call for the same position. Carries
 * only the lookup key (`compositionId`/`trackId`/`clipId`), never `node`
 * itself, which is the whole point: a large, unchanged scene-node subtree is
 * never re-sent across the worker boundary.
 *
 * `zIndex` is still included (not part of the unchanged-check, see
 * `diffSceneStateLayers`'s own doc) since stacking order can shift even when
 * a layer's own content did not, and the worker-host's reconstruction needs
 * it to place the reused layer back at the right position.
 */
export interface UnchangedLayerRef {
  compositionId: string;
  trackId: string;
  clipId: string;
  zIndex: number;
}

/** One entry of a diffed `SceneState.layers`: either a full layer or a reference to a cached one. */
export type DiffedLayer = ResolvedLayer | UnchangedLayerRef;

/**
 * `SceneState` with `layers` replaced by `DiffedLayer[]`: some entries are
 * full `ResolvedLayer`s (new or changed), others are lightweight
 * `UnchangedLayerRef`s the worker-host must resolve against its own cache
 * before rendering. This is the shape actually sent over `postMessage` for a
 * `renderFrame` request, never the plain `SceneState` directly.
 */
export interface DiffedSceneState extends Omit<SceneState, "layers"> {
  layers: DiffedLayer[];
}

/** Narrows a `DiffedLayer` to an `UnchangedLayerRef` (as opposed to a full `ResolvedLayer`). */
export function isUnchangedLayerRef(layer: DiffedLayer): layer is UnchangedLayerRef {
  return !("node" in layer);
}

/**
 * Main-thread-to-worker requests, discriminated on `type`. Every variant
 * carries a `requestId` so the main thread can match an eventual response
 * (see `WorkerResponse`) back to the call that triggered it: `postMessage`
 * itself has no built-in request/response correlation, and multiple requests
 * (e.g. an in-flight `renderFrame` alongside a `resize`) can legitimately be
 * outstanding at once.
 */
export type WorkerRequest =
  | {
      type: "init";
      requestId: number;
      canvas: OffscreenCanvas;
      size: RenderSize;
    }
  | {
      type: "resize";
      requestId: number;
      size: RenderSize;
    }
  | {
      type: "renderFrame";
      requestId: number;
      sceneState: DiffedSceneState;
      frameContext: FrameContext;
    }
  | {
      type: "dispose";
      requestId: number;
    }
  | {
      type: "readPixels";
      requestId: number;
    };

/**
 * Worker-to-main-thread responses, discriminated on `type`. Every
 * non-`error` variant acknowledges exactly one `WorkerRequest` by
 * `requestId`, so the main-thread side can resolve the promise it handed
 * back for that call; `error` carries a plain message string (not a live
 * `Error` instance, since `Error` does not reliably survive
 * `structuredClone` with all its properties, e.g. `stack` is not guaranteed)
 * so a rejecting `Renderer` method (e.g. `init` against an unsupported
 * target) surfaces back to the caller instead of leaving its promise
 * pending forever.
 *
 * `initAck` additionally carries `capabilities` (which itself includes
 * `backend`, see `RendererCapabilities`): the real `Renderer` constructed
 * inside the worker is the only place that knows which backend it actually
 * selected (WebGPU vs. WebGL2 fallback), so the main-thread
 * `Renderer.backend`/`.capabilities` getters have no other way to report a
 * truthful value.
 */
export type WorkerResponse =
  | { type: "initAck"; requestId: number; capabilities: RendererCapabilities }
  | { type: "resizeAck"; requestId: number }
  | { type: "renderFrameAck"; requestId: number }
  | { type: "disposeAck"; requestId: number }
  | { type: "readPixelsAck"; requestId: number; pixels: PixelBuffer }
  | { type: "error"; requestId: number; message: string };
