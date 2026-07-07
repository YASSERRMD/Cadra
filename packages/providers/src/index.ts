/**
 * @cadra/providers
 *
 * Phase 34: generative video provider adapters that let Cadra scenes
 * incorporate output from external generative video services, behind one
 * provider-agnostic `VideoProvider` interface (`submit`/`poll`; see
 * `./video-provider.ts`) so callers can swap vendors without changing any
 * code beyond which adapter factory they construct.
 *
 * Every adapter's outbound HTTP calls go through the shared
 * `fetchWithRetry` helper (`./retry.ts`): exponential backoff on HTTP
 * `429`/`5xx`, bounded attempts, no retry on other 4xx failures - retry
 * behavior is implemented exactly once, not reinvented per adapter. Every
 * adapter also accepts an injectable `FetchLike` (`./fetch-like.ts`,
 * defaulting to the real global `fetch`), so this package's own test suite
 * never makes a real network call.
 *
 * Five adapters are implemented, one per vendor named in this phase's spec:
 *
 * - `createVeoProvider` (`./veo-provider.ts`): Google Veo, via the Gemini
 *   API (not Vertex AI, not "Flow" - Google's own blog confirms Flow has no
 *   public API of its own). A long-running-`Operation` submit/poll shape.
 *   Image-to-video is out of scope (Veo needs inline base64 image bytes,
 *   not a fetchable URL); `submit` throws a descriptive error rather than
 *   silently ignoring a `referenceImageUrls` request.
 * - `createRunwayProvider` (`./runway-provider.ts`): Runway, via its own
 *   documented developer API (`api.dev.runwayml.com`), verified directly
 *   against Runway's own official OpenAPI spec. A `gen4.5`-model task
 *   submit/poll shape with a six-value status union.
 * - `createKlingProvider` (`./kling-provider.ts`): Kling (Kuaishou), via its
 *   own official developer docs (`kling.ai/document-api`). Uses the legacy
 *   Access-Key/Secret-Key JWT auth scheme (HS256, signed with the Web
 *   Crypto API, zero new dependencies) rather than Kling's newer static API
 *   key, since AK/SK was documented as more broadly compatible at research
 *   time.
 * - `createLumaProvider` (`./luma-provider.ts`): Luma AI (Dream Machine),
 *   via its own official OpenAPI reference (`docs.lumalabs.ai`). Uses
 *   Luma's genuinely distinct `keyframes.frame0`/`frame1` reference-image
 *   shape rather than a flat image list.
 * - `createPikaProvider` (`./pika-provider.ts`): Pika. **Pika Labs has no
 *   first-party public developer API** - this adapter talks to fal.ai's own
 *   REST API instead, which hosts Pika's models under an official
 *   Pika-fal partnership; this is documented plainly in that adapter's own
 *   module doc, not papered over as if it were Pika's own endpoint.
 *
 * `VideoGenerationRequest.params` (`durationSeconds`/`aspectRatio`/`seed`)
 * is the one shared, normalized shape every adapter translates into that
 * vendor's own real request fields; see `../../docs/provider-capabilities.md`
 * for the full per-vendor honor/ignore/reject matrix and confidence-level
 * summary of what this phase's research verified against each vendor's real
 * documentation versus what remains best-effort, and each adapter's own
 * module doc for the complete detail behind that summary.
 *
 * Phase 35 adds the async job model generative video needs on top of these
 * adapters: `createGenerationStore` (`./generation-store.ts`) is a
 * content-hash-keyed dedup cache (`./request-hash.ts`'s
 * `hashVideoGenerationRequest`) plus a caller-named "generation slot"
 * concept (`submitGeneration`/`regenerateSlot`/`getSlotStatus`) tracking the
 * current and previous request for a stable id like a `VideoNode`'s own
 * `id`. `./placeholder.ts` defines the plain-data placeholder descriptor
 * (`solid`/`spinner`/`lastKnownFrame`) a pending/running slot resolves to,
 * so a preview or render path has something to show without blocking on the
 * vendor; this package does not draw any pixels for it (see that module's
 * own doc for the scope boundary with `packages/renderer`).
 */

export const VERSION = "0.0.0";

/** Identifies this package at runtime, useful for diagnostics. */
export const PACKAGE_NAME = "@cadra/providers";

export type { FetchLike } from "./fetch-like.js";
export { defaultFetchLike } from "./fetch-like.js";
export type {
  CreateGenerationStoreOptions,
  GenerationCacheEntry,
  GenerationSlot,
  GenerationStore,
  ProviderRegistry,
  RequestHash,
} from "./generation-store.js";
export {
  createGenerationStore,
  deriveRegeneratedRequest,
  UnknownProviderError,
  UnknownSlotError,
} from "./generation-store.js";
export type { KlingProviderOptions } from "./kling-provider.js";
export {
  createKlingProvider,
  DEFAULT_KLING_ASPECT_RATIO,
  DEFAULT_KLING_BASE_URL,
  DEFAULT_DURATION_SECONDS as KLING_DEFAULT_DURATION_SECONDS,
  KLING_MODEL,
} from "./kling-provider.js";
export type { LumaProviderOptions } from "./luma-provider.js";
export {
  createLumaProvider,
  DEFAULT_LUMA_ASPECT_RATIO,
  DEFAULT_LUMA_BASE_URL,
  DEFAULT_LUMA_MODEL,
} from "./luma-provider.js";
export type { PikaProviderOptions } from "./pika-provider.js";
export { createPikaProvider, DEFAULT_FAL_QUEUE_BASE_URL, PIKA_MODEL_PATH } from "./pika-provider.js";
export type {
  GenerationPlaceholder,
  LastKnownFramePlaceholder,
  PlaceholderColor,
  PlaceholderPreference,
  ResolvePlaceholderOptions,
  SlotFailed,
  SlotPending,
  SlotReady,
  SlotResolution,
  SolidPlaceholder,
  SpinnerPlaceholder,
} from "./placeholder.js";
export {
  DEFAULT_PLACEHOLDER_SOLID_COLOR,
  resolveGenerationStatus,
  resolvePlaceholder,
} from "./placeholder.js";
export { hashVideoGenerationRequest } from "./request-hash.js";
export type { FetchWithRetryOptions, SleepFn } from "./retry.js";
export {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_DELAY_MS,
  defaultSleepFn,
  fetchWithRetry,
} from "./retry.js";
export type { RunwayProviderOptions } from "./runway-provider.js";
export {
  createRunwayProvider,
  DEFAULT_RUNWAY_BASE_URL,
  DEFAULT_RUNWAY_RATIO,
  RUNWAY_API_VERSION,
  RUNWAY_ASPECT_RATIO_TO_RUNWAY_RATIO,
  DEFAULT_DURATION_SECONDS as RUNWAY_DEFAULT_DURATION_SECONDS,
  RUNWAY_MODEL,
} from "./runway-provider.js";
export type { VeoProviderOptions } from "./veo-provider.js";
export { createVeoProvider, DEFAULT_GEMINI_BASE_URL, DEFAULT_VEO_MODEL } from "./veo-provider.js";
export type {
  ReferenceImageUrl,
  VideoGenerationFailed,
  VideoGenerationJob,
  VideoGenerationParams,
  VideoGenerationPending,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoGenerationSucceeded,
  VideoProvider,
} from "./video-provider.js";
