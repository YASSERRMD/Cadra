import { resolveBidi, type TextDirection } from "./bidi-resolution.js";
import { shapeRun } from "./harfbuzz-shaping.js";
import type { ParsedFont } from "./parsed-font.js";
import { computeItemizedRuns } from "./script-runs.js";
import { unicodeScriptToIso15924 } from "./script-tags.js";
import type { ShapedTextRun } from "./shaped-run.js";
import { reorderRunsToVisualOrder } from "./visual-run-order.js";

/** Options for `shapeText`, applied uniformly to every itemized run it shapes. */
export interface ShapeTextOptions {
  /** Forces the paragraph's base direction instead of auto-detecting it from the text's first strong character. */
  direction?: TextDirection;
  /** BCP-47-ish language tag passed through to HarfBuzz for every run. */
  language?: string;
  /** OpenType feature toggles (e.g. `{ kern: true, liga: true }`) applied to every run. */
  features?: Readonly<Record<string, boolean>>;
}

/**
 * Shapes a full string of (possibly mixed-script, mixed-direction) text:
 * resolves Unicode bidi embedding levels, itemizes into single-script
 * single-direction runs, shapes each with HarfBuzz, and returns the runs
 * in visual (left-to-right on the page) order. Each returned run's glyph
 * `cluster` values are rebased to index into the original `text`, so
 * callers never need to know about the internal per-run substrings.
 *
 * Mirroring (e.g. "(" rendering as ")" inside a right-to-left run) is not
 * applied here at the character level: HarfBuzz already performs it
 * internally, keyed off each run's own `direction` (verified empirically;
 * pre-mirroring characters ourselves here as well as passing the correct
 * per-run direction double-mirrors them back to the wrong glyph). Use
 * `resolveBidi`'s own `mirroredCharacters` directly if some other consumer
 * (e.g. caret placement) needs to know which characters are mirrored
 * without shaping.
 */
export function shapeText(
  font: ParsedFont,
  text: string,
  options: ShapeTextOptions = {},
): ShapedTextRun[] {
  const bidiResolution = resolveBidi(text, options.direction);
  const logicalRuns = computeItemizedRuns(text, bidiResolution.levels);
  const visualRuns = reorderRunsToVisualOrder(logicalRuns);

  return visualRuns.map((run) => {
    const runText = text.slice(run.start, run.end);
    const glyphs = shapeRun(font, runText, {
      script: unicodeScriptToIso15924(run.script),
      direction: run.direction,
      language: options.language,
      features: options.features,
    }).map((glyph) => ({ ...glyph, cluster: glyph.cluster + run.start }));

    return {
      start: run.start,
      end: run.end,
      script: run.script,
      direction: run.direction,
      language: options.language,
      glyphs,
    };
  });
}
