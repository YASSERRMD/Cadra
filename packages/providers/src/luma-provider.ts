import { defaultFetchLike, type FetchLike } from "./fetch-like.js";
import { fetchWithRetry, type FetchWithRetryOptions } from "./retry.js";
import type {
  VideoGenerationJob,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoProvider,
} from "./video-provider.js";

/**
 * Luma AI (Dream Machine) adapter (Phase 34).
 *
 * **Research status: verified directly against Luma's own official OpenAPI
 * reference**, fetched from `docs.lumalabs.ai/reference/creategeneration.md`
 * and `.../getgeneration.md` (the `.md` suffix on these doc pages returns
 * the raw OpenAPI-derived schema rather than rendered HTML, and was fetched
 * twice independently during this research, returning byte-identical
 * output both times), cross-checked against Luma's own JS/TS SDK usage
 * example at `docs.lumalabs.ai/docs/javascript-video-generation`.
 *
 * **One flagged endpoint-path discrepancy, resolved in favor of the
 * higher-confidence source**: the OpenAPI reference's own `createGeneration`
 * operation is `POST /generations/video`, but a secondary, WebSearch-
 * synthesized curl example (not independently confirmed) showed `POST
 * /generations` with no `/video` suffix. This adapter uses `/generations/
 * video`, since it was read directly from the operation-level OpenAPI
 * schema rather than reconstructed from a secondary summary; a caller
 * hitting a real 404 against a live Luma account should double check this
 * before assuming a bug elsewhere in this adapter.
 *
 * **One flagged model-id discrepancy, deliberately left unresolved rather
 * than silently picking a side**: Luma's own marketing pages advertise a
 * newer "Ray3"/"Ray3.2" model family with a broader feature set (native
 * 1080p, up to 16 keyframes, HDR/EXR export) as "available as an API," but
 * the live OpenAPI reference's own `VideoModel` enum, fetched twice
 * independently, only ever listed exactly `"ray-2"` and `"ray-flash-2"` -
 * see {@link DEFAULT_LUMA_MODEL}'s own doc for why this adapter defaults to
 * `ray-2` rather than a Ray3-family id no schema fetch actually confirmed
 * as an accepted `model` value.
 *
 * **Normalized param handling** (task 3):
 * - `durationSeconds`: honored, but translated to Luma's own string-enum
 *   shape: Luma's `duration` field is documented as an enum of exactly
 *   `"5s"`/`"9s"` (confirming this research's own starting hypothesis), not
 *   an arbitrary number of seconds. This adapter maps any
 *   `durationSeconds &lt;= 7` to `"5s"` and anything greater to `"9s"`
 *   (documented here as this adapter's own rounding policy, since Luma's
 *   API itself only accepts these two literal strings and rejects anything
 *   else); omitted entirely, this adapter sends no `duration` field at all,
 *   letting Luma apply its own documented default.
 * - `aspectRatio`: honored directly. Luma's own `aspect_ratio` enum
 *   (`1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `21:9`, `9:21`) already matches
 *   this package's own normalized `"width:height"` string format for every
 *   value this adapter maps, so `params.aspectRatio` is passed straight
 *   through when it is one of those seven strings; an unrecognized value
 *   falls back to Luma's own documented default (`"16:9"`) by simply
 *   omitting the field, rather than sending a value Luma's own enum would
 *   reject.
 * - `seed`: **not supported, and not sent.** This research's own direct
 *   inspection of the `createGeneration` OpenAPI schema found no `seed`
 *   field anywhere (confirmed absent across the schema itself, the
 *   official JS SDK's own usage example, and the video-generation guide
 *   page), confirming this research's starting suspicion. This adapter
 *   silently drops `params.seed` if present, matching this package's own
 *   documented "adapter for a vendor with no seed support ignores it"
 *   policy.
 *
 * **Reference images**: Luma's own request shape genuinely diverges from
 * "one reference image array" here - verified directly from the OpenAPI
 * schema and the video-generation guide page, Luma accepts a `keyframes`
 * object with distinct `frame0` (start frame) and `frame1` (end frame)
 * slots, each an object with a `type` discriminator (`"image"`, with a
 * `url`, or `"generation"`, referencing a prior completed generation's own
 * `id` - this adapter only ever produces the `"image"` variant, since this
 * package's own `VideoGenerationRequest` has no concept of chaining onto a
 * prior generation). This adapter maps `referenceImageUrls[0]` to
 * `keyframes.frame0` (the start frame) and, if present,
 * `referenceImageUrls[1]` to `keyframes.frame1` (the end frame); any
 * further entries are ignored. A single reference image therefore produces
 * an image-to-video generation anchored at its start frame, and two
 * produce a start/end-frame interpolation, both genuinely different from
 * "pick the first image and ignore the rest" (every one of this phase's
 * other four vendors' adapters).
 *
 * **Polling/status model**: `GET /generations/{id}`, verified directly from
 * the OpenAPI schema. `state` takes one of exactly four documented values:
 * `queued`/`dreaming` (mapped to this package's `"pending"`/`"running"`
 * respectively), `completed` (mapped to `"succeeded"`, output URL at
 * `assets.video`), or `failed` (mapped to `"failed"`, message from the
 * plain-string `failure_reason` field). Luma's own docs additionally
 * expose a `assets.progress_video` field (a lower-quality preview available
 * while still `dreaming`) which this adapter does not currently surface,
 * since this package's own `VideoGenerationStatus` union has no
 * in-progress-preview concept.
 *
 * **Notable constraints** (see this module's own research for full detail
 * and confidence levels per claim): duration exactly `5s`/`9s`; aspect
 * ratio one of seven documented values (default `16:9`); resolution `540p`/
 * `720p`/`1080p`/`4k` (this adapter does not currently set `resolution`,
 * leaving Luma's own default in place, since this package's own
 * `VideoGenerationParams` has no resolution field); documented rate limit
 * (Build/default tier) of 10 concurrent video generations and 20 requests
 * per minute; no seed/reproducibility support at all.
 */

/** Options accepted by {@link createLumaProvider}. */
export interface LumaProviderOptions {
  /** Luma API key, sent as `Authorization: Bearer <apiKey>`. Never hardcoded; always supplied by the caller. */
  apiKey: string;
  /** Injectable fetch-like function. Defaults to the real global `fetch`. Every test in this adapter's own suite supplies a fake. */
  fetchFn?: FetchLike;
  /** Base URL for Luma's API. Defaults to {@link DEFAULT_LUMA_BASE_URL}. Overridable for testing against a local mock server. */
  baseUrl?: string;
  /**
   * Model id to request. Defaults to {@link DEFAULT_LUMA_MODEL}. Left
   * overridable rather than hardcoded further into this adapter's own
   * logic given the Ray3/Ray3.2 discrepancy described in this module's own
   * top-level doc: a caller who has independently confirmed a newer model
   * id is accepted by their own account can pass it here without waiting
   * on this package to catch up.
   */
  model?: string;
  /** Overrides for the shared `fetchWithRetry` helper's own options (`maxAttempts`/`baseDelayMs`/`maxDelayMs`/`sleepFn`), applied to every HTTP call this adapter makes. `fetchFn` here is ignored; this adapter's own top-level `fetchFn` option is always what is actually called. This adapter's own test suite overrides `sleepFn` with a no-op for every retry-scenario test, so exercising a retry/backoff path never costs real wall-clock time. */
  retryOptions?: Omit<FetchWithRetryOptions, "fetchFn">;
}

/** Luma's own current API base URL, verified from the OpenAPI spec's `servers` array. */
export const DEFAULT_LUMA_BASE_URL = "https://api.lumalabs.ai/dream-machine/v1";

/**
 * Default Luma model id. **This default is a best-effort, deliberately
 * conservative choice, not a "the newer model is definitely better and
 * definitely supported" claim**: this research found `ray-2` and
 * `ray-flash-2` as the only two values actually present in the live
 * `createGeneration` OpenAPI schema's own `VideoModel` enum (fetched twice,
 * identically), despite Luma's own marketing pages separately advertising a
 * newer Ray3/Ray3.2 model family as "available as an API." This constant
 * picks `ray-2` specifically because it is the OpenAPI schema's own
 * documented *default* value for this field, not merely one of the two
 * listed options - the safest, most conservative choice given the
 * discrepancy. See this module's own top-level doc for the full
 * discrepancy; a caller who has confirmed their account accepts a newer
 * model id should pass `LumaProviderOptions.model` explicitly rather than
 * relying on this constant to have already caught up.
 */
export const DEFAULT_LUMA_MODEL = "ray-2";

/** Luma's own documented default aspect ratio, used as this adapter's fallback whenever `params.aspectRatio` is omitted or not one of Luma's seven recognized values. */
export const DEFAULT_LUMA_ASPECT_RATIO = "16:9";

/** Every aspect ratio string Luma's own `aspect_ratio` enum accepts, verified directly from the OpenAPI schema. */
const LUMA_ASPECT_RATIOS: ReadonlySet<string> = new Set([
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "21:9",
  "9:21",
]);

/** Threshold (in seconds) at or below which `durationSeconds` maps to Luma's `"5s"` enum value rather than `"9s"`; see this module's own top-level doc for why this rounding policy exists at all. */
const LUMA_DURATION_THRESHOLD_SECONDS = 7;

interface LumaKeyframeImage {
  type: "image";
  url: string;
}

interface LumaGeneration {
  id: string;
  state?: "queued" | "dreaming" | "completed" | "failed";
  failure_reason?: string | null;
  assets?: { video?: string };
}

/** Extracts a descriptive error message from a non-2xx Luma JSON response, falling back to a generic description if the body is not the expected `{ detail: string }` shape. */
async function describeErrorResponse(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "detail" in body && typeof body.detail === "string") {
      return body.detail;
    }
  } catch {
    // Body was not valid JSON at all; fall through to the generic message.
  }
  return `HTTP ${response.status}`;
}

/**
 * Creates a Luma AI (Dream Machine)-backed {@link VideoProvider}. See this
 * module's own top-level doc for the full request/response shape this was
 * verified against, exactly which normalized params it honors, and the
 * `frame0`/`frame1` keyframe mapping used for reference images.
 */
export function createLumaProvider(options: LumaProviderOptions): VideoProvider {
  const baseUrl = options.baseUrl ?? DEFAULT_LUMA_BASE_URL;
  const model = options.model ?? DEFAULT_LUMA_MODEL;

  function headers(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` };
  }

  return {
    name: "luma",

    async submit(request: VideoGenerationRequest): Promise<VideoGenerationJob> {
      const fetchFn = options.fetchFn ?? defaultFetchLike();

      const body: Record<string, unknown> = { prompt: request.prompt, model };

      const aspectRatio =
        request.params.aspectRatio !== undefined && LUMA_ASPECT_RATIOS.has(request.params.aspectRatio)
          ? request.params.aspectRatio
          : undefined;
      if (aspectRatio !== undefined) {
        body.aspect_ratio = aspectRatio;
      }

      if (request.params.durationSeconds !== undefined) {
        body.duration = request.params.durationSeconds <= LUMA_DURATION_THRESHOLD_SECONDS ? "5s" : "9s";
      }

      const referenceImages = request.referenceImageUrls ?? [];
      if (referenceImages.length > 0) {
        const keyframes: Record<string, LumaKeyframeImage> = {
          frame0: { type: "image", url: referenceImages[0] as string },
        };
        const frame1Url = referenceImages[1];
        if (frame1Url !== undefined) {
          keyframes.frame1 = { type: "image", url: frame1Url };
        }
        body.keyframes = keyframes;
      }

      const response = await fetchWithRetry(
        `${baseUrl}/generations/video`,
        { method: "POST", headers: headers(), body: JSON.stringify(body) },
        { ...options.retryOptions, fetchFn },
      );

      if (!response.ok) {
        throw new Error(`Luma submit failed: ${await describeErrorResponse(response)}`);
      }

      const parsed = (await response.json()) as LumaGeneration;
      return { provider: "luma", externalJobId: parsed.id };
    },

    async poll(job: VideoGenerationJob): Promise<VideoGenerationStatus> {
      const fetchFn = options.fetchFn ?? defaultFetchLike();

      const response = await fetchWithRetry(
        `${baseUrl}/generations/${job.externalJobId}`,
        { method: "GET", headers: headers() },
        { ...options.retryOptions, fetchFn },
      );

      if (!response.ok) {
        throw new Error(`Luma poll failed: ${await describeErrorResponse(response)}`);
      }

      const parsed = (await response.json()) as LumaGeneration;
      switch (parsed.state) {
        case "queued":
          return { status: "pending" };
        case "dreaming":
          return { status: "running" };
        case "completed": {
          const outputUrl = parsed.assets?.video;
          if (outputUrl === undefined) {
            return { status: "failed", error: "Luma reported completed with no assets.video url." };
          }
          return { status: "succeeded", outputUrl };
        }
        case "failed":
          return {
            status: "failed",
            error: parsed.failure_reason ?? "Luma reported the generation as failed with no failure_reason.",
          };
        default:
          return {
            status: "failed",
            error: `Luma returned an unrecognized state: ${JSON.stringify(parsed)}`,
          };
      }
    },
  };
}
