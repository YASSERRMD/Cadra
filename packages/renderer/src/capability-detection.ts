/**
 * Feature-detects WebGPU availability by checking for `navigator.gpu`.
 *
 * Guarded on two levels: `navigator` itself may not exist at all (e.g. some
 * non-browser test/build environments), and even when it exists, `gpu` is
 * only present in WebGPU-capable browsers. Neither absence should throw;
 * both simply mean "not available".
 *
 * Exported as a standalone function (rather than inlined into the renderer)
 * so it can be swapped for a fake in tests: see `WebGpuDetector` below.
 */
export function detectWebGpuSupport(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
}

/**
 * Signature of `detectWebGpuSupport`, injectable so tests can force either
 * branch of backend selection without a real (or fake) `navigator.gpu`.
 */
export type WebGpuDetector = () => boolean;
