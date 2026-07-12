import { createDefaultModelRegistry } from "./assets/model-registry.js";
import type { WebGpuDetector } from "./capability-detection.js";
import { createDefaultEnvironmentRegistry } from "./environment/environment-registry.js";
import { createDefaultLutRegistry } from "./lut/lut-registry.js";
import type { TextureRegistry } from "./reconciler/registries.js";
import type { Renderer } from "./renderer.js";
import type { TextRenderRegistry } from "./text/text-render-registry.js";
import { defaultThreeRendererDependencies, ThreeRenderer } from "./three-renderer.js";

/**
 * Options for `createRenderer`. `detectWebGpuSupport`, `textRenderRegistry`,
 * and `textureRegistry` are the seams a consumer outside this package has a
 * legitimate reason to override: `textRenderRegistry` is required for any
 * `TextNode` to render at all (see `TextRenderRegistry`'s own doc - with
 * none supplied, `buildTextObject` resolves every text node to an empty,
 * glyph-less group rather than throwing, so this stays optional here too,
 * matching that same "not yet loaded is an expected runtime state"
 * contract); `textureRegistry` is the same story for an `ImageNode`'s own
 * `assetRef` (see `TextureRegistry`'s own doc - with none supplied, every
 * image renders as its documented gray placeholder plane). Swapping the
 * underlying Three.js renderer construction itself is an internal testing
 * seam (see `ThreeRendererDependencies` in `./three-renderer.ts`), not part
 * of the public surface, since exposing it would mean exposing
 * Three.js-shaped types here too.
 */
export interface CreateRendererOptions {
  detectWebGpuSupport?: WebGpuDetector;
  textRenderRegistry?: TextRenderRegistry;
  textureRegistry?: TextureRegistry;
}

/**
 * Creates a `Renderer`. With no `options`, constructs one backed by real
 * Three.js, selecting WebGPU when available and falling back to WebGL2
 * otherwise, and with no `TextRenderRegistry`/`TextureRegistry` (so every
 * `TextNode`/`ImageNode` renders as its own documented placeholder - see
 * `CreateRendererOptions`' own doc).
 *
 * `ThreeRenderer`'s constructor takes `textRenderRegistry`/`textureRegistry`
 * as positional arguments after `environmentRegistry`/`lutRegistry`/
 * `modelRegistry`, so passing either here means passing every one of those
 * three explicitly too (matching their own constructor defaults) rather
 * than only the trailing ones this function actually wants to override.
 */
export function createRenderer(options?: CreateRendererOptions): Renderer {
  const deps = {
    ...defaultThreeRendererDependencies,
    ...(options?.detectWebGpuSupport ? { detectWebGpuSupport: options.detectWebGpuSupport } : {}),
  };

  if (options?.textRenderRegistry === undefined && options?.textureRegistry === undefined) {
    return new ThreeRenderer(deps);
  }

  return new ThreeRenderer(
    deps,
    createDefaultEnvironmentRegistry(),
    createDefaultLutRegistry(),
    createDefaultModelRegistry(),
    options.textRenderRegistry,
    undefined,
    options.textureRegistry,
  );
}
