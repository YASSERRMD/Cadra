/**
 * Shared whitespace classification for word segmentation: both the simple
 * per-line layout (`glyph-layout.ts`, one word index per whitespace-
 * separated span) and the paragraph layout engine's line breaking
 * (`paragraph-words.ts`, one breakable unit per whitespace-separated span)
 * need to agree on exactly what counts as a word boundary.
 */
const WHITESPACE_PATTERN = /\s/;

export function isWhitespaceChar(char: string): boolean {
  return char.length > 0 && WHITESPACE_PATTERN.test(char);
}
