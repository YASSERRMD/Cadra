/**
 * The buffer-source `VideoFrame` constructor overload only (not the
 * canvas-source one): `captureFrames` builds every `VideoFrame` from a
 * `PixelBuffer`'s already-read-back `Uint8ClampedArray`, never from a
 * canvas/GPU reference, so this is the only overload this module ever
 * needs.
 */
export type VideoFrameConstructor = new (
  data: AllowSharedBufferSource,
  init: VideoFrameBufferInit,
) => VideoFrame;

/**
 * Real global `VideoFrame`, used as `createVideoFrame`'s default. This
 * Node/Vitest environment has no global `VideoFrame` at all, so this is
 * only ever exercised in a real WebCodecs-capable environment (a browser or
 * a worker); tests inject a fake constructor instead (see
 * `detectWebCodecsSupport`'s doc for the matching feature-detection seam).
 */
export function getGlobalVideoFrameConstructor(): VideoFrameConstructor | undefined {
  return typeof VideoFrame === "undefined" ? undefined : VideoFrame;
}

/**
 * Feature-detects WebCodecs `VideoFrame` availability. Guarded with
 * `typeof` (never a bare reference) since referencing an undeclared global
 * directly throws a `ReferenceError` in an environment that lacks it
 * entirely, matching `detectOffscreenCanvasSupport`'s
 * (`@cadra/renderer/src/worker/offscreen-detection.ts`) same guard style.
 *
 * Injectable (see `WebCodecsDetector`) so `captureFrames` can be driven down
 * either branch in tests without a real (or globally stubbed) `VideoFrame`.
 */
export function detectWebCodecsSupport(): boolean {
  return typeof VideoFrame !== "undefined";
}

/**
 * Signature of `detectWebCodecsSupport`, injectable so tests can force
 * either branch of `captureFrames`'s VideoFrame-vs-fallback selection.
 */
export type WebCodecsDetector = () => boolean;
