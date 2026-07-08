import type { Project, TextNode } from "@cadra/core";
import type { FontParseBackend } from "@cadra/text";

/** One `TextNode` a `GoldenScene` needs real, pre-shaped render data for before it can render correctly (see `render-raster-scene.ts`). */
export interface GoldenSceneTextRequirement {
  /** The exact fields `computeTextNodeRenderKey` reads: must match the actual `TextNode` in `buildProject()`'s output so the registered entry resolves at render time. */
  node: Pick<TextNode, "fontRef" | "content" | "variationAxes">;
  /** Basename of a font file under this package's own `test-fixtures/fonts/`. */
  fontFixtureFileName: string;
  /** Which of `@cadra/text`'s two independent engines parses `fontFixtureFileName` for this scene. */
  backend: FontParseBackend;
}

/**
 * Which render backend actually produces a `GoldenScene`'s pixels.
 * Deliberately independent of the scene's own `renderMode` ("raster" vs.
 * "pathTraced", a property of the *composition* graph itself): this is
 * about implementation constraints on this *harness*, not the content
 * being rendered.
 *
 * - `"nativeGpuHeadless"`: `createNativeGpuHeadlessRenderer` (a real
 *   native Dawn/WebGPU device, no browser process at all; see that
 *   function's own doc in `@cadra/headless`). The default for plain raster
 *   scenes: fastest, no Playwright/Chromium dependency.
 * - `"browser"`: a real headless-Chromium page via this package's own
 *   Playwright bridge (`render-browser-scene.ts`). Required for
 *   `renderMode: "pathTraced"` scenes (path tracing needs a real
 *   `THREE.WebGLRenderer`, which the native-GPU-headless path cannot
 *   construct at all - see `PathTracedFrameRenderer`'s own doc), and also
 *   for any scene whose post-processing effect needs a `.sample()` call at
 *   an arbitrary (not just the current-pixel) UV: `"nativeGpuHeadless"`
 *   silently ignores such an offset (ANY offset, not just a
 *   velocity-derived one - see `motion-blur-scene.ts`'s own doc for the
 *   full finding), a limitation of that experimental renderer, not of
 *   `@cadra/renderer`'s own TSL pipeline.
 */
export type GoldenSceneDriver = "nativeGpuHeadless" | "browser";

/**
 * One curated scene this harness renders and compares against a checked-in
 * reference PNG. Deliberately a single static frame, not a video: a golden
 * frame only needs to prove one representative moment of a visual feature
 * renders correctly, and a single frame keeps both the render and the
 * checked-in reference small and fast.
 */
export interface GoldenScene {
  /** Stable identifier; also the reference PNG's filename stem (see `reference-path.ts`). */
  name: string;
  driver: GoldenSceneDriver;
  /** Builds the `Project` to render. Called fresh for every render (never memoized): scene builders are cheap, pure functions, matching every other scene builder in this codebase (`Text`, `Shape`, ...). */
  buildProject: () => Project;
  compositionId: string;
  /** Which frame of `buildProject()`'s composition to render. */
  frame: number;
  width: number;
  height: number;
  /** Base seed for this scene's `FrameContext`. */
  seed: string;
  /** Real text render data this scene's `TextNode`s need registered before rendering; omitted for scenes with no text. */
  textRequirements?: GoldenSceneTextRequirement[];
}
