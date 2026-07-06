/**
 * Feature-detects whether this environment can hand a canvas's rendering
 * control off to a worker: both `OffscreenCanvas` itself and
 * `HTMLCanvasElement.prototype.transferControlToOffscreen` must exist.
 * Neither is guaranteed even when the other is (an environment could
 * polyfill one without the other), and this Node/Vitest environment has
 * neither, so both checks must pass, not just one.
 *
 * Guarded the same way `detectWebGpuSupport` guards `navigator` (see
 * `../capability-detection.ts`): referencing an undeclared global directly
 * would throw a `ReferenceError` in an environment that lacks it entirely,
 * so every check goes through `typeof`.
 */
export function detectOffscreenCanvasSupport(): boolean {
  if (typeof OffscreenCanvas === "undefined") {
    return false;
  }
  if (typeof HTMLCanvasElement === "undefined") {
    return false;
  }
  return typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function";
}

/**
 * Signature of `detectOffscreenCanvasSupport`, injectable so tests can force
 * either branch of `createBestAvailableRenderer`'s renderer selection
 * without a real (or fake) `OffscreenCanvas`/`transferControlToOffscreen`.
 */
export type OffscreenCanvasDetector = () => boolean;
