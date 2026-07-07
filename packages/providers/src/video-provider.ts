/**
 * Phase 34: the provider-agnostic generative-video interface every adapter
 * in this package (`./veo-provider.ts`, `./runway-provider.ts`,
 * `./kling-provider.ts`, `./luma-provider.ts`, `./pika-provider.ts`)
 * implements.
 *
 * The five real vendors this phase targets differ substantially in their
 * actual submit/poll wire shapes (see each adapter's own module doc, and
 * `../docs/provider-capabilities.md`, for exactly what each one's real API
 * looks like): some return a long-running "operation" name, some a plain
 * task id; some accept a single reference image, one (Luma) accepts distinct
 * start/end keyframe images instead; none of the five support every
 * normalized param in `VideoGenerationRequest.params` identically. This
 * module intentionally does not try to paper over those differences by
 * forcing a lowest-common-denominator request shape onto the wire - it only
 * fixes the shape of the request/response *this package's own callers* see,
 * with each adapter responsible for its own honest translation to and from
 * that vendor's real API, documenting per-param support in its own module
 * doc (which normalized param it honors, silently ignores, or actively
 * rejects).
 */

/**
 * A single reference image supplied for image-to-video generation, given as
 * a URL a vendor's own servers can fetch (every one of this phase's five
 * vendors accepts image references by URL rather than requiring the caller
 * to upload raw bytes through this package). Whether an adapter honors more
 * than one URL (as an ordered list of distinct keyframes rather than
 * "several equally-weighted references") is vendor-specific: see each
 * adapter's own module doc.
 */
export type ReferenceImageUrl = string;

/**
 * Provider-agnostic generation params. Every field is optional: a
 * `VideoGenerationRequest` with an empty `params` object is valid, and every
 * adapter falls back to that vendor's own documented default for any field
 * it omits, rather than this package inventing a universal default.
 *
 * This is the single normalized shape every adapter translates to its own
 * vendor's real request fields (per this phase's task 3); which of these an
 * adapter actually honors, versus silently ignores, versus rejects outright
 * with a validation error, is vendor-specific and documented in that
 * adapter's own module doc and in `../docs/provider-capabilities.md`. A
 * caller that needs a specific vendor's exact behavior for an unsupported
 * param should consult that adapter's doc rather than assuming every
 * adapter treats an unsupported param identically (some vendors only accept
 * a param from a fixed enum, e.g. Kling's `"5"`/`"10"`-second durations
 * rather than an arbitrary integer, and reject anything else at the API
 * level; some silently clamp; this package's own stance is documented per
 * adapter, not forced to one uniform policy that would misrepresent at
 * least one real vendor's actual behavior).
 */
export interface VideoGenerationParams {
  /**
   * Requested clip duration in seconds. Several vendors only accept a fixed
   * enum of durations (e.g. Kling: 5 or 10; Luma: 5 or 9) rather than an
   * arbitrary value; see each adapter's own module doc for exactly which
   * values that vendor accepts and what an adapter does with an
   * unsupported value (documented per adapter, e.g. rounding to the nearest
   * supported value versus rejecting).
   */
  durationSeconds?: number;
  /**
   * Requested aspect ratio, as a `"width:height"` string (e.g. `"16:9"`,
   * `"9:16"`, `"1:1"`). Every one of this phase's five vendors accepts this
   * shape natively (as a string enum of specific ratios, not arbitrary
   * width/height pixel dimensions), though the exact set of accepted ratio
   * strings differs per vendor; see each adapter's own module doc.
   */
  aspectRatio?: string;
  /**
   * Seed for reproducible generation. Only some vendors document seed
   * support at all (Veo does; Runway does; Kling and Luma do not appear to
   * as of this phase's research - see `../docs/provider-capabilities.md`
   * and each adapter's own module doc for exactly what was verified from
   * real documentation versus left uncertain). An adapter for a vendor that
   * does not support seed silently ignores this field rather than throwing,
   * matching this interface's general "unsupported normalized param is
   * ignored, not rejected, unless documented otherwise for that specific
   * adapter" policy - the one documented exception is any param a vendor's
   * own API rejects at the wire level with a validation error, which an
   * adapter surfaces as a normal failed submit rather than pretending to
   * accept it.
   */
  seed?: number;
}

/** A single generation request, provider-agnostic until handed to a specific adapter's `submit`. */
export interface VideoGenerationRequest {
  /** The text prompt describing the desired video. Every one of this phase's five vendors requires this (even for image-to-video, as guidance alongside the reference image(s)), so it is not optional here. */
  prompt: string;
  /**
   * Reference image URL(s) for image-to-video generation, where the vendor
   * supports it. Omit entirely (or pass an empty array) for pure
   * text-to-video. Every adapter documents, in its own module doc, exactly
   * how many of these it actually uses and what role each plays (e.g. "only
   * `referenceImageUrls[0]` is used, every later entry is ignored" versus
   * "the first two entries are used as distinct start/end keyframes" - see
   * `./luma-provider.ts` for the latter).
   */
  referenceImageUrls?: ReferenceImageUrl[];
  /** Normalized generation params; see {@link VideoGenerationParams}'s own doc for the per-adapter honor/ignore/reject policy. */
  params: VideoGenerationParams;
}

/**
 * A submitted generation job, as returned by `VideoProvider.submit`. Plain,
 * serializable data (no functions/handles) so a caller can persist it (e.g.
 * alongside a Cadra project's own asset references) and pass it back into
 * `poll` later, potentially from an entirely different process, exactly
 * like `@cadra/headless`'s `RenderJobHandle`/`getRenderJobStatus` resumable-
 * job pattern.
 */
export interface VideoGenerationJob {
  /** Matches the owning adapter's own `VideoProvider.name`, so a caller juggling jobs from multiple providers can route each job back to the adapter that must `poll` it. */
  provider: string;
  /**
   * The vendor's own job/task/operation identifier, exactly as that vendor
   * returned it (e.g. a Runway task `id`, a Kling task `task_id`, a Veo
   * long-running-operation `name`). Opaque to every caller outside the
   * owning adapter; only that adapter's own `poll` implementation knows how
   * to turn this back into a status-check request.
   */
  externalJobId: string;
}

/** `VideoProvider.poll`'s result while a job has not yet reached a terminal state. */
export interface VideoGenerationPending {
  status: "pending" | "running";
}

/** `VideoProvider.poll`'s result once a job has finished successfully. */
export interface VideoGenerationSucceeded {
  status: "succeeded";
  /**
   * A URL the finished video can be fetched from. Every one of this phase's
   * five vendors returns a fetchable URL (rather than inline bytes) on
   * success, though some (Veo in particular) document this URL as
   * time-limited (expiring after a vendor-documented window) - see that
   * adapter's own module doc for specifics; this package does not itself
   * download or re-host the asset, matching every other adapter in this
   * codebase's "fetch bytes is the caller's job, not this seam's" stance
   * (e.g. `@cadra/renderer`'s asset loaders, `FetchBytes`).
   */
  outputUrl: string;
}

/** `VideoProvider.poll`'s result once a job has terminally failed. */
export interface VideoGenerationFailed {
  status: "failed";
  /** Human-readable failure reason, derived from the vendor's own error response where one is available (see each adapter's own module doc for exactly what that vendor's failure shape looks like), or a description of an unexpected/malformed response otherwise. */
  error: string;
}

/** The full discriminated union `VideoProvider.poll` resolves to. */
export type VideoGenerationStatus =
  | VideoGenerationPending
  | VideoGenerationSucceeded
  | VideoGenerationFailed;

/**
 * The provider-agnostic interface every adapter in this package implements.
 *
 * `submit`/`poll` is a deliberately uniform two-call shape even though not
 * every real vendor's own API is naturally two-call: a vendor whose API
 * happens to resolve very quickly still goes through the same `submit` then
 * `poll` sequence from this interface's own callers' point of view (an
 * adapter for such a vendor would simply expect its very first `poll` call
 * to typically already observe a terminal status) - this phase's five
 * vendors all in fact expose an async submit-a-job/poll-a-job API shape
 * natively (none of them returns a finished video synchronously from the
 * submit call itself, which real generative video inference reliably takes
 * longer than a single HTTP request's reasonable timeout to produce), so no
 * adapter in this package needs to fake a `poll` for a vendor that does not
 * really have one.
 */
export interface VideoProvider {
  /** Stable, lowercase identifier for this provider (e.g. `"veo"`, `"runway"`, `"kling"`, `"luma"`, `"pika"`), matching `VideoGenerationJob.provider`. */
  readonly name: string;
  /**
   * Submits a new generation request to this vendor, returning a job handle
   * once the vendor has accepted it (not once it has finished generating;
   * call `poll` to observe progress and eventual completion).
   *
   * Rejects if the vendor's API itself rejects the request (invalid
   * params, auth failure, rate limit exhausted after this package's own
   * retry budget - see `./retry.ts` - is exhausted, or any other non-2xx
   * response), with an `Error` describing the vendor's own error response
   * where one is available.
   */
  submit(request: VideoGenerationRequest): Promise<VideoGenerationJob>;
  /**
   * Checks a previously-submitted job's current status. Safe to call
   * repeatedly (a caller is expected to poll on some interval of their own
   * choosing until a terminal `"succeeded"`/`"failed"` status is observed;
   * this method itself does not sleep/retry/loop on `"pending"`/`"running"`
   * - see this package's own README/docs for why polling cadence is left to
   * the caller rather than built into this interface).
   *
   * Rejects only if the status-check request itself fails at the transport/
   * auth/rate-limit level (after this package's own retry budget is
   * exhausted); a job that the vendor reports as having terminally failed
   * is *not* a rejection, it resolves with `{ status: "failed", error }`
   * (see `VideoGenerationFailed`'s own doc for why: the status check itself
   * succeeded, it is the generation that failed, and those are different
   * failure modes a caller needs to distinguish - e.g. to decide whether
   * retrying the whole `submit` is worthwhile versus retrying just this
   * `poll`).
   */
  poll(job: VideoGenerationJob): Promise<VideoGenerationStatus>;
}
