/**
 * One variation axis a variable font exposes (e.g. weight, width, slant),
 * as declared in the font's `fvar` table.
 */
export interface VariationAxis {
  /** Four-letter axis tag, e.g. "wght", "wdth", "slnt". */
  tag: string;
  /** Human-readable axis name from the font's `name` table. */
  name: string;
  min: number;
  default: number;
  max: number;
}

/**
 * One named variation instance the font designer predefined (e.g. "Bold
 * Condensed"), as a fixed set of axis-tag to value coordinates.
 */
export interface NamedInstance {
  name: string;
  coordinates: Readonly<Record<string, number>>;
}

/** Clamps `value` to an axis's declared min/max range. */
export function clampToAxisRange(axis: VariationAxis, value: number): number {
  return Math.max(axis.min, Math.min(axis.max, value));
}

/** Finds a named instance by name, case-sensitive exact match. */
export function findNamedInstance(
  instances: readonly NamedInstance[],
  name: string,
): NamedInstance | undefined {
  return instances.find((instance) => instance.name === name);
}
