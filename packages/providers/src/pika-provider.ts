import { defaultFetchLike, type FetchLike } from "./fetch-like.js";
import { fetchWithRetry, type FetchWithRetryOptions } from "./retry.js";
import type {
  VideoGenerationJob,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoProvider,
} from "./video-provider.js";

/**
 * Pika adapter (Phase 34).
 *
 * **Research status: Pika Labs does not operate its own public, self-serve
 * developer API. This is the "genuinely no public API reference" case this
 * phase's own research task explicitly anticipated, and this adapter is
 * built and labeled accordingly, rather than presenting a confident-looking
 * "Pika's own API" shape that does not actually exist.**
 *
 * Verified directly: `pika.art/api` (the genuine, official Pika Labs
 * domain) has no first-party REST reference, no first-party API-key
 * dashboard, and its entire content is a single line pointing developers to
 * a partner - *"Get the power of Pika's video models from the comfort of
 * your own product on Fal AI"* - linking out to `fal.ai`. `pika.art/faq` has
 * zero mentions of "API," "developer," or "integration." The only
 * confirmed-live, self-serve, documented path to Pika's models today is
 * **fal.ai hosting Pika's models as fal-branded endpoints**, under an
 * official Pika-fal partnership (`blog.fal.ai/pika-api-is-now-powered-by-
 * fal/`, dated 2025-12-05: *"Pika, the leading AI-powered video platform,
 * has partnered with fal to bring its powerful Model 2.2... directly
 * through our API and dashboard"*). A separate, non-self-serve legacy
 * enterprise/"Get in Touch" contact-sales track also exists on `pika.art`
 * itself, inherited from the Pika 1.0/1.5 era, but has no public reference
 * documentation to build a typed adapter against.
 *
 * **This adapter therefore talks to fal.ai's own REST API for the
 * `fal-ai/pika/v2.2/*` model family, not a Pika-owned endpoint.** Every
 * request/response field name below was read directly from fal.ai's own
 * live model-reference pages (`fal.ai/models/fal-ai/pika/v2.2/text-to-
 * video/api`, `.../image-to-video/api`), not reconstructed from memory.
 * `provider.name` remains `"pika"` (this adapter still represents "get me a
 * Pika-model video" from this package's own callers' point of view), but
 * this fact - hosted via fal, not a Pika-owned API - is the single most
 * important thing to understand about this specific adapter before relying
 * on it, so it is stated here plainly rather than buried.
 *
 * **Auth**: fal.ai's own platform-wide scheme, not Pika-specific:
 * `Authorization: Key <FAL_KEY>` (the literal word `Key`, not `Bearer`),
 * verified directly from fal.ai's own quickstart guide. One fal API key
 * authenticates every model fal hosts, not just Pika's.
 *
 * **Submit endpoints**: `POST https://queue.fal.run/fal-ai/pika/v2.2/text-
 * to-video` (no reference image) or `.../image-to-video` (a reference image
 * is given), fal's standard async queue pattern. Request body fields
 * verified directly from each endpoint's own live `/api` reference page.
 *
 * **Normalized param handling** (task 3):
 * - `durationSeconds`: honored, but translated to a string-enum shape:
 *   Pika-via-fal's own `duration` field accepts only `"5"` or `"10"`
 *   (verified directly from both endpoints' schemas). This adapter maps any
 *   `durationSeconds &lt;= 7` to `"5"` and anything greater to `"10"`.
 * - `aspectRatio`: honored for text-to-video only (fal's own `aspect_ratio`
 *   enum - `16:9`, `9:16`, `1:1`, `4:5`, `5:4`, `3:2`, `2:3` - already
 *   matches this package's own normalized string format for the values
 *   this adapter recognizes, so no translation table is needed).
 *   **Silently ignored for image-to-video**: the single-image `image-to-
 *   video` endpoint's own schema, verified directly, has no `aspect_ratio`
 *   field at all (only Pikascenes-style multi-image modes expose one, which
 *   this package's `VideoGenerationRequest` has no equivalent for), so this
 *   adapter omits the field entirely for that request shape.
 * - `seed`: honored directly. Both endpoints document a plain optional
 *   integer `seed` field; passed through unchanged when present, omitted
 *   when absent.
 *
 * **Reference images**: only `referenceImageUrls[0]` is used, sent as the
 * `image_to_video` endpoint's own `image_url` field (documented, per the
 * schema this research fetched, as accepting a hosted URL; base64 data-URI
 * support specifically for this Pika-branded endpoint was not confirmed
 * either way in this research, so this adapter only ever sends a URL
 * string, matching this package's own `ReferenceImageUrl` type). Every
 * later entry in `referenceImageUrls` is ignored (fal's own multi-image
 * "Pikascenes" mode, `fal-ai/pika/v2.2/pikascenes`, is a genuinely separate
 * endpoint this adapter does not call, since this package's own
 * `VideoGenerationRequest` has no `ingredients_mode`/scene-composition
 * concept to justify routing to it).
 *
 * **Polling/status model**: fal's own platform-wide async queue mechanism,
 * not Pika-specific, verified directly: `GET .../requests/{request_id}/
 * status` returns exactly one of `"IN_QUEUE"`, `"IN_PROGRESS"`,
 * `"COMPLETED"` (mapped to this package's `"pending"`, `"running"`, and
 * "check the result endpoint" respectively - `"COMPLETED"` at the *queue*
 * level does not by itself mean the generation succeeded, since fal's own
 * generic status schema carries `error`/`error_type` fields even on a
 * `"COMPLETED"` queue status; this adapter treats a populated `error` field
 * on the status response as a failure). Once genuinely completed with no
 * error, this adapter fetches `GET .../requests/{request_id}` for the final
 * result, `{ video: { url } }` (verified identically across text-to-video,
 * image-to-video, and other Pika-via-fal endpoints this research checked).
 * **The exact shape of a genuinely failed generation's error payload was
 * not confirmed against a real worked example in this research** (no
 * primary source this research found showed one) - this adapter's handling
 * of `error`/`error_type` is a reasonable, schema-consistent best effort,
 * not a verified-against-a-real-failure claim; treat it as best-effort per
 * this module's own doc rather than confirmed fact.
 *
 * **Notable constraints** (informational; see this module's own research
 * for full detail and confidence levels per claim): duration `5`/`10`
 * seconds only; aspect ratio one of seven values (text-to-video only);
 * resolution `720p`/`1080p` (this adapter does not currently set
 * `resolution`, leaving fal's own default in place, since this package's
 * own `VideoGenerationParams` has no resolution field); rate limiting is
 * concurrency-based (fal-wide, not Pika-specific): new accounts start at 2
 * concurrent requests, scaling up to 40 as credits are purchased, per fal's
 * own docs (a "20 generations per minute" figure repeated across several
 * low-quality secondary sources could not be verified against any primary
 * fal or pika.art source and should not be relied on).
 */

/** Options accepted by {@link createPikaProvider}. */
export interface PikaProviderOptions {
  /** fal.ai API key (`FAL_KEY` in fal's own docs), sent as `Authorization: Key <apiKey>`. Never hardcoded; always supplied by the caller. Despite the name "Pika," this is a fal.ai credential, not a Pika-issued one; see this module's own top-level doc for why. */
  apiKey: string;
  /** Injectable fetch-like function. Defaults to the real global `fetch`. Every test in this adapter's own suite supplies a fake. */
  fetchFn?: FetchLike;
  /** Base URL for fal's queue API. Defaults to {@link DEFAULT_FAL_QUEUE_BASE_URL}. Overridable for testing against a local mock server. */
  baseUrl?: string;
  /** Overrides for the shared `fetchWithRetry` helper's own options (`maxAttempts`/`baseDelayMs`/`maxDelayMs`/`sleepFn`), applied to every HTTP call this adapter makes. `fetchFn` here is ignored; this adapter's own top-level `fetchFn` option is always what is actually called. This adapter's own test suite overrides `sleepFn` with a no-op for every retry-scenario test, so exercising a retry/backoff path never costs real wall-clock time. */
  retryOptions?: Omit<FetchWithRetryOptions, "fetchFn">;
}

/** fal.ai's own queue API base URL, verified from its own quickstart/model-reference pages. */
export const DEFAULT_FAL_QUEUE_BASE_URL = "https://queue.fal.run";

/** The fal-branded Pika model this adapter targets: Pika 2.2, fal's currently-documented default Pika generation for both text-to-video and image-to-video. */
export const PIKA_MODEL_PATH = "fal-ai/pika/v2.2";

/** Every aspect ratio string this Pika-via-fal endpoint's own `aspect_ratio` enum accepts (text-to-video only), verified directly from the schema. */
const PIKA_ASPECT_RATIOS: ReadonlySet<string> = new Set(["16:9", "9:16", "1:1", "4:5", "5:4", "3:2", "2:3"]);

/** Threshold (in seconds) at or below which `durationSeconds` maps to Pika-via-fal's `"5"` enum value rather than `"10"`. */
const PIKA_DURATION_THRESHOLD_SECONDS = 7;

interface FalQueueSubmitResponse {
  request_id: string;
}

interface FalQueueStatusResponse {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
  error?: string | null;
  error_type?: string | null;
}

interface FalPikaResult {
  video?: { url?: string };
}

/** Extracts a descriptive error message from a non-2xx fal JSON response, falling back to a generic description if the body is not the expected `{ detail: string }` shape (fal's own generic FastAPI-style validation-error envelope). */
async function describeErrorResponse(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "detail" in body) {
      const detail = body.detail;
      if (typeof detail === "string") {
        return detail;
      }
      return JSON.stringify(detail);
    }
  } catch {
    // Body was not valid JSON at all; fall through to the generic message.
  }
  return `HTTP ${response.status}`;
}

/**
 * Creates a Pika-via-fal.ai-backed {@link VideoProvider}. See this module's
 * own top-level doc for why this talks to fal.ai rather than a Pika-owned
 * API, the full request/response shape this was verified against, and
 * exactly which normalized params it honors.
 */
export function createPikaProvider(options: PikaProviderOptions): VideoProvider {
  const baseUrl = options.baseUrl ?? DEFAULT_FAL_QUEUE_BASE_URL;

  function headers(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Key ${options.apiKey}` };
  }

  return {
    name: "pika",

    async submit(request: VideoGenerationRequest): Promise<VideoGenerationJob> {
      const fetchFn = options.fetchFn ?? defaultFetchLike();
      const hasReferenceImage = (request.referenceImageUrls?.length ?? 0) > 0;
      const endpoint = hasReferenceImage ? "image-to-video" : "text-to-video";

      const body: Record<string, unknown> = { prompt: request.prompt };

      if (request.params.durationSeconds !== undefined) {
        body.duration = request.params.durationSeconds <= PIKA_DURATION_THRESHOLD_SECONDS ? "5" : "10";
      }
      if (request.params.seed !== undefined) {
        body.seed = request.params.seed;
      }

      if (hasReferenceImage) {
        // referenceImageUrls is confirmed non-empty by hasReferenceImage above.
        body.image_url = (request.referenceImageUrls as string[])[0];
      } else if (
        request.params.aspectRatio !== undefined &&
        PIKA_ASPECT_RATIOS.has(request.params.aspectRatio)
      ) {
        body.aspect_ratio = request.params.aspectRatio;
      }

      const response = await fetchWithRetry(
        `${baseUrl}/${PIKA_MODEL_PATH}/${endpoint}`,
        { method: "POST", headers: headers(), body: JSON.stringify(body) },
        { ...options.retryOptions, fetchFn },
      );

      if (!response.ok) {
        throw new Error(`Pika (via fal.ai) submit failed: ${await describeErrorResponse(response)}`);
      }

      const parsed = (await response.json()) as FalQueueSubmitResponse;
      // The endpoint this job was submitted to (text-to-video vs
      // image-to-video) must be remembered for poll's own status/result
      // URLs, since fal's request_id alone does not carry it; encoded as a
      // prefix on externalJobId rather than growing VideoGenerationJob with
      // a Pika-specific extra field.
      return { provider: "pika", externalJobId: `${endpoint}:${parsed.request_id}` };
    },

    async poll(job: VideoGenerationJob): Promise<VideoGenerationStatus> {
      const fetchFn = options.fetchFn ?? defaultFetchLike();
      const separatorIndex = job.externalJobId.indexOf(":");
      if (separatorIndex === -1) {
        return {
          status: "failed",
          error: `Pika (via fal.ai) poll received a malformed externalJobId: ${job.externalJobId}`,
        };
      }
      const endpoint = job.externalJobId.slice(0, separatorIndex);
      const requestId = job.externalJobId.slice(separatorIndex + 1);
      const requestBasePath = `${baseUrl}/${PIKA_MODEL_PATH}/${endpoint}/requests/${requestId}`;

      const statusResponse = await fetchWithRetry(
        `${requestBasePath}/status`,
        { method: "GET", headers: headers() },
        { ...options.retryOptions, fetchFn },
      );

      if (!statusResponse.ok) {
        throw new Error(`Pika (via fal.ai) poll failed: ${await describeErrorResponse(statusResponse)}`);
      }

      const status = (await statusResponse.json()) as FalQueueStatusResponse;

      if (status.status === "IN_QUEUE") {
        return { status: "pending" };
      }
      if (status.status === "IN_PROGRESS") {
        return { status: "running" };
      }

      // status.status === "COMPLETED": this is fal's own queue-level
      // status, distinct from generation-level success; see this module's
      // own top-level doc for why a populated error field must still be
      // checked here.
      if (status.error !== null && status.error !== undefined) {
        return {
          status: "failed",
          error: status.error_type !== undefined && status.error_type !== null
            ? `${status.error} (${status.error_type})`
            : status.error,
        };
      }

      const resultResponse = await fetchWithRetry(
        requestBasePath,
        { method: "GET", headers: headers() },
        { ...options.retryOptions, fetchFn },
      );

      if (!resultResponse.ok) {
        throw new Error(`Pika (via fal.ai) poll failed: ${await describeErrorResponse(resultResponse)}`);
      }

      const result = (await resultResponse.json()) as FalPikaResult;
      const outputUrl = result.video?.url;
      if (outputUrl === undefined) {
        return {
          status: "failed",
          error: "Pika (via fal.ai) reported COMPLETED with no error but no video.url in the result.",
        };
      }
      return { status: "succeeded", outputUrl };
    },
  };
}
