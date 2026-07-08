import type { CompositionColorGrading, PathTracingConfig } from "@cadra/core";
import { resolveExposureMultiplier } from "@cadra/core";
import {
  type CreateDenoiser,
  type CreatePathTracer,
  defaultCreateDenoiser,
  defaultCreatePathTracer,
  denoisePathTracedResult,
  renderPathTracedFrame,
  resolvePathTracingConfig,
} from "@cadra/pathtracer";
import * as THREE from "three";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

import type { PixelBuffer } from "../pixel-readable-renderer.js";
import type { RenderSize } from "../renderer.js";
import { flipPixelBufferRows } from "./flip-pixel-buffer-rows.js";

/**
 * Renders one path-traced final frame from a live raster scene graph
 * (`scene`/`camera`, already reconciled - materials, lights, and white
 * balance already baked in exactly as the raster path left them) and reads
 * its own accumulated, display-ready pixels back directly.
 *
 * Deliberately entirely independent of whatever backend/canvas the raster
 * renderer uses: `three-gpu-pathtracer`'s `WebGLPathTracer` requires a
 * concrete `THREE.WebGLRenderer` (verified against its own `.d.ts`), which
 * this engine's raster renderer is not guaranteed to be (WebGPU is its
 * preferred backend). Owning a fully separate `WebGLRenderer` here means a
 * composition's `renderMode: "pathTraced"` never has to change the raster
 * renderer's own backend selection.
 */
export interface PathTracedFrameRenderer {
  render(
    scene: THREE.Scene,
    camera: THREE.Camera,
    colorGrading: CompositionColorGrading | undefined,
    config: PathTracingConfig | undefined,
  ): Promise<PixelBuffer>;
  /** Frees every GPU resource this instance owns: the dedicated renderer, the path tracer, the denoiser, and the output-conversion pass. */
  dispose(): void;
}

/**
 * Converts a linear HDR render target into a tone-mapped, color-space
 * converted, display-ready one - `three-gpu-pathtracer`'s own
 * `WebGLPathTracer.target` accumulates in a floating-point HDR format
 * (verified against `PathTracingRenderer.js`'s own `WebGLRenderTarget`
 * construction: `type: FloatType`), so reading it back directly (without
 * this step) would produce raw linear values, not the tone-mapped image the
 * raster path always produces.
 */
export interface OutputConversion {
  /** Tone-maps and color-space-converts `source` into `target`, using `renderer`'s own live `toneMapping`/`toneMappingExposure`/`outputColorSpace`. */
  convert(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, source: THREE.WebGLRenderTarget): void;
  dispose(): void;
}

export type CreateOutputConversion = () => OutputConversion;

/**
 * The same `OutputPass` tool `post-processing-pipeline.ts` already uses for
 * the raster path's own tone-map/colorspace step, called directly (not via
 * an `EffectComposer`, which `OutputPass.render`'s own signature does not
 * require): it reads `renderer.toneMapping`/`.toneMappingExposure`/
 * `.outputColorSpace` fresh every call.
 */
export const defaultCreateOutputConversion: CreateOutputConversion = () => {
  const outputPass = new OutputPass();
  return {
    convert(renderer, target, source) {
      const previousTarget = renderer.getRenderTarget();
      // `deltaTime`/`maskActive` are declared required by `Pass.render`'s
      // own type but unused by `OutputPass`'s actual implementation (its
      // own source takes them as commented-out parameters) - `0`/`false`
      // are inert placeholders, not meaningful values.
      outputPass.render(renderer, target, source, 0, false);
      renderer.setRenderTarget(previousTarget);
    },
    dispose() {
      outputPass.dispose();
    },
  };
};

/** Everything about how a `PathTracedFrameRenderer` reaches into Three.js/`@cadra/pathtracer` is injectable, so unit tests can substitute fakes and never touch a real GPU. */
export interface PathTracedFrameRendererDependencies {
  createRenderer: (size: RenderSize) => THREE.WebGLRenderer;
  createPathTracer: CreatePathTracer;
  createDenoiser: CreateDenoiser;
  createOutputConversion: CreateOutputConversion;
}

/**
 * A dedicated `WebGLRenderer` with no canvas of its own (Three.js creates
 * one internally): this renderer never appears on screen and is read back
 * via `readRenderTargetPixelsAsync` only. Exactly like `ThreeRenderer`'s own
 * `applyColorWorkflowDefaults`, this sets `ACESFilmicToneMapping` and
 * `SRGBColorSpace` so a path-traced final tone-maps identically to the
 * raster path it is meant to be a physically-correct upgrade of.
 */
const defaultCreateRenderer: PathTracedFrameRendererDependencies["createRenderer"] = (size) => {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(size.width, size.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  return renderer;
};

export const defaultPathTracedFrameRendererDependencies: PathTracedFrameRendererDependencies = {
  createRenderer: defaultCreateRenderer,
  createPathTracer: defaultCreatePathTracer,
  createDenoiser: defaultCreateDenoiser,
  createOutputConversion: defaultCreateOutputConversion,
};

/**
 * Constructs a `PathTracedFrameRenderer` at a fixed `size` (a composition's
 * own output resolution, fixed for its entire length, exactly like
 * `colorGrading`/`renderMode` themselves). Every dependency this owns
 * (renderer, path tracer, denoiser, output-conversion pass) is constructed
 * once here and reused across every `render()` call, mirroring how
 * `ThreeRenderer` itself is constructed once via `init()` and reused across
 * every `renderFrame()` call.
 */
export function createPathTracedFrameRenderer(
  size: RenderSize,
  deps: PathTracedFrameRendererDependencies = defaultPathTracedFrameRendererDependencies,
): PathTracedFrameRenderer {
  const renderer = deps.createRenderer(size);
  const pathTracer = deps.createPathTracer(renderer);
  const denoiser = deps.createDenoiser(renderer);
  // Only used when `denoise` is false: `denoisePathTracedResult`'s own
  // `DenoiseMaterial` shader already includes Three.js's standard
  // tonemapping/colorspace shader chunks (verified directly against its
  // source), so a denoised result is already display-ready.
  const outputConversion = deps.createOutputConversion();
  const outputTarget = new THREE.WebGLRenderTarget(size.width, size.height);

  const readback = new Uint8Array(size.width * size.height * 4);

  async function render(
    scene: THREE.Scene,
    camera: THREE.Camera,
    colorGrading: CompositionColorGrading | undefined,
    config: PathTracingConfig | undefined,
  ): Promise<PixelBuffer> {
    renderer.toneMappingExposure = resolveExposureMultiplier(colorGrading?.exposureStops ?? 0);

    const resolvedConfig = resolvePathTracingConfig(config);
    const sampled = await renderPathTracedFrame(pathTracer, scene, camera, resolvedConfig);

    let finalTarget: THREE.WebGLRenderTarget;
    if (resolvedConfig.denoise) {
      finalTarget = denoisePathTracedResult(denoiser, sampled).target;
    } else {
      outputConversion.convert(renderer, outputTarget, sampled.target);
      finalTarget = outputTarget;
    }

    await renderer.readRenderTargetPixelsAsync(finalTarget, 0, 0, size.width, size.height, readback);

    // WebGL's own readback convention is bottom-to-top; `PixelBuffer`
    // documents top-left origin (matching `createRealReadPixels`'s
    // canvas-based readback, whose `drawImage`/`getImageData` already
    // present a WebGL canvas top-left-origin regardless of its own
    // internal row order).
    return { width: size.width, height: size.height, data: flipPixelBufferRows(readback, size.width, size.height) };
  }

  function dispose(): void {
    pathTracer.dispose();
    denoiser.dispose();
    outputConversion.dispose();
    outputTarget.dispose();
    renderer.dispose();
  }

  return { render, dispose };
}

/** Constructs a `PathTracedFrameRenderer` for a given output `size`. */
export type CreatePathTracedFrameRenderer = (size: RenderSize) => PathTracedFrameRenderer;

/** The dependency callers use when no override is supplied. */
export const defaultCreatePathTracedFrameRenderer: CreatePathTracedFrameRenderer = (size) =>
  createPathTracedFrameRenderer(size);
