import bidiFactory from "bidi-js";

const bidi = bidiFactory();

/** A paragraph-level base direction, matching `bidi-js`'s own vocabulary. */
export type TextDirection = "ltr" | "rtl";

/** One resolved bidi paragraph within a larger text (paragraphs split on explicit break characters). */
export interface BidiParagraph {
  start: number;
  end: number;
  level: number;
}

/**
 * The result of Unicode bidi resolution (UAX #9) over a string: a
 * per-character embedding level (odd means right-to-left scope, even means
 * left-to-right) plus which characters need to render as their mirrored
 * counterpart (e.g. "(" as ")" inside an right-to-left run).
 */
export interface BidiResolution {
  /** Per-character embedding level. `(level & 1) === 1` means that character is in a right-to-left scope. */
  readonly levels: Uint8Array;
  readonly paragraphs: readonly BidiParagraph[];
  /** Character index to its mirrored replacement character, for characters that need one. */
  readonly mirroredCharacters: ReadonlyMap<number, string>;
}

/**
 * Resolves Unicode bidi embedding levels for `text` via `bidi-js` (the hard,
 * spec-defined part: UAX #9's actual rules for deriving levels from each
 * character's bidi type). Pass `baseDirection` to force the paragraph
 * direction instead of auto-detecting it from the text's first strong
 * character.
 */
export function resolveBidi(text: string, baseDirection?: TextDirection): BidiResolution {
  const embeddingLevels = bidi.getEmbeddingLevels(text, baseDirection);
  // getMirroredCharactersMap indexes its second argument directly as an
  // array, unlike getReorderSegments; see the bidi-js.d.ts doc on why this
  // passes .levels rather than the full embeddingLevels result.
  const mirroredCharacters = bidi.getMirroredCharactersMap(text, embeddingLevels.levels);
  return {
    levels: embeddingLevels.levels,
    paragraphs: embeddingLevels.paragraphs,
    mirroredCharacters,
  };
}

/** Whether an embedding level puts its characters in a right-to-left scope. */
export function isRtlLevel(level: number): boolean {
  return (level & 1) === 1;
}
