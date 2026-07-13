import type { Project, TextNode } from "@cadra/core";
import type { FontParseBackend } from "@cadra/text";

/** One `TextNode` a `GoldenScene` needs real, pre-shaped render data for before it can render correctly (see `render-raster-scene.ts`). */
export interface GoldenSceneTextRequirement {
  /**
   * The exact fields `computeTextNodeRenderKey` reads, plus `morph`: must
   * match the actual `TextNode` in `buildProject()`'s output so the
   * registered entry (or, for a `morph`-configured node, entries -
   * `render-raster-scene.ts`'s own `buildTextRenderRegistry` also registers
   * `morph.from`) resolves at render time.
   */
  node: Pick<TextNode, "fontRef" | "content" | "variationAxes" | "morph">;
  /** Basename of a font file under this package's own `test-fixtures/fonts/`. */
  fontFixtureFileName: string;
  /** Which of `@cadra/text`'s two independent engines parses `fontFixtureFileName` for this scene. */
  backend: FontParseBackend;
}

/** One `ModelNode.assetRef` a `GoldenScene` needs a real GLB fixture for before it can render correctly (see `render-raster-scene.ts`). */
export interface GoldenSceneModelRequirement {
  /** The `ModelNode.assetRef` (in `buildProject()`'s output) this fixture resolves. */
  assetRef: string;
  /** Basename of a `.glb` file under this package's own `test-fixtures/models/`. */
  modelFixtureFileName: string;
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
 *   construct at all - see `PathTracedFrameRenderer`'s own doc). No curated
 *   scene currently needs `"browser"` purely for a post-processing-effect
 *   gap: every effect this harness exercises, `motionBlur` and `lut`
 *   included, renders correctly through `"nativeGpuHeadless"` as of
 *   `applyProductionWebGpuBehavior` in `@cadra/renderer` plus the
 *   `chromaticAberration`/`lut` fixes documented in
 *   `post-processing-scene.ts`'s own doc; `motionBlurScene` stays on
 *   `"browser"` regardless (see that scene's own doc for why switching back
 *   is not worth the churn), and `pathTracedScene` needs it structurally.
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
  /** Real GLB fixtures this scene's `ModelNode`s need registered before rendering; omitted for scenes with no models. A `SatoriNode`'s own render data needs no comparable declaration - see `render-raster-scene.ts`'s own `buildSatoriLayerRenderRegistry` doc for why. */
  modelRequirements?: GoldenSceneModelRequirement[];
}
