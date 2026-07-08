import type { CompositionColorGrading, PathTracingConfig } from "@cadra/core";
import type { DenoiserLike, WebGLPathTracerLike } from "@cadra/pathtracer";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import type { RenderSize } from "../renderer.js";
import {
  createPathTracedFrameRenderer,
  type OutputConversion,
  type PathTracedFrameRendererDependencies,
} from "./path-traced-frame-renderer.js";

const size: RenderSize = { width: 4, height: 4 };

/** A minimal fake standing in for the dedicated `THREE.WebGLRenderer`: records calls, touches no GPU. */
function createFakeRenderer() {
  const fake = {
    toneMappingExposure: 1,
    getRenderTarget: vi.fn(() => null),
    setRenderTarget: vi.fn(),
    readRenderTargetPixelsAsync: vi.fn(async (_target: unknown, _x: number, _y: number, _w: number, _h: number, buffer: Uint8Array) => {
      buffer.fill(128);
      return buffer;
    }),
    dispose: vi.fn(),
  };
  return fake as unknown as THREE.WebGLRenderer & typeof fake;
}

/** A minimal fake standing in for a real `WebGLPathTracer`: records calls, touches no GPU. */
function createFakePathTracer(): WebGLPathTracerLike {
  return {
    samples: 0,
    target: new THREE.WebGLRenderTarget(size.width, size.height),
    bounces: 5,
    setSceneAsync: vi.fn().mockResolvedValue(undefined),
    renderSample: vi.fn(),
    dispose: vi.fn(),
  };
}

/** A minimal fake standing in for a real denoiser: records calls, touches no GPU. */
function createFakeDenoiser(): DenoiserLike & { denoise: ReturnType<typeof vi.fn> } {
  const denoisedTarget = new THREE.WebGLRenderTarget(size.width, size.height);
  return {
    denoise: vi.fn(() => denoisedTarget),
    dispose: vi.fn(),
  };
}

/** A minimal fake standing in for the real `OutputPass`-based conversion: records calls, touches no GPU. */
function createFakeOutputConversion(): OutputConversion & { convert: ReturnType<typeof vi.fn> } {
  return {
    convert: vi.fn(),
    dispose: vi.fn(),
  };
}

function createFakeDeps(): {
  deps: PathTracedFrameRendererDependencies;
  renderer: ReturnType<typeof createFakeRenderer>;
  pathTracer: WebGLPathTracerLike;
  denoiser: ReturnType<typeof createFakeDenoiser>;
  outputConversion: ReturnType<typeof createFakeOutputConversion>;
} {
  const renderer = createFakeRenderer();
  const pathTracer = createFakePathTracer();
  const denoiser = createFakeDenoiser();
  const outputConversion = createFakeOutputConversion();
  const deps: PathTracedFrameRendererDependencies = {
    createRenderer: () => renderer,
    createPathTracer: () => pathTracer,
    createDenoiser: () => denoiser,
    createOutputConversion: () => outputConversion,
  };
  return { deps, renderer, pathTracer, denoiser, outputConversion };
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();

describe("createPathTracedFrameRenderer", () => {
  it("constructs every dependency exactly once, reused across render() calls", () => {
    const { deps } = createFakeDeps();
    const createRenderer = vi.fn(deps.createRenderer);
    const createPathTracer = vi.fn(deps.createPathTracer);

    createPathTracedFrameRenderer(size, { ...deps, createRenderer, createPathTracer });

    expect(createRenderer).toHaveBeenCalledOnce();
    expect(createPathTracer).toHaveBeenCalledOnce();
  });

  it("sets toneMappingExposure from the composition's own exposureStops before sampling", async () => {
    const { deps, renderer } = createFakeDeps();
    const pathTracedFrameRenderer = createPathTracedFrameRenderer(size, deps);
    const colorGrading: CompositionColorGrading = { exposureStops: 2 };

    await pathTracedFrameRenderer.render(scene, camera, colorGrading, undefined);

    expect(renderer.toneMappingExposure).toBe(4);
  });

  it("runs the output-conversion pass (not the denoiser) when denoise is not requested", async () => {
    const { deps, denoiser, outputConversion } = createFakeDeps();
    const pathTracedFrameRenderer = createPathTracedFrameRenderer(size, deps);

    await pathTracedFrameRenderer.render(scene, camera, undefined, undefined);

    expect(outputConversion.convert).toHaveBeenCalledOnce();
    expect(denoiser.denoise).not.toHaveBeenCalled();
  });

  it("runs the denoiser (not the output-conversion pass) when denoise is requested", async () => {
    const { deps, denoiser, outputConversion } = createFakeDeps();
    const pathTracedFrameRenderer = createPathTracedFrameRenderer(size, deps);
    const config: PathTracingConfig = { denoise: true, samples: 4 };

    await pathTracedFrameRenderer.render(scene, camera, undefined, config);

    expect(denoiser.denoise).toHaveBeenCalledOnce();
    expect(outputConversion.convert).not.toHaveBeenCalled();
  });

  it("reads back exactly size.width * size.height * 4 bytes and returns them as a PixelBuffer", async () => {
    const { deps } = createFakeDeps();
    const pathTracedFrameRenderer = createPathTracedFrameRenderer(size, deps);

    const result = await pathTracedFrameRenderer.render(scene, camera, undefined, undefined);

    expect(result.width).toBe(size.width);
    expect(result.height).toBe(size.height);
    expect(result.data.length).toBe(size.width * size.height * 4);
  });

  it("shares scene and camera directly with the path tracer", async () => {
    const { deps, pathTracer } = createFakeDeps();
    const pathTracedFrameRenderer = createPathTracedFrameRenderer(size, deps);

    await pathTracedFrameRenderer.render(scene, camera, undefined, undefined);

    expect(pathTracer.setSceneAsync).toHaveBeenCalledWith(scene, camera);
  });

  it("dispose() frees every owned dependency", () => {
    const { deps, renderer, pathTracer, denoiser, outputConversion } = createFakeDeps();
    const pathTracedFrameRenderer = createPathTracedFrameRenderer(size, deps);

    pathTracedFrameRenderer.dispose();

    expect(pathTracer.dispose).toHaveBeenCalledOnce();
    expect(denoiser.dispose).toHaveBeenCalledOnce();
    expect(outputConversion.dispose).toHaveBeenCalledOnce();
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });
});
