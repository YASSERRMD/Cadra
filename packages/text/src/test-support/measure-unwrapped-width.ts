import { segmentParagraphWords } from "../paragraph-words.js";
import type { ParsedFont } from "../parsed-font.js";
import { shapeLogicalRuns } from "../shape-text.js";

/** The total natural width (in em units) of `text` shaped with `font`, words plus every gap: what a paragraph layout call would need `maxWidth` to be at least for the whole thing to fit on one line. Test-only: picks a `maxWidth` relative to real shaped widths instead of a hand-guessed constant, so wrapping tests stay meaningful across font revisions. */
export function measureUnwrappedWidth(font: ParsedFont, text: string): number {
  const words = segmentParagraphWords(text, shapeLogicalRuns(font, text), font.metrics.unitsPerEm);
  return words.reduce((sum, word) => sum + word.advance + word.trailingWhitespace, 0);
}
