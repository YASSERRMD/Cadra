import type { Pending, Project, SceneState } from "@cadra/core";
import { createFrameContext, resolveSceneAtFrame } from "@cadra/core";
import type { PixelBuffer, PixelReadableRenderer } from "@cadra/renderer";
import { renderWhenAssetsReady } from "@cadra/renderer";

/** One frame's fully rendered, read-back output. */
export interface RenderedFrame {
  /** Integer frame index, counting from 0. */
  frame: number;
  /** The pixel buffer `renderer.readPixels()` returned for this frame. */
  pixels: PixelBuffer;
}

/**
 * Returns every asset `frame`'s resolved `sceneState` depends on, so the
 * render loop can gate rendering behind `waitForAssets`/
 * `renderWhenAssetsReady` before drawing. Defaults to "no pending assets",
 * matching `@cadra/player`'s `Transport.isFrameReady` default of
 * always-ready: a scene with no asset-readiness concerns needs no gating at
 * all.
 *
 * Unlike `Transport.isFrameReady` (a synchronous boolean, since its tick
 * loop cannot await mid-tick), this returns the actual `Pending` handles: a
 * headless render has no live playhead to keep responsive, so it can simply
 * await every one of them, in full, before every single frame.
 */
export type GetPendingAssetsFn = (frame: number, sceneState: SceneState) => Iterable<Pending>;

/** Reports progress: `frame` just finished, out of `totalFrames` (always `durationInFrames`). */
export type OnProgressFn = (frame: number, totalFrames: number) => void;

/** Options accepted by `renderComposition`. */
export interface RenderCompositionOptions {
  /** The project to render. */
  project: Project;
  /** Which of `project`'s compositions to render. */
  compositionId: string;
  /**
   * Renderer to draw and read back each frame with. Must already be
   * `init`-ed against whatever target the caller's environment provides
   * (e.g. a Node canvas polyfill, or a real `HTMLCanvasElement`/
   * `OffscreenCanvas` when run inside a browser/worker): constructing and
   * initializing a render target is outside this function's scope, matching
   * `@cadra/player`'s `Transport`'s own "must already be init-ed" contract
   * for the `Renderer` it is handed.
   *
   * `renderComposition` owns this renderer for the duration of the walk: it
   * calls `renderer.dispose()` once iteration ends, whether that is because
   * every frame finished or because `signal` aborted (see `signal`'s doc).
   */
  renderer: PixelReadableRenderer;
  /**
   * Base seed for every frame's `FrameContext`. Required, not optional:
   * silently defaulting to something like `Date.now()` would make "the same
   * project/compositionId, run twice" produce two different renders, which
   * defeats headless rendering's entire purpose. Pass a fixed literal (e.g.
   * a string derived from the project/composition itself) for a
   * reproducible render.
   */
  seed: string | number;
  /** Per-frame asset-readiness gate. Defaults to "no pending assets" (see `GetPendingAssetsFn`'s doc). */
  getPendingAssets?: GetPendingAssetsFn;
  /** Invoked once per rendered frame, after that frame's `readPixels()` resolves. */
  onProgress?: OnProgressFn;
  /**
   * Aborting stops the walk promptly between frames: the frame currently in
   * flight when `signal` aborts is allowed to finish (never torn down
   * mid-`renderFrame`/`readPixels`), but no further frame's
   * `resolveSceneAtFrame`/`renderFrame`/`readPixels` runs after that. Either
   * way, `renderer.dispose()` always runs exactly once before the generator
   * finishes, whether iteration ran to completion or was aborted.
   */
  signal?: AbortSignal;
}

/** Thrown when `compositionId` does not name a composition in `project`. */
export class CompositionNotFoundForRenderError extends Error {
  constructor(compositionId: string) {
    super(`renderComposition: no composition with id "${compositionId}" in the given project.`);
    this.name = "CompositionNotFoundForRenderError";
  }
}

/**
 * Renders every frame of `options.project`'s composition
 * `options.compositionId`, in order, from frame `0` to `durationInFrames -
 * 1`, yielding each one's pixels as soon as it is ready.
 *
 * This is Cadra's deterministic headless capture mode: a fixed timestep
 * walk with no `requestAnimationFrame` and no wall clock anywhere in the
 * loop (`options.seed` is the only source of randomness, and it is
 * required, never derived from `Date.now()` or similar). Reusing Phase 15's
 * `PixelReadableRenderer` (worker-backed or direct) means the exact same
 * `renderFrame` draw path live preview uses also drives headless capture;
 * only the driving loop differs (sequential frame-by-frame here, instead of
 * `Transport`'s wall-clock-anchored tick).
 *
 * Every frame is gated behind `renderWhenAssetsReady`
 * (`options.getPendingAssets`) before it renders: unlike `Transport`'s live
 * playback (which can skip/coalesce frames while buffering), headless
 * rendering must never skip or reorder a requested frame, so this always
 * awaits full readiness and always renders every single frame in order.
 *
 * Yields one `RenderedFrame` per frame rather than collecting them all into
 * an array: a render can be hundreds of frames of pixel data, and this way
 * a caller (e.g. a later phase's WebCodecs/encoder pipeline) can consume
 * and discard each frame's buffer as it arrives instead of holding every
 * frame in memory at once.
 *
 * @throws {CompositionNotFoundForRenderError} if `compositionId` does not
 *   exist in `project`.
 */
export async function* renderComposition(
  options: RenderCompositionOptions,
): AsyncGenerator<RenderedFrame, void, void> {
  const composition = options.project.compositions.find(
    (candidate) => candidate.id === options.compositionId,
  );
  if (composition === undefined) {
    throw new CompositionNotFoundForRenderError(options.compositionId);
  }

  const { fps, durationInFrames } = composition;
  const getPendingAssets = options.getPendingAssets ?? (() => []);

  try {
    for (let frame = 0; frame < durationInFrames; frame += 1) {
      if (options.signal?.aborted) {
        return;
      }

      const sceneState = resolveSceneAtFrame(options.project, options.compositionId, frame);
      const pixels = await renderWhenAssetsReady(getPendingAssets(frame, sceneState), () => {
        const frameContext = createFrameContext({
          frame,
          fps,
          durationInFrames,
          seed: options.seed,
        });
        options.renderer.renderFrame(sceneState, frameContext);
        return options.renderer.readPixels();
      });

      options.onProgress?.(frame, durationInFrames);
      yield { frame, pixels };
    }
  } finally {
    options.renderer.dispose();
  }
}
