/**
 * `bidi-js` ships no type declarations of its own (verified: no `types`
 * field in its package.json and no `.d.ts` in the published tarball).
 * Declared here from its real `dist/bidi.mjs` source (`bidi-js@1.0.3`), for
 * exactly the functions this package uses; not guessed.
 */
declare module "bidi-js" {
  export interface BidiParagraph {
    start: number;
    end: number;
    level: number;
  }

  export interface EmbeddingLevelsResult {
    levels: Uint8Array;
    paragraphs: BidiParagraph[];
  }

  export interface Bidi {
    getEmbeddingLevels(text: string, baseDirection?: "ltr" | "rtl"): EmbeddingLevelsResult;
    getReorderSegments(
      text: string,
      embeddingLevels: EmbeddingLevelsResult,
      start?: number,
      end?: number,
    ): Array<[number, number]>;
    /**
     * Unlike `getReorderSegments` (which really does take the full
     * `EmbeddingLevelsResult`), this indexes its second argument directly
     * as an array (`levels[i] & 1`) - verified against the installed
     * source, since passing the full result object here (as bidi-js's own
     * README shows) silently returns an always-empty map instead of
     * throwing. Pass `getEmbeddingLevels(...).levels`, not the result
     * object itself.
     */
    getMirroredCharactersMap(
      text: string,
      levels: Uint8Array,
      start?: number,
      end?: number,
    ): Map<number, string>;
    getMirroredCharacter(char: string): string | null;
    getBidiCharTypeName(char: string): string;
  }

  export default function bidiFactory(): Bidi;
}
