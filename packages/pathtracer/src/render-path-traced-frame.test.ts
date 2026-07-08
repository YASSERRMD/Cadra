import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import { renderPathTracedFrame } from "./render-path-traced-frame.js";
import type { ResolvedPathTracingConfig } from "./sample-budget.js";

/** A minimal fake standing in for a real `WebGLPathTracer`: records calls, touches no GPU. */
function createFakePathTracer() {
  const target = new THREE.WebGLRenderTarget(1, 1);
  const fake = {
    samples: 0,
    target,
    bounces: 5,
    setSceneAsync: vi.fn().mockResolvedValue(undefined),
    renderSample: vi.fn(() => {
      fake.samples += 1;
    }),
    dispose: vi.fn(),
  };
  return fake;
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();

const config: ResolvedPathTracingConfig = { tier: "final", samples: 4, bounces: 3 };

describe("renderPathTracedFrame", () => {
  it("shares scene and camera directly with the path tracer via setSceneAsync", async () => {
    const pathTracer = createFakePathTracer();

    await renderPathTracedFrame(pathTracer, scene, camera, config);

    expect(pathTracer.setSceneAsync).toHaveBeenCalledOnce();
    expect(pathTracer.setSceneAsync).toHaveBeenCalledWith(scene, camera);
  });

  it("applies the resolved bounces before rendering", async () => {
    const pathTracer = createFakePathTracer();

    await renderPathTracedFrame(pathTracer, scene, camera, config);

    expect(pathTracer.bounces).toBe(3);
  });

  it("accumulates exactly config.samples samples, one renderSample() call per sample", async () => {
    const pathTracer = createFakePathTracer();

    await renderPathTracedFrame(pathTracer, scene, camera, config);

    expect(pathTracer.renderSample).toHaveBeenCalledTimes(4);
  });

  it("calls setSceneAsync before any renderSample() call", async () => {
    const pathTracer = createFakePathTracer();
    const order: string[] = [];
    pathTracer.setSceneAsync.mockImplementation(async () => {
      order.push("setSceneAsync");
    });
    pathTracer.renderSample.mockImplementation(() => {
      order.push("renderSample");
    });

    await renderPathTracedFrame(pathTracer, scene, camera, config);

    expect(order).toEqual(["setSceneAsync", "renderSample", "renderSample", "renderSample", "renderSample"]);
  });

  it("returns the path tracer's own target and final sample count", async () => {
    const pathTracer = createFakePathTracer();

    const result = await renderPathTracedFrame(pathTracer, scene, camera, config);

    expect(result.target).toBe(pathTracer.target);
    expect(result.samples).toBe(4);
  });

  it("renders zero samples without error when config.samples is 0", async () => {
    const pathTracer = createFakePathTracer();

    const result = await renderPathTracedFrame(pathTracer, scene, camera, { ...config, samples: 0 });

    expect(pathTracer.renderSample).not.toHaveBeenCalled();
    expect(result.samples).toBe(0);
  });
});
