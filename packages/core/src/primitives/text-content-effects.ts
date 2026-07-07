import { createFrameRandom } from "../frame/prng.js";
import { interpolate } from "../interpolation/interpolate.js";
import { resolveEasingFunction } from "../interpolation/named-easing.js";
import type { TextPhysicsConfig } from "../scene-graph/scene-node.js";
import { computeStaggerRanks } from "./text-stagger.js";

const DEFAULT_SCRAMBLE_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Splits `text` into Unicode grapheme clusters (never breaking a ZWJ sequence or a base-plus-combining-mark pair apart), the same correctness bar `@cadra/text`'s own `splitTextUnits` holds shaped glyphs to. */
function segmentGraphemes(text: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(text), (segment) => segment.segment);
}

/** Whitespace-only graphemes are never scrambled: a scrambled space would visually merge words together, which no real "decode" effect does. */
function isWhitespaceGrapheme(grapheme: string): boolean {
  return /^\s+$/.test(grapheme);
}

/**
 * Resolves a `"scramble"` `TextPhysicsConfig`'s own effective content at
 * `frame`: `text` split into graphemes, each ranked by `config.grouping`
 * (`"character"`/`"grapheme"` are the two groupings that make sense here;
 * `"word"`/`"line"` still work, just rank whole words/lines together
 * rather than individual graphemes) via the exact same reading-order-safe
 * `computeStaggerRanks` `TextStaggerConfig` itself uses. Each grapheme
 * shows a deterministic pseudo-random character from `config.charset`
 * until `frame` reaches its own `startFrame + rank * delayFrames +
 * durationFrames`, at which point it locks in permanently to its real
 * content; whitespace is never scrambled.
 *
 * Operates directly on `text` (before shaping), not on shaped glyphs: a
 * grapheme's rank here comes from its own position within `text` alone,
 * which is already in logical (reading) order regardless of script
 * direction (a plain JS string is never stored in a right-to-left run's
 * own visual glyph order - that reordering only happens during shaping),
 * so no bidi-awareness is needed at this level.
 *
 * Pure and deterministic: the same `(text, config, frame)` always resolves
 * to the same string, since `createFrameRandom` reseeds fresh per frame
 * (see its own doc) - evaluating frame 500 in isolation matches evaluating
 * frames 0..999 in order and inspecting frame 500.
 */
export function resolveScrambleText(text: string, config: TextPhysicsConfig, frame: number): string {
  const graphemes = segmentGraphemes(text);
  const charset = config.charset ?? DEFAULT_SCRAMBLE_CHARSET;
  const seed = config.seed ?? 0;
  const startFrame = config.startFrame ?? 0;
  const delayFrames = config.delayFrames ?? 0;
  const durationFrames = config.durationFrames ?? 30;
  const ranks = computeStaggerRanks(graphemes.length, config.direction ?? "forward");

  return graphemes
    .map((grapheme, index) => {
      if (isWhitespaceGrapheme(grapheme)) {
        return grapheme;
      }
      const rank = ranks[index] as number;
      const lockInFrame = startFrame + rank * delayFrames + durationFrames;
      if (frame >= lockInFrame) {
        return grapheme;
      }
      const random = createFrameRandom(`${seed}:scramble:${index}`, frame);
      const charsetIndex = Math.floor(random.next() * charset.length);
      return charset[charsetIndex] ?? grapheme;
    })
    .join("");
}

/**
 * Resolves a `"countUp"` `TextPhysicsConfig`'s own effective content at
 * `frame`: `fromValue` to `toValue`, eased over `[startFrame, startFrame +
 * durationFrames]` and clamped outside it, formatted with a fixed
 * `decimalPlaces`/`useGrouping` and an explicit `"en-US"` locale
 * regardless of the runtime's own default locale - rendering the same
 * frame must never depend on which machine renders it.
 */
export function resolveCountUpText(config: TextPhysicsConfig, frame: number): string {
  const fromValue = config.fromValue ?? 0;
  const toValue = config.toValue ?? 0;
  const startFrame = config.startFrame ?? 0;
  const durationFrames = config.durationFrames ?? 30;
  const easing = resolveEasingFunction(config.easing ?? "linear");

  const value = interpolate(frame, [startFrame, startFrame + durationFrames], [fromValue, toValue], {
    easing,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: config.decimalPlaces ?? 0,
    maximumFractionDigits: config.decimalPlaces ?? 0,
    useGrouping: config.useGrouping ?? false,
  });
  return formatter.format(value);
}
