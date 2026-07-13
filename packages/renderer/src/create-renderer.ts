import type { ModelRegistry } from "./assets/model-registry.js";
import { createDefaultModelRegistry } from "./assets/model-registry.js";
import type { WebGpuDetector } from "./capability-detection.js";
import type { EnvironmentRegistry } from "./environment/environment-registry.js";
import { createDefaultEnvironmentRegistry } from "./environment/environment-registry.js";
import type { LutRegistry } from "./lut/lut-registry.js";
import { createDefaultLutRegistry } from "./lut/lut-registry.js";
import type { TextureRegistry } from "./reconciler/registries.js";
import type { Renderer } from "./renderer.js";
import type { SatoriLayerRenderRegistry } from "./svg-layer/satori-layer-render-registry.js";
import type { TextRenderRegistry } from "./text/text-render-registry.js";
import { defaultThreeRendererDependencies, ThreeRenderer } from "./three-renderer.js";
import type { VideoFrameRegistry } from "./video-layer/video-frame-registry.js";

/**
 * Options for `createRenderer`. `detectWebGpuSupport`, `environmentRegistry`,
 * `lutRegistry`, `textRenderRegistry`, `textureRegistry`,
 * `videoFrameRegistry`, `satoriLayerRenderRegistry`, and `modelRegistry` are
 * the seams a consumer outside this package has a legitimate reason to
 * override: `environmentRegistry` resolves a `Composition.environment.envMapRef`
 * beyond the two built-in procedural refs (`"studio"`/`"outdoor"`) - a real
 * uploaded HDR environment, decoded via `parseHdrEnvironment`/
 * `loadHdrEnvironment` in this same package, needs a caller to populate one
 * ahead of time; `lutRegistry` is the same story for a `LutEffectConfig.lutRef`
 * beyond the three built-in procedural looks (`"warm"`/`"tealOrange"`/
 * `"filmStock"`) via `parseCubeLut`/`loadLutFromCube`; `textRenderRegistry`
 * is required for any `TextNode` to render at all (see `TextRenderRegistry`'s
 * own doc - with none supplied, `buildTextObject` resolves every text node to
 * an empty, glyph-less group rather than throwing, so this stays optional
 * here too, matching that same "not yet loaded is an expected runtime state"
 * contract); `textureRegistry` is the same story for an `ImageNode`'s own
 * `assetRef` (see `TextureRegistry`'s own doc - with none supplied, every
 * image renders as its documented gray placeholder plane); `videoFrameRegistry`
 * is the same story again for a `VideoNode`'s own current frame (see
 * `VideoFrameRegistry`'s own doc - with none supplied, every video renders
 * as its documented placeholder plane); `satoriLayerRenderRegistry` is the
 * same story for a `SatoriNode`'s own rasterized pixels (see
 * `SatoriLayerRenderRegistry`'s own doc - with none supplied, every satori
 * layer renders as an empty group); `modelRegistry` is the same story for a
 * `ModelNode`'s own loaded GLTF/GLB (see `ModelRegistry`'s own doc - with
 * none supplied - the same as this function's own default, below - every
 * model renders as an empty group too). Swapping the underlying Three.js
 * renderer construction itself is an internal testing seam (see
 * `ThreeRendererDependencies` in `./three-renderer.ts`), not part of the
 * public surface, since exposing it would mean exposing Three.js-shaped
 * types here too.
 */
export interface CreateRendererOptions {
  detectWebGpuSupport?: WebGpuDetector;
  environmentRegistry?: EnvironmentRegistry;
  lutRegistry?: LutRegistry;
  textRenderRegistry?: TextRenderRegistry;
  textureRegistry?: TextureRegistry;
  videoFrameRegistry?: VideoFrameRegistry;
  satoriLayerRenderRegistry?: SatoriLayerRenderRegistry;
  modelRegistry?: ModelRegistry;
}

/**
 * Creates a `Renderer`. With no `options`, constructs one backed by real
 * Three.js, selecting WebGPU when available and falling back to WebGL2
 * otherwise, and with no `TextRenderRegistry`/`TextureRegistry`/
 * `VideoFrameRegistry`/`SatoriLayerRenderRegistry`, the two/three built-in
 * procedural `EnvironmentRegistry`/`LutRegistry` refs only, and an empty
 * `ModelRegistry` (so every `TextNode`/`ImageNode`/`VideoNode`/`SatoriNode`/
 * `ModelNode` renders as its own documented placeholder, and only the
 * built-in `envMapRef`/`lutRef` names resolve - see `CreateRendererOptions`'
 * own doc).
 *
 * `ThreeRenderer`'s constructor takes `textRenderRegistry`/
 * `satoriLayerRenderRegistry`/`textureRegistry`/`videoFrameRegistry` as
 * positional arguments after `environmentRegistry`/`lutRegistry`/
 * `modelRegistry`, so passing any one of them here means passing every one
 * of those three explicitly too (matching their own constructor defaults)
 * rather than only the trailing ones this function actually wants to
 * override.
 */
export function createRenderer(options?: CreateRendererOptions): Renderer {
  const deps = {
    ...defaultThreeRendererDependencies,
    ...(options?.detectWebGpuSupport ? { detectWebGpuSupport: options.detectWebGpuSupport } : {}),
  };

  if (
    options?.environmentRegistry === undefined &&
    options?.lutRegistry === undefined &&
    options?.textRenderRegistry === undefined &&
    options?.textureRegistry === undefined &&
    options?.videoFrameRegistry === undefined &&
    options?.satoriLayerRenderRegistry === undefined &&
    options?.modelRegistry === undefined
  ) {
    return new ThreeRenderer(deps);
  }

  return new ThreeRenderer(
    deps,
    options.environmentRegistry ?? createDefaultEnvironmentRegistry(),
    options.lutRegistry ?? createDefaultLutRegistry(),
    options.modelRegistry ?? createDefaultModelRegistry(),
    options.textRenderRegistry,
    options.satoriLayerRenderRegistry,
    options.textureRegistry,
    options.videoFrameRegistry,
  );
}
