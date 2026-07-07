import * as unicodeProperties from "unicode-properties";

import { isRtlLevel, type TextDirection } from "./bidi-resolution.js";
import { SCRIPT_LESS_UNICODE_SCRIPTS } from "./script-tags.js";

/** One logically-ordered run of text sharing a single bidi level and Unicode script. */
export interface ItemizedRun {
  /** UTF-16 code unit index into the original string, inclusive. */
  start: number;
  /** UTF-16 code unit index into the original string, exclusive. */
  end: number;
  level: number;
  direction: TextDirection;
  /** Unicode script name (e.g. `"Arabic"`), never one of `SCRIPT_LESS_UNICODE_SCRIPTS`. */
  script: string;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Resolves a real script for every position in `rawScripts[start, end)`,
 * absorbing script-less characters (punctuation, digits, combining marks,
 * whitespace) into whichever real-script run they are adjacent to within
 * that same range, preferring the preceding run and falling back to the
 * following one (the standard heuristic real shaping engines use, e.g.
 * ICU's `UScriptRun`), so a trailing "." or a leading space never forces
 * its own single-character run in the wrong script. Scoped to one
 * `[start, end)` range (one bidi-level run; see `computeItemizedRuns`)
 * rather than the whole string, so a script-less character never absorbs
 * a script from text at a different bidi level/direction across the
 * boundary - a run of trailing whitespace after a right-to-left word must
 * not itself be tagged as right-to-left just because that word happens to
 * be its nearest neighbor.
 */
function resolveScriptRunsWithinRange(
  rawScripts: readonly string[],
  start: number,
  end: number,
): string[] {
  const resolved = rawScripts.slice(start, end);

  let lastRealScript: string | undefined;
  for (let i = 0; i < resolved.length; i += 1) {
    const script = resolved[i] as string;
    if (SCRIPT_LESS_UNICODE_SCRIPTS.has(script)) {
      if (lastRealScript !== undefined) {
        resolved[i] = lastRealScript;
      }
    } else {
      lastRealScript = script;
    }
  }

  let nextRealScript: string | undefined;
  for (let i = resolved.length - 1; i >= 0; i -= 1) {
    const script = resolved[i] as string;
    if (SCRIPT_LESS_UNICODE_SCRIPTS.has(script)) {
      resolved[i] = nextRealScript ?? "Common";
    } else {
      nextRealScript = script;
    }
  }

  return resolved;
}

/** Splits `[0, length)` into maximal ranges sharing one bidi level, in logical order. */
function computeLevelRuns(levels: Uint8Array, length: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let runStart = 0;
  for (let i = 1; i <= length; i += 1) {
    if (i === length || levels[i] !== levels[runStart]) {
      ranges.push({ start: runStart, end: i });
      runStart = i;
    }
  }
  return ranges;
}

/**
 * Splits `text` into runs of constant bidi level and Unicode script, in
 * logical (original string) order. Each run is exactly what one HarfBuzz
 * `shape` call should receive: a single script and a single direction.
 * `levels` must come from `resolveBidi(text, ...).levels`.
 */
export function computeItemizedRuns(text: string, levels: Uint8Array): ItemizedRun[] {
  const length = text.length;
  if (length === 0) {
    return [];
  }

  const rawScripts: string[] = new Array(length);
  for (let i = 0; i < length; ) {
    const codePoint = text.codePointAt(i) as number;
    const step = codePoint > 0xffff ? 2 : 1;
    const scriptName = unicodeProperties.getScript(codePoint);
    for (let offset = 0; offset < step; offset += 1) {
      rawScripts[i + offset] = scriptName;
    }
    i += step;
  }

  const runs: ItemizedRun[] = [];
  for (const levelRun of computeLevelRuns(levels, length)) {
    const level = levels[levelRun.start] as number;
    const direction: TextDirection = isRtlLevel(level) ? "rtl" : "ltr";
    const scriptsInLevelRun = resolveScriptRunsWithinRange(rawScripts, levelRun.start, levelRun.end);

    let runStart = levelRun.start;
    for (let i = levelRun.start + 1; i <= levelRun.end; i += 1) {
      const atEnd = i === levelRun.end;
      const splitsSurrogatePair =
        !atEnd && isHighSurrogate(text.charCodeAt(i - 1)) && isLowSurrogate(text.charCodeAt(i));
      const scriptChanged =
        !atEnd &&
        scriptsInLevelRun[i - levelRun.start] !== scriptsInLevelRun[runStart - levelRun.start];

      if (atEnd || (scriptChanged && !splitsSurrogatePair)) {
        runs.push({
          start: runStart,
          end: i,
          level,
          direction,
          script: scriptsInLevelRun[runStart - levelRun.start] as string,
        });
        runStart = i;
      }
    }
  }
  return runs;
}
