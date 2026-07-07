import type { ContentHash } from "@cadra/core";

import type { FontMetrics } from "./font-metrics.js";
import type { NamedInstance, VariationAxis } from "./variable-font.js";

/**
 * Which library actually parsed a font. `"fontkit"` is the authoritative
 * backend (real variable-font instancing via `gvar` interpolation, full
 * metrics, named instances) and is Node-only; `"opentype"` is a lightweight
 * universal backend (works in a browser bundle too, e.g. inside the headless
 * render page) used where fontkit's Node-native footprint does not run.
 * Both backends produce this same `ParsedFont` shape so downstream code
 * (layout, shaping, atlas generation) never needs to know which parsed it.
 */
export type FontParseBackend = "fontkit" | "opentype";

/**
 * The unified, backend-agnostic result of parsing one font file: real
 * outlines-backing metadata (not a canvas font string), deterministic given
 * the same input bytes.
 */
export interface ParsedFont {
  readonly backend: FontParseBackend;
  /** The exact bytes this font was parsed from. */
  readonly bytes: Uint8Array;
  /** Content hash of `bytes`, used as this font's registry key. */
  readonly contentHash: ContentHash;
  readonly familyName: string;
  readonly subfamilyName: string;
  readonly metrics: FontMetrics;
  /** Empty for a static (non-variable) font. */
  readonly variationAxes: readonly VariationAxis[];
  /** Empty for a static font, or for a variable font with no named instances. */
  readonly namedInstances: readonly NamedInstance[];
  /** Every Unicode code point this font has a glyph for. */
  readonly characterSet: ReadonlySet<number>;
  /** OpenType feature tags this font supports (e.g. "kern", "liga", "calt"). */
  readonly availableFeatures: readonly string[];
  /**
   * Set only when this `ParsedFont` is a variable-font instance pinned to
   * specific axis coordinates (see `resolveFontVariationInstance`).
   * Undefined for the font's own default state.
   */
  readonly variationCoordinates?: Readonly<Record<string, number>>;
}
