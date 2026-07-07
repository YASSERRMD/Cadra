import { defaultFetchLike, type FetchLike } from "./fetch-like.js";
import { fetchWithRetry, type FetchWithRetryOptions } from "./retry.js";
import type {
  VideoGenerationJob,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoProvider,
} from "./video-provider.js";

/**
 * Google Veo adapter (Phase 34), built against the **Gemini API** (the
 * self-serve, API-key-authenticated developer surface), not Vertex AI
 * (GCP-project/service-account-authenticated, enterprise-oriented) and not
 * "Flow."
 *
 * **Research status: mostly verified directly against Google's own official
 * docs**, with one important gap flagged explicitly below.
 *
 * - **Confirmed: Flow has no public developer API of its own.** Google's own
 *   blog post (`blog.google/technology/ai/veo-updates-flow/`) states plainly
 *   that the Veo model is "available via the Gemini API for developers,
 *   Vertex AI for enterprise customers, and the Gemini app" - Flow itself is
 *   a consumer/creator-facing app built on top of that same Veo model, not a
 *   separate API surface a third party can integrate against. This is the
 *   one point this phase's own research task explicitly anticipated might be
 *   true for a named vendor ("the naming has changed" / marketed jointly
 *   with another product), and it is: this adapter targets the Gemini API's
 *   Veo model endpoint directly, which is the real, current, official way
 *   to generate a Veo video programmatically.
 * - **Verified directly** (literal curl bodies reproduced from
 *   `ai.google.dev/gemini-api/docs/veo`): the submit endpoint
 *   (`:predictLongRunning`), the `x-goog-api-key` auth header, the
 *   `instances[0].prompt`/`image`/`parameters` request shape, the
 *   long-running-`Operation` response envelope (`name`/`done`), the poll
 *   endpoint (`GET /v1beta/{operation_name}`), and the exact success JSON
 *   path (`response.generateVideoResponse.generatedSamples[0].video.uri`).
 * - **Left uncertain, flagged rather than guessed**: the *failed*-operation
 *   JSON shape. No Veo-specific documentation page this research turned up
 *   shows a worked example of a failed operation; this adapter assumes
 *   Google's standard cross-API long-running-operation error envelope
 *   (`{ "done": true, "error": { "code": number, "message": string } }`,
 *   the same shape used by every other Google API's Operations pattern),
 *   which is a reasonable, well-established default but was not confirmed
 *   against a Veo-specific worked example. Which current model id to
 *   default to is *also* left deliberately uncertain/configurable rather
 *   than hardcoded with false confidence: at the time of this research,
 *   `veo-2.0-generate-001`'s own documented shutdown date had already
 *   passed, and the exact GA-vs-preview id split between
 *   `veo-3.0-generate-001`/`veo-3.1-generate-001`/`veo-3.1-generate-preview`
 *   carried conflicting secondary signals with no primary-source page this
 *   research could pin down conclusively; see {@link DEFAULT_VEO_MODEL}'s
 *   own doc.
 *
 * **Normalized param handling** (task 3):
 * - `durationSeconds`: honored, passed through as `parameters
 *   .durationSeconds` verbatim (Veo's own API accepts this as a plain
 *   number, not a narrow enum, per the official `@google/genai` TypeScript
 *   SDK's `GenerateVideosConfig` type) whenever provided; omitted from the
 *   request when absent, letting Veo apply its own model-specific default
 *   (documented as 8 seconds for the current Veo 3.1 flagship, per that
 *   model's own model-card page, but this adapter does not hardcode that
 *   assumption into the request body itself).
 * - `aspectRatio`: honored directly. Veo's own `parameters.aspectRatio`
 *   field is a plain string, and the two values this research's primary
 *   sources actually exercised in a curl example (`"16:9"`, `"9:16"`)
 *   happen to already be this package's own normalized format, so this
 *   adapter passes `params.aspectRatio` straight through with no
 *   translation table, unlike Runway's pixel-dimension-ratio enum.
 * - `seed`: honored, passed through as `parameters.seed` (documented as a
 *   uint32, 0 to 4294967295, and documented as producing deterministic
 *   output given otherwise-identical inputs).
 *
 * **Reference images**: only `referenceImageUrls[0]` is used, as the "first
 * frame" `instances[0].image` input. Veo's own API accepts this as inline
 * base64 bytes (`inlineData.data`/`inlineData.mimeType`), not a fetchable
 * URL, unlike every one of this phase's other four vendors - this is a
 * genuine, documented divergence from a simple "pass the URL through"
 * shape, not an oversight; since this package's own `ReferenceImageUrl` is
 * a URL (this package deliberately does not fetch/re-encode bytes on a
 * caller's behalf, matching every other adapter's "vendor fetches URLs
 * itself" behavior), this adapter cannot forward a `referenceImageUrls`
 * entry to Veo's `image` field without first downloading and base64-encoding
 * it, which is out of scope for this phase (this adapter's own `submit`
 * throws a clear, descriptive error if `referenceImageUrls` is non-empty,
 * rather than silently ignoring the caller's image-to-video request or
 * fabricating a plausible-looking base64 payload it never actually sent).
 * Veo's `referenceImages`/`lastFrame`/`video` (video-extension) fields are
 * real per the SDK's own type reference but are out of this phase's scope
 * entirely (this package's own `VideoGenerationRequest` has no equivalent
 * fields for them).
 *
 * **Polling/status model**: submit returns a Google long-running
 * `Operation` (`{ name, done }`); poll re-fetches that same operation by
 * name. `done: false` (or absent) maps to `"running"` (this adapter does not
 * distinguish a `"pending"` sub-state within a not-yet-`done` operation,
 * since Google's own Operation shape does not expose one); `done: true`
 * with a populated `response` maps to `"succeeded"`; `done: true` with a
 * populated `error` maps to `"failed"`. Google's own docs recommend polling
 * roughly every 10 seconds.
 *
 * **Notable constraints** (see this module's own research for full detail
 * and confidence levels per claim): duration documented as 4, 6, or 8
 * seconds for the current Veo 3.x model family; aspect ratios `16:9`/`9:16`;
 * resolutions `720p`/`1080p`/`4k` depending on model variant; the completed
 * video's downloadable `uri` is documented as expiring approximately 2 days
 * after generation (medium confidence, not re-confirmed verbatim against a
 * primary source in this research - a caller should not assume a
 * `VideoGenerationSucceeded.outputUrl` from this adapter remains valid
 * indefinitely); no Veo-specific requests-per-minute rate-limit figure was
 * found in Google's own static rate-limit docs (the docs point to a live
 * per-account dashboard instead), so this adapter cannot document a fixed
 * number here.
 */

/** Options accepted by {@link createVeoProvider}. */
export interface VeoProviderOptions {
  /** Gemini API key, sent as the `x-goog-api-key` header. Never hardcoded; always supplied by the caller. */
  apiKey: string;
  /** Injectable fetch-like function. Defaults to the real global `fetch`. Every test in this adapter's own suite supplies a fake. */
  fetchFn?: FetchLike;
  /** Base URL for the Gemini API. Defaults to {@link DEFAULT_GEMINI_BASE_URL}. Overridable for testing against a local mock server. */
  baseUrl?: string;
  /**
   * Model id to request, e.g. `"veo-3.1-generate-preview"`. Defaults to
   * {@link DEFAULT_VEO_MODEL}. Deliberately left as a required-to-consider,
   * easily-overridable option rather than a single confidently hardcoded
   * default baked deep into this adapter's request-building logic: see
   * {@link DEFAULT_VEO_MODEL}'s own doc for why the current model-id
   * landscape for Veo was left uncertain by this phase's own research.
   */
  model?: string;
  /** Overrides for the shared `fetchWithRetry` helper's own options (`maxAttempts`/`baseDelayMs`/`maxDelayMs`/`sleepFn`), applied to every HTTP call this adapter makes. `fetchFn` here is ignored; this adapter's own top-level `fetchFn` option is always what is actually called. This adapter's own test suite overrides `sleepFn` with a no-op for every retry-scenario test, so exercising a retry/backoff path never costs real wall-clock time. */
  retryOptions?: Omit<FetchWithRetryOptions, "fetchFn">;
}

/** The Gemini API's own base URL, verified from `ai.google.dev/gemini-api/docs/veo`'s own curl examples. */
export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

/**
 * Default Veo model id requested when `VeoProviderOptions.model` is
 * omitted.
 *
 * **This default is a best-effort choice, not a confidently-verified
 * "this is definitely the right current model id" claim**: this research
 * found `veo-2.0-generate-001` explicitly documented as deprecated with a
 * shutdown date that had already passed by the time this phase was
 * implemented (do not use it); found `veo-3.1-generate-preview` and
 * `veo-3.1-lite-generate-preview` listed on Google's own canonical
 * models-list page (`ai.google.dev/gemini-api/docs/models`), both still
 * carrying a "Preview" label; and found conflicting, only
 * secondary-source-corroborated signals (not resolved against a single
 * authoritative primary-source page) about whether a distinct, more
 * GA-flavored `veo-3.0-generate-001` or `veo-3.1-generate-001` id also
 * exists and is preferred for production use over the `-preview` id. This
 * constant picks `veo-3.1-generate-preview` specifically because it is the
 * one id this research verified was actually listed, live, on Google's own
 * canonical model list at research time - not because "preview" is
 * generally the right production choice. A caller building against this
 * adapter for a real, current production integration should independently
 * confirm the current best model id against Google's own live model list
 * (or a `ListModels` call) rather than trusting this constant to still be
 * correct; that is exactly why this is a plain, overridable string option
 * and not baked further into this adapter's own logic.
 */
export const DEFAULT_VEO_MODEL = "veo-3.1-generate-preview";

interface VeoOperation {
  name: string;
  done?: boolean;
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string } }>;
    };
  };
  error?: { code?: number; message?: string };
}

/** Extracts a descriptive error message from a non-2xx Gemini API JSON response, falling back to a generic description if the body is not the expected `{ error: { message } }` shape (Google's standard cross-API error envelope). */
async function describeErrorResponse(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
    ) {
      return body.error.message;
    }
  } catch {
    // Body was not valid JSON at all; fall through to the generic message.
  }
  return `HTTP ${response.status}`;
}

/**
 * Creates a Google Veo-backed {@link VideoProvider} (via the Gemini API).
 * See this module's own top-level doc for the full request/response shape
 * this was verified against, exactly which normalized params it honors, and
 * why `referenceImageUrls` is currently unsupported (throws rather than
 * silently ignored - see that doc section for why).
 */
export function createVeoProvider(options: VeoProviderOptions): VideoProvider {
  const baseUrl = options.baseUrl ?? DEFAULT_GEMINI_BASE_URL;
  const model = options.model ?? DEFAULT_VEO_MODEL;

  function headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-goog-api-key": options.apiKey,
    };
  }

  return {
    name: "veo",

    async submit(request: VideoGenerationRequest): Promise<VideoGenerationJob> {
      if ((request.referenceImageUrls?.length ?? 0) > 0) {
        throw new Error(
          "createVeoProvider: image-to-video is not supported by this adapter. Veo's Gemini API " +
            "requires the reference image as inline base64 bytes, not a fetchable URL, and this " +
            "package does not fetch/re-encode a caller's referenceImageUrls on their behalf. Submit " +
            "a text-to-video request (no referenceImageUrls) instead.",
        );
      }

      const fetchFn = options.fetchFn ?? defaultFetchLike();

      const parameters: Record<string, unknown> = {};
      if (request.params.aspectRatio !== undefined) {
        parameters.aspectRatio = request.params.aspectRatio;
      }
      if (request.params.durationSeconds !== undefined) {
        parameters.durationSeconds = request.params.durationSeconds;
      }
      if (request.params.seed !== undefined) {
        parameters.seed = request.params.seed;
      }

      const body = {
        instances: [{ prompt: request.prompt }],
        ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
      };

      const response = await fetchWithRetry(
        `${baseUrl}/v1beta/models/${model}:predictLongRunning`,
        { method: "POST", headers: headers(), body: JSON.stringify(body) },
        { ...options.retryOptions, fetchFn },
      );

      if (!response.ok) {
        throw new Error(`Veo submit failed: ${await describeErrorResponse(response)}`);
      }

      const parsed = (await response.json()) as VeoOperation;
      return { provider: "veo", externalJobId: parsed.name };
    },

    async poll(job: VideoGenerationJob): Promise<VideoGenerationStatus> {
      const fetchFn = options.fetchFn ?? defaultFetchLike();

      const response = await fetchWithRetry(
        `${baseUrl}/v1beta/${job.externalJobId}`,
        { method: "GET", headers: headers() },
        { ...options.retryOptions, fetchFn },
      );

      if (!response.ok) {
        throw new Error(`Veo poll failed: ${await describeErrorResponse(response)}`);
      }

      const parsed = (await response.json()) as VeoOperation;

      if (parsed.done !== true) {
        return { status: "running" };
      }

      if (parsed.error !== undefined) {
        return {
          status: "failed",
          error: parsed.error.message ?? `Veo operation failed with code ${parsed.error.code ?? "unknown"}.`,
        };
      }

      const outputUrl = parsed.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (outputUrl === undefined) {
        return {
          status: "failed",
          error: "Veo reported the operation done with no error and no generated sample video uri.",
        };
      }
      return { status: "succeeded", outputUrl };
    },
  };
}
