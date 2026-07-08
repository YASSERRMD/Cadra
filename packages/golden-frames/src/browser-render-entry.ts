import type { Project } from "@cadra/core";
import { createFrameContext, resolveSceneAtFrame } from "@cadra/core";
import { createPixelReadableRenderer, createRenderer, type PixelBuffer } from "@cadra/renderer";

/**
 * This module is never imported by other TypeScript source in this
 * workspace: it is a browser-side entry point meant to be pointed at by
 * `@cadra/headless`'s `bundleBrowserEntry` (esbuild's `entryPoints`), then
 * injected wholesale into a headless-Chromium page via
 * `HeadlessPageLike.addScript`, mirroring `@cadra/encode`'s own
 * `browser-headless-render-entry.ts` (see that module's own doc for the
 * full rationale behind this shape).
 *
 * Renders exactly one frame of one `GoldenScene`-shaped config, entirely
 * inside the page, and returns its pixels directly as this function's own
 * return value - no `exposeFunction`/streaming bridge needed (unlike the
 * full MP4-muxing pipeline this mirrors): a single frame's pixels are small
 * enough, and this call happens exactly once per render, to just cross
 * `page.evaluate`'s own structured-clone return-value boundary directly.
 *
 * Used for this harness's own `GoldenSceneDriver: "browser"` scenes (see
 * that type's own doc in `scenes/golden-scene.ts`): currently
 * `renderMode: "pathTraced"` scenes specifically, since path tracing needs
 * a real `THREE.WebGLRenderer`, which `createRenderer()`'s real browser
 * WebGPU/WebGL2 selection provides, unlike the native-GPU-headless path.
 */

/** Config this entry function accepts, structured-cloned in from the Node orchestrator via `page.evaluate`. */
export interface BrowserGoldenFrameConfig {
  /** The project to render. */
  project: Project;
  /** Which of `project`'s compositions to render. */
  compositionId: string;
  /** Which frame of that composition to render (walked to sequentially from frame 0; see `renderGoldenFrameInBrowser`'s own doc). */
  frame: number;
  /** Canvas/render target size. */
  width: number;
  height: number;
  /** Base seed for every frame's `FrameContext`. */
  seed: string;
}

/** A `PixelBuffer` with its `data` converted to a plain `number[]`, the shape that actually survives a `page.evaluate` return-value round trip intact (see `renderGoldenFrameInBrowser`'s own doc for why). */
export interface SerializedPixelBuffer {
  width: number;
  height: number;
  data: number[];
}

/**
 * Real `ReadPixelsFn`: draws `target` onto a fresh, same-sized 2D canvas
 * via `drawImage`, then reads it back with `getImageData`. The same
 * backend-agnostic snapshot technique as `@cadra/encode`'s own
 * `createRealReadPixels` (not imported directly: that function lives in
 * `@cadra/encode`, which is not in this package's dependency graph, and
 * reimplementing this one small, self-contained function here is simpler
 * than adding a new cross-package dependency edge just for it); see that
 * function's own doc for the full rationale (works identically regardless
 * of which backend actually drew into `target`, and `willReadFrequently`
 * avoids a GPU-to-CPU sync stall on every frame's `getImageData` call).
 */
function createRealReadPixels(): (
  target: HTMLCanvasElement | OffscreenCanvas,
  size: { width: number; height: number },
) => Promise<PixelBuffer> {
  let snapshotCanvas: HTMLCanvasElement | undefined;
  let snapshotContext: CanvasRenderingContext2D | undefined;

  return async (target, size) => {
    if (snapshotCanvas === undefined || snapshotContext === undefined) {
      snapshotCanvas = document.createElement("canvas");
      const context = snapshotCanvas.getContext("2d", { willReadFrequently: true });
      if (context === null) {
        throw new Error("browser-render-entry: failed to acquire a 2D rendering context.");
      }
      snapshotContext = context;
    }

    if (snapshotCanvas.width !== size.width || snapshotCanvas.height !== size.height) {
      snapshotCanvas.width = size.width;
      snapshotCanvas.height = size.height;
    }

    snapshotContext.clearRect(0, 0, size.width, size.height);
    snapshotContext.drawImage(target as CanvasImageSource, 0, 0);
    const imageData = snapshotContext.getImageData(0, 0, size.width, size.height);
    return { width: size.width, height: size.height, data: imageData.data };
  };
}

/**
 * Entry function this module's default export is: called via
 * `page.evaluate(renderGoldenFrameInBrowser, config)`. Constructs a real
 * `createRenderer()` (WebGPU-with-WebGL2-fallback, and - unlike the
 * native-GPU-headless path - the one place in this harness that can also
 * render `renderMode: "pathTraced"` content, since `createPixelReadableRenderer`'s
 * own `renderFrame` delegates to `@cadra/pathtracer` for that case, which
 * needs a real `THREE.WebGLRenderer` underneath), then walks every frame
 * from `0` up to `config.frame` in order (not a direct jump), matching
 * `renderComposition`'s own documented contract and this harness's own
 * native-GPU-headless driver (`render-raster-scene.ts`), before reading
 * back and returning the target frame's pixels.
 *
 * Returns a `SerializedPixelBuffer` (a plain `number[]`, not the
 * `Uint8ClampedArray` `readPixels()` itself returns): Playwright's
 * `page.evaluate` return-value serialization does not reliably round-trip
 * a typed array back to the same typed array on the Node side (verified
 * directly while building this module, mirroring `@cadra/encode`'s own
 * `createBridgedWriteTarget`'s identical `Array.from` conversion for the
 * same reason), so the Node-side caller (`render-browser-scene.ts`)
 * reconstructs a real `Uint8ClampedArray` from the returned plain array.
 */
export async function renderGoldenFrameInBrowser(
  config: BrowserGoldenFrameConfig,
): Promise<SerializedPixelBuffer> {
  const canvas = document.createElement("canvas");
  canvas.width = config.width;
  canvas.height = config.height;

  const innerRenderer = createRenderer();
  const renderer = createPixelReadableRenderer({
    renderer: innerRenderer,
    readPixels: createRealReadPixels(),
  });

  await renderer.init(canvas, { width: config.width, height: config.height });

  const composition = config.project.compositions.find((candidate) => candidate.id === config.compositionId);
  if (composition === undefined) {
    throw new Error(
      `renderGoldenFrameInBrowser: project has no composition "${config.compositionId}".`,
    );
  }

  for (let frame = 0; frame <= config.frame; frame += 1) {
    const sceneState = resolveSceneAtFrame(config.project, config.compositionId, frame);
    const frameContext = createFrameContext({
      frame,
      fps: composition.fps,
      durationInFrames: composition.durationInFrames,
      seed: config.seed,
    });
    renderer.renderFrame(sceneState, frameContext);
  }

  const pixels = await renderer.readPixels();
  return { width: pixels.width, height: pixels.height, data: Array.from(pixels.data) };
}
