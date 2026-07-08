import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import { denoisePathTracedResult } from "./denoise-path-traced-result.js";
import type { DenoiserLike } from "./denoiser-like.js";
import type { PathTracedFrameResult } from "./render-path-traced-frame.js";

/** A minimal fake standing in for a real denoiser: records calls, touches no GPU. */
function createFakeDenoiser(): DenoiserLike & { denoise: ReturnType<typeof vi.fn> } {
  const denoisedTarget = new THREE.WebGLRenderTarget(1, 1);
  return {
    denoise: vi.fn(() => denoisedTarget),
    dispose: vi.fn(),
  };
}

describe("denoisePathTracedResult", () => {
  it("replaces target with the denoiser's own output", () => {
    const denoiser = createFakeDenoiser();
    const result: PathTracedFrameResult = { target: new THREE.WebGLRenderTarget(4, 4), samples: 64 };

    const denoised = denoisePathTracedResult(denoiser, result);

    expect(denoiser.denoise).toHaveBeenCalledOnce();
    expect(denoiser.denoise).toHaveBeenCalledWith(result.target);
    expect(denoised.target).toBe(denoiser.denoise.mock.results[0]?.value);
  });

  it("passes samples through unchanged: denoising is a post-process, not part of accumulation", () => {
    const denoiser = createFakeDenoiser();
    const result: PathTracedFrameResult = { target: new THREE.WebGLRenderTarget(4, 4), samples: 128 };

    const denoised = denoisePathTracedResult(denoiser, result);

    expect(denoised.samples).toBe(128);
  });

  it("is deterministic: the same result denoised twice calls the denoiser identically both times", () => {
    const denoiser = createFakeDenoiser();
    const result: PathTracedFrameResult = { target: new THREE.WebGLRenderTarget(4, 4), samples: 64 };

    denoisePathTracedResult(denoiser, result);
    denoisePathTracedResult(denoiser, result);

    expect(denoiser.denoise).toHaveBeenNthCalledWith(1, result.target);
    expect(denoiser.denoise).toHaveBeenNthCalledWith(2, result.target);
  });
});
