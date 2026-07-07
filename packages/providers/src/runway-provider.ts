import { defaultFetchLike, type FetchLike } from "./fetch-like.js";
import { fetchWithRetry, type FetchWithRetryOptions } from "./retry.js";
import type {
  VideoGenerationJob,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoProvider,
} from "./video-provider.js";

/**
 * Runway adapter (Phase 34).
 *
 * **Research status: verified directly against Runway's own official OpenAPI
 * spec** (`https://raw.githubusercontent.com/runwayml/openapi/next/openapi.json`,
 * `info.version: "2024-11-06"`, published from `github.com/runwayml/openapi`),
 * cross-checked against `docs.dev.runwayml.com`'s own guides
 * (`/guides/using-the-api/`, `/guides/models/`, `/usage/tiers/`,
 * `/guides/pricing/`) and the official `@runwayml/sdk` Node SDK's README.
 * Every request/response field name below was read directly from that
 * OpenAPI JSON Schema, not reconstructed from memory or a secondary source.
 *
 * **Endpoints used**: `POST /v1/text_to_video` for a request with no
 * reference image, `POST /v1/image_to_video` for one with a reference
 * image, and `GET /v1/tasks/{id}` to poll either kind of job (Runway uses
 * one shared task-status shape for every generation type). Every request
 * carries two required headers: `Authorization: Bearer <key>` and
 * `X-Runway-Version: 2024-11-06` (the API's own versioning scheme is a
 * `const`-typed literal as of this research - no newer version has shipped
 * yet, so this is currently the only valid value, per
 * `docs.dev.runwayml.com/api-details/versioning/`).
 *
 * **Model chosen**: `gen4.5` (Runway's flagship model as of this research,
 * launched per Runway's own changelog on 2025-12-11), specifically because
 * it is one of the few models Runway offers under *both*
 * `/v1/text_to_video` and `/v1/image_to_video` with an identical
 * `duration`/`seed` range for each (Runway's older `gen4_turbo` model, by
 * contrast, is image-to-video only - it has no `text_to_video` variant at
 * all - so it could not serve a `VideoGenerationRequest` with no reference
 * image). Runway's per-model `oneOf` request-schema variants differ in
 * which fields are required/valid, so switching Cadra's own default model
 * here would require re-verifying that model's own schema, not just
 * swapping a string constant.
 *
 * **Normalized param handling** (task 3):
 * - `durationSeconds`: honored. `gen4.5` accepts an *integer* number of
 *   seconds from 2 to 10 inclusive for both endpoints (verified from the
 *   OpenAPI schema's own `minimum`/`maximum`). A non-integer is rounded to
 *   the nearest integer; a value outside `[2, 10]` is clamped into range
 *   (documented here rather than left to Runway's own 4xx rejection,
 *   since clamping a duration to the nearest valid value is a safe,
 *   meaning-preserving operation, unlike guessing a replacement for an
 *   unrecognized enum value). Omitted entirely, this adapter falls back to
 *   {@link DEFAULT_DURATION_SECONDS}.
 * - `aspectRatio`: honored, but translated: this package's own
 *   `"width:height"` normalized strings (e.g. `"16:9"`) do not match
 *   Runway's own `ratio` field, which is an enum of literal output *pixel
 *   dimensions* (e.g. `"1280:720"`), not a normalized ratio. See
 *   {@link RUNWAY_ASPECT_RATIO_TO_RUNWAY_RATIO} for the mapping this
 *   adapter uses; an unrecognized `aspectRatio` falls back to
 *   {@link DEFAULT_RUNWAY_RATIO} rather than being rejected, since Runway's
 *   own `ratio` enum is deliberately narrow (six values total for
 *   `gen4.5` image-to-video, only two for text-to-video) and this
 *   adapter's job is to pick the closest valid value, not to fail a
 *   request over an unmapped ratio string.
 * - `seed`: honored directly (Runway's `seed` is an integer 0 to
 *   4294967295, verified from the OpenAPI schema; passed through
 *   unchanged when present, omitted from the request body entirely when
 *   absent, letting Runway pick its own random seed as documented).
 *
 * **Reference images**: only `referenceImageUrls[0]` is used (Runway's
 * `promptImage` for these models accepts a single image reference, not a
 * list - though the raw JSON Schema does show a `PromptImages` array
 * variant, its own description reads "Only a `first` frame is supported",
 * i.e. it is schema scaffolding for at most one image, not genuine
 * multi-image support); every later entry in `referenceImageUrls` is
 * ignored. Accepts either an `https://` URL or a `data:image/...;base64,...`
 * data URI (both verified directly from the OpenAPI schema's own `anyOf`);
 * this adapter passes whatever string it is given straight through with no
 * validation of its own, since Runway's own API already validates the
 * format and this adapter has no reason to duplicate that check.
 *
 * **Polling/status model**: `GET /v1/tasks/{id}` returns one of six
 * `status` values (verified directly from the OpenAPI schema's
 * discriminated-union response): `PENDING`, `THROTTLED` (accepted but over
 * this account's concurrency limit, not yet started), `RUNNING` (carries a
 * `progress` fraction this adapter does not currently surface), `SUCCEEDED`
 * (carries `output`, an array of URIs - this adapter uses `output[0]`),
 * `FAILED` (carries `failure`, a human-readable string, and an optional
 * machine-readable `failureCode`), and `CANCELLED` (task was cancelled or
 * deleted; this adapter maps this to a `"failed"` status, since a cancelled
 * job will never produce output and a caller has no other terminal state to
 * observe it through). Runway's own docs note pollers should not expect
 * updates more often than once every five seconds per task; this adapter
 * does not itself enforce a polling interval (see `VideoProvider.poll`'s own
 * doc for why cadence is left to the caller).
 *
 * **Notable constraints** (verified from the OpenAPI schema and
 * `docs.dev.runwayml.com/usage/tiers/`): `gen4.5` duration 2-10 integer
 * seconds; `image_to_video` accepts six `ratio` values (`1280:720`,
 * `720:1280`, `1104:832`, `832:1104`, `960:960`, `1584:672`),
 * `text_to_video` only two (`1280:720`, `720:1280`); rate limiting is not a
 * requests-per-minute cap but a concurrency-limit-plus-daily-generation-cap
 * tiered by cumulative account spend (an over-limit submission is accepted
 * and returned as `THROTTLED`, not rejected with a `429` - though a genuine
 * `429`, e.g. from an actual burst-rate guard in front of the API, is still
 * handled by this adapter's shared `fetchWithRetry` call exactly like any
 * other adapter's).
 */

/** Options accepted by {@link createRunwayProvider}. */
export interface RunwayProviderOptions {
  /** Runway API key (`RUNWAYML_API_SECRET` in Runway's own docs), sent as `Authorization: Bearer <apiKey>`. Never hardcoded; always supplied by the caller. */
  apiKey: string;
  /** Injectable fetch-like function. Defaults to the real global `fetch`. Every test in this adapter's own suite supplies a fake. */
  fetchFn?: FetchLike;
  /** Base URL for Runway's API. Defaults to {@link DEFAULT_RUNWAY_BASE_URL}. Overridable for testing against a local mock server. */
  baseUrl?: string;
  /**
   * Overrides for the shared `fetchWithRetry` helper's own options
   * (`maxAttempts`/`baseDelayMs`/`maxDelayMs`/`sleepFn`), applied to every
   * HTTP call this adapter makes. `fetchFn` here is ignored (this adapter's
   * own top-level `fetchFn` option above is always what is actually
   * called); every other field passes straight through. This adapter's own
   * test suite overrides `sleepFn` with a no-op and `baseDelayMs` with `0`
   * for every retry-scenario test, so exercising a retry/backoff path never
   * costs real wall-clock time.
   */
  retryOptions?: Omit<FetchWithRetryOptions, "fetchFn">;
}

/** Runway's own current API base URL, verified from the OpenAPI spec's `servers[0].url`. */
export const DEFAULT_RUNWAY_BASE_URL = "https://api.dev.runwayml.com";

/** The only currently-valid `X-Runway-Version` value; see this module's own doc for why. */
export const RUNWAY_API_VERSION = "2024-11-06";

/** Model id this adapter requests; see this module's own doc for why `gen4.5` was chosen over `gen4_turbo`. */
export const RUNWAY_MODEL = "gen4.5";

/** Default duration (seconds) used when `params.durationSeconds` is omitted. The midpoint of `gen4.5`'s valid 2-10 range, a reasonable default clip length. */
export const DEFAULT_DURATION_SECONDS = 5;

/** Default Runway `ratio` value used when `params.aspectRatio` is omitted or unrecognized: 16:9 landscape at 1280x720, valid for both `text_to_video` and `image_to_video`. */
export const DEFAULT_RUNWAY_RATIO = "1280:720";

/**
 * Maps this package's normalized `"width:height"` aspect-ratio strings to
 * Runway's own `ratio` enum (literal output pixel dimensions), picking the
 * closest valid Runway value for each common ratio. Only entries valid for
 * *both* `text_to_video` and `image_to_video` are included as targets
 * (`1280:720`/`720:1280`), so a request never fails validation purely
 * because of which endpoint this adapter happened to route it to; the
 * additional four `image_to_video`-only ratios (`1104:832`, `832:1104`,
 * `960:960`, `1584:672`) are real, valid Runway values this adapter simply
 * does not map any normalized `aspectRatio` string onto, since doing so
 * would make an otherwise-identical request behave differently depending
 * on whether a reference image happened to be attached.
 */
export const RUNWAY_ASPECT_RATIO_TO_RUNWAY_RATIO: Readonly<Record<string, string>> = {
  "16:9": "1280:720",
  "9:16": "720:1280",
  "1:1": "1280:720",
};

/** Clamps `value` to the closest integer within `[min, max]`. */
function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

interface RunwaySuccessTaskResponse {
  id: string;
}

type RunwayTaskStatusResponse =
  | { id: string; status: "PENDING" | "THROTTLED" | "CANCELLED" }
  | { id: string; status: "RUNNING"; progress: number }
  | { id: string; status: "SUCCEEDED"; output: string[] }
  | { id: string; status: "FAILED"; failure: string; failureCode?: string };

/** Builds the shared request body fields common to both `gen4.5` text_to_video and image_to_video requests. */
function buildRunwayRequestBody(request: VideoGenerationRequest): Record<string, unknown> {
  const durationSeconds = clampInteger(request.params.durationSeconds ?? DEFAULT_DURATION_SECONDS, 2, 10);
  const ratio =
    (request.params.aspectRatio !== undefined
      ? RUNWAY_ASPECT_RATIO_TO_RUNWAY_RATIO[request.params.aspectRatio]
      : undefined) ?? DEFAULT_RUNWAY_RATIO;

  const body: Record<string, unknown> = {
    model: RUNWAY_MODEL,
    promptText: request.prompt,
    ratio,
    duration: durationSeconds,
  };
  if (request.params.seed !== undefined) {
    body.seed = request.params.seed;
  }
  return body;
}

/** Extracts the vendor error message from a non-2xx JSON response body, falling back to a generic description if the body is not the expected `{ error: string }` shape. */
async function describeErrorResponse(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Body was not valid JSON at all; fall through to the generic message.
  }
  return `HTTP ${response.status}`;
}

/**
 * Creates a Runway-backed {@link VideoProvider}. See this module's own
 * top-level doc for the full request/response shape this was verified
 * against, and exactly which normalized params it honors.
 */
export function createRunwayProvider(options: RunwayProviderOptions): VideoProvider {
  const baseUrl = options.baseUrl ?? DEFAULT_RUNWAY_BASE_URL;

  function headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
      "X-Runway-Version": RUNWAY_API_VERSION,
    };
  }

  return {
    name: "runway",

    async submit(request: VideoGenerationRequest): Promise<VideoGenerationJob> {
      const fetchFn = options.fetchFn ?? defaultFetchLike();
      const hasReferenceImage = (request.referenceImageUrls?.length ?? 0) > 0;
      const endpoint = hasReferenceImage ? "/v1/image_to_video" : "/v1/text_to_video";

      const body = buildRunwayRequestBody(request);
      if (hasReferenceImage) {
        // referenceImageUrls is confirmed non-empty by hasReferenceImage above.
        body.promptImage = (request.referenceImageUrls as string[])[0];
      }

      const response = await fetchWithRetry(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      }, { ...options.retryOptions, fetchFn });

      if (!response.ok) {
        throw new Error(`Runway submit failed: ${await describeErrorResponse(response)}`);
      }

      const parsed = (await response.json()) as RunwaySuccessTaskResponse;
      return { provider: "runway", externalJobId: parsed.id };
    },

    async poll(job: VideoGenerationJob): Promise<VideoGenerationStatus> {
      const fetchFn = options.fetchFn ?? defaultFetchLike();

      const response = await fetchWithRetry(`${baseUrl}/v1/tasks/${job.externalJobId}`, {
        method: "GET",
        headers: headers(),
      }, { ...options.retryOptions, fetchFn });

      if (!response.ok) {
        throw new Error(`Runway poll failed: ${await describeErrorResponse(response)}`);
      }

      const parsed = (await response.json()) as RunwayTaskStatusResponse;
      switch (parsed.status) {
        case "PENDING":
        case "THROTTLED":
          return { status: "pending" };
        case "RUNNING":
          return { status: "running" };
        case "SUCCEEDED": {
          const outputUrl = parsed.output[0];
          if (outputUrl === undefined) {
            return { status: "failed", error: "Runway reported SUCCEEDED with an empty output array." };
          }
          return { status: "succeeded", outputUrl };
        }
        case "FAILED":
          return {
            status: "failed",
            error: parsed.failureCode !== undefined ? `${parsed.failure} (${parsed.failureCode})` : parsed.failure,
          };
        case "CANCELLED":
          return { status: "failed", error: "Runway task was cancelled." };
        default:
          return {
            status: "failed",
            error: `Runway returned an unrecognized task status: ${JSON.stringify(parsed)}`,
          };
      }
    },
  };
}
