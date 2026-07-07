/**
 * Reorders logically-ordered runs into visual (left-to-right on the page)
 * order, per Unicode UAX #9 rule L2, applied at run granularity rather than
 * per-character: from the highest level down to the lowest odd level,
 * reverse each maximal contiguous sequence of runs whose level is at least
 * that level. This is equivalent to the spec's per-character version
 * because every character within one `ItemizedRun` already shares a single
 * level by construction (see `computeItemizedRuns`), and a HarfBuzz-shaped
 * right-to-left run's own glyphs are already in correct visual order
 * internally, so only the runs' relative order, never their contents,
 * needs reversing here.
 */
export function reorderRunsToVisualOrder<T extends { level: number }>(runs: readonly T[]): T[] {
  const result = runs.slice();
  if (result.length === 0) {
    return result;
  }

  let maxLevel = 0;
  let minOddLevel = -1;
  for (const run of result) {
    if (run.level > maxLevel) {
      maxLevel = run.level;
    }
    if (run.level % 2 === 1 && (minOddLevel === -1 || run.level < minOddLevel)) {
      minOddLevel = run.level;
    }
  }
  if (minOddLevel === -1) {
    return result;
  }

  for (let level = maxLevel; level >= minOddLevel; level -= 1) {
    let i = 0;
    while (i < result.length) {
      if ((result[i] as T).level >= level) {
        let j = i;
        while (j < result.length && (result[j] as T).level >= level) {
          j += 1;
        }
        reverseRange(result, i, j - 1);
        i = j;
      } else {
        i += 1;
      }
    }
  }
  return result;
}

function reverseRange<T>(items: T[], from: number, to: number): void {
  let start = from;
  let end = to;
  while (start < end) {
    const temp = items[start] as T;
    items[start] = items[end] as T;
    items[end] = temp;
    start += 1;
    end -= 1;
  }
}
