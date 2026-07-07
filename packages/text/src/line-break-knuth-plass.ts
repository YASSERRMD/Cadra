import type { LineBreak } from "./line-break-greedy.js";
import { computeLineWidth, type ParagraphWord } from "./paragraph-words.js";

/**
 * Packs `words` onto lines by dynamic programming over every feasible
 * breakpoint, minimizing the sum of each line's squared "slack" (`maxWidth`
 * minus its natural width), the same badness-minimization spirit as Knuth
 * and Plass's original TeX line-breaking algorithm: unlike greedy breaking
 * (which commits to the longest line that still fits at each step, and
 * never reconsiders), this can trade a slightly shorter earlier line for a
 * much better-balanced later one when that lowers the total.
 *
 * This is a deliberately simplified variant, not TeX's full algorithm: no
 * per-glue stretch/shrink parameters (a space's width comes straight from
 * the font, uniformly), no hyphenation, and no explicit penalty classes.
 * What it keeps is the essential shape callers actually want it for -
 * justified paragraphs, where evenly distributed slack (this minimizes) is
 * exactly what becomes the extra inter-word spacing justification adds.
 *
 * A line whose natural width already exceeds `maxWidth` is only ever
 * accepted when it is a single, unsplittable word (this engine never
 * breaks inside a word); any other overflowing multi-word grouping is
 * infeasible and excluded from consideration. The paragraph's own last
 * line is never penalized for being short (a paragraph's final line is
 * conventionally allowed to be ragged), matching typographic convention
 * and greedy breaking's own treatment of a trailing short remainder.
 */
export function computeKnuthPlassLineBreaks(
  words: readonly ParagraphWord[],
  maxWidth: number,
): LineBreak[] {
  const wordCount = words.length;
  if (wordCount === 0) {
    return [{ wordStart: 0, wordEnd: 0 }];
  }
  if (!Number.isFinite(maxWidth)) {
    return [{ wordStart: 0, wordEnd: wordCount }];
  }

  // cost[i]: minimum total badness to break words[0, i) into lines.
  // breakFrom[i]: the line-start index achieving that minimum, so the final
  // breakdown is recovered by walking breakFrom backward from wordCount.
  const cost: number[] = new Array(wordCount + 1).fill(Infinity);
  const breakFrom: number[] = new Array(wordCount + 1).fill(-1);
  cost[0] = 0;

  for (let end = 1; end <= wordCount; end += 1) {
    for (let start = 0; start < end; start += 1) {
      const previousCost = cost[start] as number;
      if (!Number.isFinite(previousCost)) {
        continue;
      }

      const isSingleWordLine = end - start === 1;
      const isLastLine = end === wordCount;
      const width = computeLineWidth(words, { wordStart: start, wordEnd: end });
      const slack = maxWidth - width;

      let lineCost: number;
      if (isLastLine && slack >= 0) {
        lineCost = 0;
      } else if (slack < 0 && !isSingleWordLine) {
        lineCost = Infinity;
      } else {
        lineCost = slack * slack;
      }

      const total = previousCost + lineCost;
      if (total < (cost[end] as number)) {
        cost[end] = total;
        breakFrom[end] = start;
      }
    }
  }

  const lines: LineBreak[] = [];
  let end = wordCount;
  while (end > 0) {
    const start = breakFrom[end] as number;
    lines.push({ wordStart: start, wordEnd: end });
    end = start;
  }
  lines.reverse();

  return lines;
}
