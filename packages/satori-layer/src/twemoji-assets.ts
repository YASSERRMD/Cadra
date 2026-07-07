import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * `@discordapp/twemoji` ships its actual SVG assets inside the published npm
 * package itself (`dist/svg/*.svg`), unlike the original `twemoji` package
 * (parsing/DOM-helper code only, pointing at a CDN by default) - resolving a
 * local file from this installed package is what keeps emoji rendering
 * fully offline and deterministic (no network fetch at render time, the same
 * requirement every other asset in this renderer already satisfies).
 * `createRequire` mirrors `packages/text/src/msdfgen-instance.ts`'s own
 * pattern for locating a sibling npm package's bundled non-JS asset from ESM.
 */
const require = createRequire(import.meta.url);
const TWEMOJI_SVG_DIR = join(dirname(require.resolve("@discordapp/twemoji/package.json")), "dist", "svg");

/**
 * Converts a grapheme cluster (one already-joined emoji sequence, e.g. a
 * ZWJ family emoji or a flag pair) to Twemoji's own filename convention:
 * every Unicode code point (not UTF-16 code unit - `Array.from` iterates by
 * code point) lowercase-hex-encoded and joined with `-`. `segment` is
 * expected to already be exactly one grapheme (Satori itself segments text
 * via `Intl.Segmenter` before ever invoking a `loadAdditionalAsset` "emoji"
 * bucket call; see `fallback-font-resolver.ts`).
 */
function codePointsToTwemojiStem(segment: string): string {
  return Array.from(segment, (char) => (char.codePointAt(0) as number).toString(16))
    .join("-");
}

/** U+FE0F (VARIATION SELECTOR-16, forces emoji presentation). Twemoji's own asset set inconsistently includes or omits this from a sequence's filename (verified empirically against the installed package: e.g. `270f.svg` exists but `270f-fe0f.svg` does not), so resolution retries with it stripped. */
const VARIATION_SELECTOR_16 = 0xfe0f;

function withoutVariationSelectors(segment: string): string {
  return Array.from(segment)
    .filter((char) => char.codePointAt(0) !== VARIATION_SELECTOR_16)
    .join("");
}

/**
 * Reads one emoji grapheme's Twemoji SVG source bytes from the locally
 * installed `@discordapp/twemoji` package, or `undefined` if this exact
 * sequence has no corresponding asset (an emoji genuinely outside Twemoji's
 * own coverage, e.g. a very recent Unicode addition). Tries the exact
 * sequence first, then the same sequence with every variation selector
 * stripped (see `withoutVariationSelectors`'s own doc).
 */
export function resolveTwemojiSvgBytes(segment: string): Buffer | undefined {
  const candidates = new Set([codePointsToTwemojiStem(segment)]);
  const withoutSelectors = withoutVariationSelectors(segment);
  if (withoutSelectors !== segment && withoutSelectors.length > 0) {
    candidates.add(codePointsToTwemojiStem(withoutSelectors));
  }

  for (const stem of candidates) {
    try {
      return readFileSync(join(TWEMOJI_SVG_DIR, `${stem}.svg`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return undefined;
}
