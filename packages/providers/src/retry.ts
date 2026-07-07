import type { FetchLike } from "./fetch-like.js";

/**
 * Phase 34 task 4's shared retry/backoff helper: every adapter's outbound
 * HTTP call in this package goes through {@link fetchWithRetry} rather than
 * calling its injected `FetchLike` directly, so retry-on-429/5xx behavior is
 * implemented exactly once, in exactly one place, instead of five adapters
 * each reinventing (and each potentially subtly misimplementing) their own
 * copy.
 *
 * Retries only HTTP-level transient failures: a `429 Too Many Requests`
 * (rate limited) or any `5xx` response (server-side failure, presumed
 * transient), plus a thrown/rejected `fetchFn` call itself (a network-level
 * failure, e.g. a connection reset, which never even produced a `Response`
 * to inspect a status code from). Every other response - any `2xx` success,
 * or any other non-2xx status (`4xx` other than `429`: a `400` bad request,
 * `401`/`403` auth failure, `404` not found, etc.) - is returned immediately
 * on the first attempt with no retry, since retrying an unambiguously
 * non-transient failure (e.g. an invalid request body) would only waste
 * attempts and add latency for a failure retrying can never fix.
 *
 * Backoff is exponential with a multiplicative jitter-free base
 * (`baseDelayMs * 2 ** attemptIndex`), capped at `maxDelayMs`, and bounded to
 * `maxAttempts` total attempts (the first attempt plus up to `maxAttempts -
 * 1` retries). Deliberately no random jitter: this package's own test suite
 * asserts exact delay values passed to its injected `sleepFn` (see this
 * module's own test suite), which a jittered delay would make impossible to
 * assert deterministically; a caller layering this package into a
 * high-concurrency production deployment where many clients might
 * synchronize their retries is free to inject their own jitter-adding
 * `sleepFn` wrapper (`sleepFn` is itself an injectable seam for exactly this
 * kind of override, not hardcoded to a bare `setTimeout`).
 */

/** Injectable delay function; defaults to a real `setTimeout`-backed sleep. Kept injectable so this module's own test suite runs with zero real elapsed time (see `./retry.test.ts`), and so a caller can layer in their own jitter policy (see this module's own top-level doc) without this package needing to grow a jitter config knob of its own. */
export type SleepFn = (ms: number) => Promise<void>;

/** The real default `SleepFn`: a plain `setTimeout`-backed delay. */
export function defaultSleepFn(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Options accepted by {@link fetchWithRetry}. */
export interface FetchWithRetryOptions {
  /** The injectable `fetch`-like function to call. */
  fetchFn: FetchLike;
  /** Maximum total attempts (the first attempt plus every retry) before giving up and returning (or throwing, for a persistent network-level failure - see {@link fetchWithRetry}'s own doc) the last outcome. Defaults to {@link DEFAULT_MAX_ATTEMPTS}. Must be at least 1. */
  maxAttempts?: number;
  /** Base delay in milliseconds before the first retry (i.e. the delay after attempt 1 fails, before attempt 2). Defaults to {@link DEFAULT_BASE_DELAY_MS}. Doubles on every subsequent retry, capped at `maxDelayMs`. */
  baseDelayMs?: number;
  /** Upper bound on any single retry's delay, in milliseconds, regardless of how large exponential doubling would otherwise make it. Defaults to {@link DEFAULT_MAX_DELAY_MS}. */
  maxDelayMs?: number;
  /** Injectable delay function; see {@link SleepFn}'s own doc. Defaults to a real `setTimeout`-backed sleep. */
  sleepFn?: SleepFn;
}

/** Default max attempts (first try plus up to 2 retries) for {@link fetchWithRetry}. Conservative: bounded enough that a persistently-failing vendor endpoint does not hang a caller indefinitely, generous enough to ride out a single transient blip. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Default base retry delay: 500ms before the first retry, matching a reasonable "give a rate limit window a moment to clear" starting point without being so short it barely helps or so long it meaningfully stalls a user-facing submit call. */
export const DEFAULT_BASE_DELAY_MS = 500;

/** Default max retry delay cap: 8 seconds, reached after the third doubling (500ms -> 1000ms -> 2000ms -> 4000ms -> 8000ms, capped from there), keeping worst-case added latency from this helper's own backoff bounded even if `maxAttempts` were configured much higher than this module's own conservative default. */
export const DEFAULT_MAX_DELAY_MS = 8000;

/** HTTP status codes {@link fetchWithRetry} treats as transient and worth retrying: `429` (rate limited) and every `5xx` server error. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Calls `options.fetchFn(input, init)`, retrying on a `429`/`5xx` response or
 * a rejected `fetchFn` call itself, with exponential backoff between
 * attempts; see this module's own top-level doc for the exact retry/backoff
 * policy.
 *
 * Resolves with the first response that is either a success or a
 * non-retryable failure (see `isRetryableStatus`'s own doc for exactly
 * which statuses are considered retryable), or with the *last* attempt's
 * response once `maxAttempts` retryable-failure responses have been
 * observed (the caller's own status-code handling, e.g. an adapter's
 * `submit`/`poll`, is what ultimately turns a persistent `429`/`5xx` into a
 * thrown `Error` - this helper's job is only to retry, not to decide what a
 * persistent failure means to a given adapter's own request).
 *
 * Rejects only if every attempt's `fetchFn` call itself rejects (a
 * network-level failure with no `Response` at all); rethrows the *last*
 * attempt's rejection once `maxAttempts` is exhausted.
 */
export async function fetchWithRetry(
  input: Parameters<FetchLike>[0],
  init: Parameters<FetchLike>[1] | undefined,
  options: FetchWithRetryOptions,
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (maxAttempts < 1) {
    throw new RangeError(`fetchWithRetry: maxAttempts must be at least 1 (received ${maxAttempts}).`);
  }
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleepFn = options.sleepFn ?? defaultSleepFn;

  let lastNetworkError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await options.fetchFn(input, init);
    } catch (error) {
      lastNetworkError = error;
      if (attempt < maxAttempts) {
        await sleepFn(backoffDelayMs(attempt, baseDelayMs, maxDelayMs));
        continue;
      }
      throw error;
    }

    if (!isRetryableStatus(response.status) || attempt === maxAttempts) {
      return response;
    }

    await sleepFn(backoffDelayMs(attempt, baseDelayMs, maxDelayMs));
  }

  // Unreachable: the loop above always either returns or throws within its
  // final iteration (attempt === maxAttempts is handled inline both in the
  // success/non-retryable-status branch and the network-error branch).
  // Guarded rather than left implicit purely to keep this function's own
  // control flow obviously total to a reader, and to satisfy TypeScript's
  // control-flow analysis (a function whose declared return type is
  // `Promise<Response>` must not have a code path that falls off the end).
  throw lastNetworkError instanceof Error
    ? lastNetworkError
    : new Error("fetchWithRetry: exhausted all attempts with no response and no captured error.");
}

/** `attemptNumber` is 1-indexed (the attempt that just failed); the delay returned is before the *next* attempt, doubling per prior retry and capped at `maxDelayMs`. */
function backoffDelayMs(attemptNumber: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** (attemptNumber - 1);
  return Math.min(exponential, maxDelayMs);
}
