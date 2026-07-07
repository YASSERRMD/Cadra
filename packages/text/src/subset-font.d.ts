/**
 * `subset-font` ships no type declarations of its own (verified: its
 * package.json has no `types` field and the published tarball has no
 * `.d.ts` files). Declared here from its real `index.js` source
 * (`subset-font@2.5.0`), not guessed.
 */
declare module "subset-font" {
  export interface VariationAxisRange {
    min?: number;
    max?: number;
    default?: number;
  }

  export interface SubsetFontOptions {
    /** `"truetype"` is accepted as a backwards-compatible alias for `"sfnt"`. */
    targetFormat?: "sfnt" | "truetype" | "woff" | "woff2";
    preserveNameIds?: readonly number[];
    variationAxes?: Record<string, number | VariationAxisRange>;
    noLayoutClosure?: boolean;
  }

  export default function subsetFont(
    originalFont: Buffer | ArrayBuffer | Uint8Array,
    text: string,
    options?: SubsetFontOptions,
  ): Promise<Buffer>;
}
