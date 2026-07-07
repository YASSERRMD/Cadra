/**
 * Converts an authored exposure adjustment in photographic stops (each `+1`
 * doubles scene brightness, each `-1` halves it - the same convention a
 * real camera's exposure compensation dial uses) into the linear
 * multiplier a renderer's own tone-mapping exposure expects. `0` stops
 * (the default) gives an identity multiplier of `1`.
 */
export function resolveExposureMultiplier(stops: number): number {
  return Math.pow(2, stops);
}
