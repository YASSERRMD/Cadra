import { defaultFetchLike, type FetchLike } from "./fetch-like.js";
import { fetchWithRetry, type FetchWithRetryOptions } from "./retry.js";
import type {
  VideoGenerationJob,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoProvider,
} from "./video-provider.js";

/**
 * Kling (Kuaishou) adapter (Phase 34).
 *
 * **Research status: verified directly against Kling's own official
 * developer documentation**, found live at `kling.ai/document-api` (the
 * international-facing official domain; `klingai.com` mirrors the same
 * documentation tree), not at the `docs.qingque.cn`-style URL this phase's
 * research initially guessed at. The docs snapshot used for this adapter was
 * dated 2026/04/01 by its own "Last updated" footer.
 *
 * **Auth: two parallel schemes exist, and this adapter supports the older,
 * more broadly-compatible one.** Kling's docs describe:
 * 1. A newer, simpler static "API Key" (`Authorization: Bearer <API_KEY>`),
 *    positioned as the future default, but documented (as of this
 *    research) as not yet universally supported by every one of Kling's own
 *    first-party integrations.
 * 2. The legacy Access Key (AK) + Secret Key (SK) scheme (confirmed as this
 *    research's original hypothesis): a self-signed JWT, header `{"alg":
 *    "HS256", "typ": "JWT"}`, payload `{"iss": <AK>, "exp": now + 1800,
 *    "nbf": now - 5}`, HMAC-SHA256-signed with the SK, sent as
 *    `Authorization: Bearer <jwt>`. This is verified directly from Kling's
 *    own official Python sample code, reproduced in this module's own
 *    `signKlingJwt` doc.
 *
 * This adapter implements the AK/SK JWT path (`KlingProviderOptions
 * .accessKey`/`.secretKey`), since it is documented as the more broadly
 * compatible option today even though the newer bearer-token API key is
 * positioned as Kling's own long-term direction; a future phase can add a
 * simpler `apiKey`-only construction path once that newer scheme is
 * confirmed universally supported. JWT signing uses the Web Crypto API's
 * `crypto.subtle` (HMAC-SHA256), available natively in both Node.js and
 * every browser this codebase already targets, rather than pulling in a
 * JWT-signing dependency for a three-field, well-specified token.
 *
 * **Base URL**: `https://api-singapore.klingai.com` for non-China traffic
 * (Kling's own docs note the base host changed from the older
 * `api.klingai.com`, which remains in use only for China-based callers);
 * kept fully overridable via `KlingProviderOptions.baseUrl` rather than
 * hardcoded, since which host is correct depends on the caller's own
 * region.
 *
 * **Submit endpoints**: `POST /v1/videos/text2video` (no reference image)
 * or `POST /v1/videos/image2video` (a reference image is given), verified
 * directly from Kling's own model-version documentation pages. Both accept
 * a shared `model_name` field (this adapter requests {@link KLING_MODEL}),
 * `prompt`, `duration`, and (text2video only) `aspect_ratio`.
 *
 * **Normalized param handling** (task 3):
 * - `durationSeconds`: honored, but translated to Kling's own string-enum
 *   shape: Kling's `duration` field is documented as a string enum of whole
 *   seconds from `"3"` to `"15"` (not an arbitrary number, and not just
 *   `"5"`/`"10"` as this research's own starting hypothesis assumed - that
 *   narrower range was true of an earlier Kling API version), defaulting to
 *   `"5"`. This adapter rounds `durationSeconds` to the nearest integer,
 *   clamps it into `[3, 15]`, and sends it as a string, matching Kling's own
 *   documented type.
 * - `aspectRatio`: honored for `text2video` requests only (Kling's own
 *   `aspect_ratio` field, enum `16:9`/`9:16`/`1:1`, already matches this
 *   package's own normalized string format exactly, so no translation table
 *   is needed - unlike Runway). **Silently ignored for `image2video`
 *   requests**: Kling's own image-to-video documentation does not expose an
 *   `aspect_ratio` field at all (the output aspect ratio is instead derived
 *   from the input reference image's own dimensions), so this adapter omits
 *   the field entirely for that request shape rather than sending a
 *   parameter Kling's API does not define.
 * - `seed`: **not supported, and not sent.** Kling's own request schemas
 *   (checked directly against the 3.0 Omni and 2.6 model documentation
 *   pages) have no `seed` field anywhere; this adapter silently drops
 *   `params.seed` if present, matching this package's own documented
 *   "adapter for a vendor with no seed support ignores it" policy (see
 *   `VideoGenerationParams.seed`'s own doc).
 *
 * **Reference images**: only `referenceImageUrls[0]` is used, sent as
 * Kling's own `image` field, which (per Kling's own docs) accepts either an
 * HTTPS URL or raw base64 image data (explicitly *not* a `data:` URI with a
 * prefix - Kling's docs warn against including one). This adapter passes
 * whatever string it is given straight through unmodified; a caller
 * supplying inline base64 data rather than a URL in `referenceImageUrls`
 * would work identically, though this package's own `ReferenceImageUrl`
 * type is documented as a URL, so a real Cadra caller is expected to supply
 * one.
 *
 * **Polling/status model**: `GET /v1/videos/{text2video|image2video}
 * /{task_id}`, verified directly from Kling's own docs. `data.task_status`
 * takes one of four values: `submitted`/`processing` (both mapped to this
 * package's `"pending"`/`"running"` respectively - `submitted` before any
 * work has begun, `processing` once generation is underway), `succeed`
 * (mapped to `"succeeded"`, output URL at
 * `data.task_result.videos[0].url`), or `failed` (mapped to `"failed"`,
 * message from `data.task_status_msg`). Kling's own docs additionally
 * describe a *second*, differently-shaped status vocabulary
 * (`status`/`succeeded` rather than `task_status`/`succeed`) used only for
 * push-callback payloads on newer model generations (Kling 3.0 Turbo and
 * later) - this adapter does not implement callbacks at all (this package's
 * own `VideoProvider` interface is poll-only, per its own doc), and the
 * polling endpoint itself was confirmed in this research to still return
 * the legacy `task_status`/`succeed` shape even for newer models, so this
 * divergence does not affect this adapter's own poll implementation.
 * Generated assets are documented as deleted after 30 days; this adapter
 * does not itself download or cache the output.
 *
 * **Notable constraints**: duration 3-15 whole seconds (string enum);
 * aspect ratio `16:9`/`9:16`/`1:1` for text2video only; no seed/
 * reproducibility support at all; Kling's own docs state explicitly "The
 * system does not impose any QPS limits," using a concurrency cap (maximum
 * simultaneous in-flight tasks) instead of a requests-per-minute limit -
 * this does not change how this adapter's own shared `fetchWithRetry` seam
 * behaves (it still retries any `429`/`5xx` it happens to receive), but a
 * caller should not expect this vendor's own rate limiting to look like a
 * classic per-minute cap.
 */

/** Options accepted by {@link createKlingProvider}. */
export interface KlingProviderOptions {
  /** Kling Access Key (AK), used as the JWT's `iss` claim. Never hardcoded; always supplied by the caller. */
  accessKey: string;
  /** Kling Secret Key (SK), used to HMAC-SHA256-sign the JWT. Never hardcoded; always supplied by the caller. */
  secretKey: string;
  /** Injectable fetch-like function. Defaults to the real global `fetch`. Every test in this adapter's own suite supplies a fake. */
  fetchFn?: FetchLike;
  /** Base URL for Kling's API. Defaults to {@link DEFAULT_KLING_BASE_URL}. Overridable for testing against a local mock server, or to target the China-region `api.klingai.com` host instead. */
  baseUrl?: string;
  /** Overrides for the shared `fetchWithRetry` helper's own options (`maxAttempts`/`baseDelayMs`/`maxDelayMs`/`sleepFn`), applied to every HTTP call this adapter makes. `fetchFn` here is ignored; this adapter's own top-level `fetchFn` option is always what is actually called. This adapter's own test suite overrides `sleepFn` with a no-op for every retry-scenario test, so exercising a retry/backoff path never costs real wall-clock time. */
  retryOptions?: Omit<FetchWithRetryOptions, "fetchFn">;
  /**
   * Injectable clock, returning the current time in seconds since the Unix
   * epoch, used to compute the JWT's `exp`/`nbf` claims. Defaults to a
   * real `Date.now()`-backed clock. Kept injectable so this adapter's own
   * test suite can assert an exact, deterministic JWT payload rather than
   * a payload with a real-wall-clock-dependent timestamp baked into it.
   */
  nowInSeconds?: () => number;
}

/** Kling's own current API base URL for non-China traffic; see this module's own doc for why this is configurable. */
export const DEFAULT_KLING_BASE_URL = "https://api-singapore.klingai.com";

/** Model id this adapter requests. `kling-v2-master`: a current, non-legacy model documented as valid for both `text2video` and `image2video` (unlike `kling-v1-5`/`kling-v2-1`, which this research found documented as `image2video`-only additions to the model enum). */
export const KLING_MODEL = "kling-v2-master";

/** Default duration (seconds) used when `params.durationSeconds` is omitted, matching Kling's own documented default. */
export const DEFAULT_DURATION_SECONDS = 5;

/** Default Kling `aspect_ratio` value used when `params.aspectRatio` is omitted (text2video requests only; see this module's own doc). */
export const DEFAULT_KLING_ASPECT_RATIO = "16:9";

/** JWT validity window in seconds, matching Kling's own official sample code (`exp: now + 1800`). */
const JWT_EXPIRY_SECONDS = 1800;

/** Backdating applied to the JWT's `nbf` claim, matching Kling's own official sample code (`nbf: now - 5`), to tolerate clock skew between this adapter's clock and Kling's own servers. */
const JWT_NOT_BEFORE_SKEW_SECONDS = 5;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Signs a Kling AK/SK JWT: header `{"alg": "HS256", "typ": "JWT"}`, payload
 * `{"iss": accessKey, "exp": nowInSeconds + 1800, "nbf": nowInSeconds - 5}`,
 * HMAC-SHA256-signed with `secretKey` via the Web Crypto API. Verified to
 * produce byte-identical output to Kling's own official `PyJWT`-based
 * Python sample for the same inputs (cross-checked while implementing this
 * adapter).
 */
async function signKlingJwt(accessKey: string, secretKey: string, nowInSeconds: number): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: accessKey,
    exp: Math.floor(nowInSeconds) + JWT_EXPIRY_SECONDS,
    nbf: Math.floor(nowInSeconds) - JWT_NOT_BEFORE_SKEW_SECONDS,
  };

  const encoder = new TextEncoder();
  const headerSegment = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadSegment = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerSegment}.${payloadSegment}`;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Clamps `value` to the closest integer within `[min, max]`. */
function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

interface KlingSubmitResponse {
  code: number;
  message: string;
  request_id: string;
  data: { task_id: string };
}

interface KlingPollResponse {
  code: number;
  message: string;
  request_id: string;
  data: {
    task_id: string;
    task_status: "submitted" | "processing" | "succeed" | "failed";
    task_status_msg?: string;
    task_result?: { videos?: Array<{ id: string; url: string }> };
  };
}

/**
 * Creates a Kling-backed {@link VideoProvider}. See this module's own
 * top-level doc for the full request/response shape this was verified
 * against, exactly which normalized params it honors, and the auth scheme
 * chosen.
 */
export function createKlingProvider(options: KlingProviderOptions): VideoProvider {
  const baseUrl = options.baseUrl ?? DEFAULT_KLING_BASE_URL;
  const nowInSeconds = options.nowInSeconds ?? (() => Date.now() / 1000);

  async function headers(): Promise<Record<string, string>> {
    const token = await signKlingJwt(options.accessKey, options.secretKey, nowInSeconds());
    return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  }

  /** Extracts a descriptive error message from a non-2xx Kling JSON response, falling back to a generic description if the body is not the expected `{ message: string }` shape. */
  async function describeErrorResponse(response: Response): Promise<string> {
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
        return body.message;
      }
    } catch {
      // Body was not valid JSON at all; fall through to the generic message.
    }
    return `HTTP ${response.status}`;
  }

  return {
    name: "kling",

    async submit(request: VideoGenerationRequest): Promise<VideoGenerationJob> {
      const fetchFn = options.fetchFn ?? defaultFetchLike();
      const hasReferenceImage = (request.referenceImageUrls?.length ?? 0) > 0;
      const endpoint = hasReferenceImage ? "/v1/videos/image2video" : "/v1/videos/text2video";

      const durationSeconds = clampInteger(
        request.params.durationSeconds ?? DEFAULT_DURATION_SECONDS,
        3,
        15,
      );

      const body: Record<string, unknown> = {
        model_name: KLING_MODEL,
        prompt: request.prompt,
        duration: String(durationSeconds),
      };
      if (hasReferenceImage) {
        // referenceImageUrls is confirmed non-empty by hasReferenceImage above.
        body.image = (request.referenceImageUrls as string[])[0];
      } else {
        // aspect_ratio is only a valid field for text2video; see this module's own doc.
        body.aspect_ratio = request.params.aspectRatio ?? DEFAULT_KLING_ASPECT_RATIO;
      }

      const response = await fetchWithRetry(
        `${baseUrl}${endpoint}`,
        { method: "POST", headers: await headers(), body: JSON.stringify(body) },
        { ...options.retryOptions, fetchFn },
      );

      if (!response.ok) {
        throw new Error(`Kling submit failed: ${await describeErrorResponse(response)}`);
      }

      const parsed = (await response.json()) as KlingSubmitResponse;
      return { provider: "kling", externalJobId: parsed.data.task_id };
    },

    async poll(job: VideoGenerationJob): Promise<VideoGenerationStatus> {
      const fetchFn = options.fetchFn ?? defaultFetchLike();

      // Kling's own polling endpoint is per-generation-type
      // (text2video/image2video); since a VideoGenerationJob carries no
      // memory of which endpoint originally created it, this adapter tries
      // text2video first and falls back to image2video on a 404, since a
      // task id namespace collision between the two is not documented and
      // this is the cheapest way to poll either kind of job through the
      // same VideoGenerationJob shape without this package inventing an
      // extra field Kling's own job id does not otherwise need.
      const textToVideoResponse = await fetchWithRetry(
        `${baseUrl}/v1/videos/text2video/${job.externalJobId}`,
        { method: "GET", headers: await headers() },
        { ...options.retryOptions, fetchFn },
      );

      const response =
        textToVideoResponse.status === 404
          ? await fetchWithRetry(
              `${baseUrl}/v1/videos/image2video/${job.externalJobId}`,
              { method: "GET", headers: await headers() },
              { ...options.retryOptions, fetchFn },
            )
          : textToVideoResponse;

      if (!response.ok) {
        throw new Error(`Kling poll failed: ${await describeErrorResponse(response)}`);
      }

      const parsed = (await response.json()) as KlingPollResponse;
      switch (parsed.data.task_status) {
        case "submitted":
          return { status: "pending" };
        case "processing":
          return { status: "running" };
        case "succeed": {
          const outputUrl = parsed.data.task_result?.videos?.[0]?.url;
          if (outputUrl === undefined) {
            return { status: "failed", error: "Kling reported succeed with no task_result video url." };
          }
          return { status: "succeeded", outputUrl };
        }
        case "failed":
          return {
            status: "failed",
            error: parsed.data.task_status_msg ?? "Kling reported the task as failed with no message.",
          };
        default:
          return {
            status: "failed",
            error: `Kling returned an unrecognized task_status: ${JSON.stringify(parsed.data)}`,
          };
      }
    },
  };
}
