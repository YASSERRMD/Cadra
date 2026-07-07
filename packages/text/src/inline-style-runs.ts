import type { ParagraphSpan } from "./inline-text-style.js";
import type { ItemizedRun } from "./script-runs.js";

/** One paragraph's spans concatenated into a single logical string, plus which span produced each character. */
export interface CombinedSpans {
  text: string;
  /** `styleIndexForChar[i]` is the index into the original `spans` array that produced `text[i]`. */
  styleIndexForChar: readonly number[];
}

/**
 * Concatenates `spans`' own text into one logical string for bidi
 * resolution, script itemization, and shaping to run over as a whole (bidi
 * and shaping both need full paragraph context, not just one span at a
 * time), while remembering which span produced each character so
 * `splitRunsByStyle` can later itemize by style boundary too.
 */
export function combineSpans(spans: readonly ParagraphSpan[]): CombinedSpans {
  let text = "";
  const styleIndexForChar: number[] = [];
  spans.forEach((span, index) => {
    text += span.text;
    for (let i = 0; i < span.text.length; i += 1) {
      styleIndexForChar.push(index);
    }
  });
  return { text, styleIndexForChar };
}

/** An `ItemizedRun` further scoped to a single inline style span. */
export interface StyledItemizedRun extends ItemizedRun {
  /** Index into the original `spans` array (see `CombinedSpans.styleIndexForChar`) this run's style comes from. */
  styleIndex: number;
}

/**
 * Splits each of `runs` (already single-script, single-bidi-level; see
 * `computeItemizedRuns`) further at any inline-style-span boundary it
 * crosses, the same "maximal run sharing every relevant boundary" shape
 * `computeItemizedRuns` itself builds for level and script - since a single
 * script/level run can easily span two differently-styled words (e.g. one
 * bolded word inside an otherwise-plain sentence, all one script and
 * direction), and each styled sub-run may need its own font/features when
 * shaped.
 */
export function splitRunsByStyle(
  runs: readonly ItemizedRun[],
  styleIndexForChar: readonly number[],
): StyledItemizedRun[] {
  const result: StyledItemizedRun[] = [];
  for (const run of runs) {
    let segmentStart = run.start;
    for (let i = run.start + 1; i <= run.end; i += 1) {
      const atEnd = i === run.end;
      const styleChanged = !atEnd && styleIndexForChar[i] !== styleIndexForChar[segmentStart];
      if (atEnd || styleChanged) {
        result.push({
          ...run,
          start: segmentStart,
          end: i,
          styleIndex: styleIndexForChar[segmentStart] as number,
        });
        segmentStart = i;
      }
    }
  }
  return result;
}
