/**
 * Converts a shutter angle in degrees into the fraction `motionBlur`'s own
 * `velocity` argument needs to be scaled by. `VelocityNode` (see
 * `post-processing-pipeline.ts`'s own `applyWebGpuEffect`) computes an
 * NDC-space (`-1` to `1`) delta covering the whole frame interval - a
 * `360`-degree shutter, in cinematography terms, exposing the entire
 * interval. `shutterAngle / 360` scales that down to the fraction of the
 * frame interval the configured shutter actually exposes; the extra `/ 2`
 * converts from NDC-space (a `2`-wide range) to UV-space (a `1`-wide range,
 * the space `uv()` and therefore `motionBlur`'s own sampling operates in).
 */
export function computeMotionBlurVelocityScale(shutterAngle: number): number {
  return shutterAngle / 360 / 2;
}
