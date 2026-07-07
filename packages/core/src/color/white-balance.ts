/** A per-channel multiplicative gain, applied in linear light, that corrects a render for an assumed scene illuminant color temperature and green-magenta tint. */
export type WhiteBalanceGain = readonly [r: number, g: number, b: number];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * The approximate RGB color of a blackbody radiator at `temperatureK`
 * Kelvin (valid roughly 1000K-40000K, clamped outside that range), via
 * Tanner Helland's widely-used polynomial/logarithmic fit of the Planckian
 * locus - a deliberately simplified, non-scientifically-precise
 * approximation (a full CIE chromaticity calculation is unnecessary for an
 * artistic white-balance control), each channel clamped to `[0, 1]`.
 */
function approximateBlackbodyColor(temperatureK: number): readonly [number, number, number] {
  const t = clamp(temperatureK, 1000, 40000) / 100;

  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;

  return [clamp(r, 0, 255) / 255, clamp(g, 0, 255) / 255, clamp(b, 0, 255) / 255];
}

/**
 * Computes the linear-light RGB gain that corrects a render for a scene lit
 * by an illuminant of `temperatureK` Kelvin, with an additional `tint`
 * (green-magenta) fine adjustment.
 *
 * The gain is the illuminant's own color, inverted and normalized so the
 * neutral (equal R/G/B) axis is preserved - an already-neutral illuminant
 * gives an average-preserving no-op-ish gain rather than darkening or
 * brightening the whole image as a side effect of the correction. `6500`
 * (standard daylight, the sRGB/D65 reference white) is approximately this
 * formula's own neutral point (`(1, 1, 1)` gain, within about 1%) - not
 * exactly the reference `6500`, since this formula's own zero point falls
 * at `6600`, an inherent, acceptably small imprecision of the simplified
 * approximation it is built on, not a bug.
 *
 * `tint` (roughly `-1`, green, to `1`, magenta) is applied as a direct,
 * separate green-channel multiplier on top of the temperature-derived
 * gain, matching how camera raw / Lightroom's own Temperature and Tint
 * sliders are two independent axes rather than one combined correction:
 * positive tint *reduces* the green gain (shifting the corrected output
 * toward magenta), negative tint increases it (toward green).
 */
export function computeWhiteBalanceGain(temperatureK: number, tint: number): WhiteBalanceGain {
  const [illumR, illumG, illumB] = approximateBlackbodyColor(temperatureK);
  const average = (illumR + illumG + illumB) / 3;

  const r = average / illumR;
  const g = (average / illumG) * (1 - tint * 0.5);
  const b = average / illumB;
  return [r, g, b];
}
