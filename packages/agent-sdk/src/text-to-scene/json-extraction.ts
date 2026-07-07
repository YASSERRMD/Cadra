/**
 * Extracts a single JSON value out of an LLM's raw free-text completion.
 *
 * This phase deliberately never asks a vendor's forced-structured-output or
 * tool-calling mode for the scene JSON (see this package's module doc on
 * `./create-text-to-scene-adapter.ts` for why): the model is just asked, in
 * plain prose, to reply with JSON, and whatever text comes back is parsed
 * here, tolerating the common ways a real model's raw response wraps or
 * pads that JSON (a fenced code block, conversational text before/after it,
 * incidental leading/trailing whitespace) rather than requiring the
 * response to be *exactly* a JSON document with nothing else in it. This is
 * what makes it possible for a first draft to actually come out malformed
 * (an unparseable fence, prose with no JSON at all, truncated JSON), which
 * is exactly the failure mode the self-correction retry loop in
 * `./create-text-to-scene-adapter.ts` is built, and tested, to recover from.
 */

/** A JSON value was found and parsed successfully. */
export interface JsonExtractionSuccess {
  success: true;
  value: unknown;
  /**
   * Whatever free text of the raw response was *not* part of the matched
   * JSON span (e.g. the code fence's own language tag line, or prose the
   * model wrote before/after it), trimmed, or `undefined` if nothing was
   * left over (the raw response was nothing but the JSON itself). This is
   * the model's rationale, if it gave one; see `deriveRationale` in
   * `./create-text-to-scene-adapter.ts` for how a caller turns this into
   * `TextToSceneSuccess.rationale`. Never fabricated: this is exactly the
   * leftover text, verbatim, with no attempt to summarize or validate that
   * it actually reads like an explanation.
   */
  leftoverText?: string;
}

/** No JSON value could be extracted and parsed from the raw text. */
export interface JsonExtractionFailure {
  success: false;
  /** Human-readable reason extraction failed, suitable for feeding back into a retry prompt. */
  reason: string;
}

export type JsonExtractionResult = JsonExtractionSuccess | JsonExtractionFailure;

/**
 * Matches a fenced code block (` ```json ... ``` ` or a bare ` ``` ... ``` `),
 * capturing its inner contents. Case-insensitive on the optional language tag
 * so ` ```JSON ` also matches.
 */
const FENCED_CODE_BLOCK_PATTERN = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i;

/**
 * Finds the substring of `text` spanning from its first `{` or `[` to the
 * matching last `}` or `]` in the text, preferring whichever of `{`/`[`
 * appears first. Returns `undefined` if neither bracket character appears at
 * all. This is a simple heuristic, not a real bracket-matching parser: it
 * trims surrounding prose (e.g. "Here is the scene:\n\n{...}\n\nLet me know
 * if you'd like changes.") down to its outermost bracketed span, and relies
 * on `JSON.parse` itself (called by this module's caller) to reject the
 * result if that heuristic guessed wrong (e.g. genuinely malformed or
 * truncated JSON), which is precisely a case this phase's retry loop must
 * already handle regardless.
 */
function extractOutermostBracketedSpan(text: string): string | undefined {
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");

  const candidates = [firstBrace, firstBracket].filter((index) => index !== -1);
  if (candidates.length === 0) {
    return undefined;
  }
  const start = Math.min(...candidates);
  const openChar = text[start];
  const closeChar = openChar === "{" ? "}" : "]";

  const end = text.lastIndexOf(closeChar);
  if (end === -1 || end < start) {
    return undefined;
  }

  return text.slice(start, end + 1);
}

/** Attempts `JSON.parse` on `candidate`, returning `undefined` (rather than throwing) on failure. */
function tryParseJson(candidate: string): unknown | undefined {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/** Trims `text` and returns it, or `undefined` if trimming leaves nothing behind, so a caller can spread `leftoverText` conditionally without ever setting it to an empty string. */
function trimmedOrUndefined(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Extracts and parses a JSON value from `rawText`, an LLM's raw completion.
 *
 * Tries, in order, stopping at the first that yields a value:
 *
 * 1. The entire trimmed text, parsed as-is (the common case for a model that
 *    followed instructions and replied with nothing but JSON).
 * 2. The contents of a fenced code block (` ```json ... ``` ` or ` ``` ...
 *    ``` `), if one is present.
 * 3. The outermost `{...}`/`[...]`-bracketed span found anywhere in the text
 *    (see {@link extractOutermostBracketedSpan}), covering a model that
 *    added conversational text before or after the JSON with no fence at
 *    all.
 *
 * Returns a {@link JsonExtractionFailure} with a human-readable `reason` if
 * none of these yield valid JSON, rather than throwing: this function's
 * caller (`createTextToSceneAdapter`) treats extraction failure as just
 * another kind of self-correctable problem, folding `reason` into the next
 * retry prompt exactly like a `parseScene` diagnostic.
 */
export function extractJsonFromLlmResponse(rawText: string): JsonExtractionResult {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return { success: false, reason: "The model's response was empty." };
  }

  const direct = tryParseJson(trimmed);
  if (direct !== undefined) {
    return { success: true, value: direct };
  }

  const fenceMatch = FENCED_CODE_BLOCK_PATTERN.exec(trimmed);
  if (fenceMatch?.[1] !== undefined) {
    const fenced = tryParseJson(fenceMatch[1].trim());
    if (fenced !== undefined) {
      const leftover = trimmed.slice(0, fenceMatch.index) + trimmed.slice(fenceMatch.index + fenceMatch[0].length);
      return { success: true, value: fenced, leftoverText: trimmedOrUndefined(leftover) };
    }
  }

  const bracketedSpan = extractOutermostBracketedSpan(trimmed);
  if (bracketedSpan !== undefined) {
    const bracketed = tryParseJson(bracketedSpan);
    if (bracketed !== undefined) {
      const spanStart = trimmed.indexOf(bracketedSpan);
      const leftover =
        spanStart === -1
          ? ""
          : trimmed.slice(0, spanStart) + trimmed.slice(spanStart + bracketedSpan.length);
      return { success: true, value: bracketed, leftoverText: trimmedOrUndefined(leftover) };
    }
  }

  return {
    success: false,
    reason:
      "Could not find a valid JSON value in the model's response (checked the raw text, a " +
      "fenced code block, and the outermost bracketed span).",
  };
}
