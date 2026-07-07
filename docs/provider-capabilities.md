# Generative video provider capabilities

`@cadra/providers` (Phase 34) implements the provider-agnostic `VideoProvider`
interface (`submit`/`poll`, see `packages/providers/src/video-provider.ts`)
against five vendors: Google Veo, Runway, Kling (Kuaishou), Luma AI (Dream
Machine), and Pika. Every vendor's real HTTP submit/poll shape differs; this
document records, per vendor, what was verified against that vendor's own
official documentation at the time this phase was implemented (mid-2026)
versus what remains best-effort/uncertain, which normalized
`VideoGenerationParams` fields it actually honors, its polling/status model,
and notable constraints.

This is a snapshot, not a live reference: generative video vendor APIs are
moving targets, and any of the shapes below may have changed since. Treat a
"verified" claim as "verified as of this phase's implementation," not as an
evergreen guarantee; consult that vendor's own current docs (linked below)
before relying on exact field names in a new integration. Every adapter's
own module doc (`packages/providers/src/*-provider.ts`) is the authoritative,
most detailed version of what is summarized here.

Every adapter routes its HTTP calls through the shared `fetchWithRetry`
helper (`packages/providers/src/retry.ts`): exponential backoff on HTTP
`429`/`5xx`, bounded attempts (default 3), no retry on other 4xx failures.
No adapter's own code implements retry logic itself.

## Normalized params honor/ignore/reject matrix

| Param             | Veo                                                        | Runway                                                                          | Kling                                                                                           | Luma                                                              | Pika (via fal.ai)                                                             |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `durationSeconds` | Honored, plain number field                                | Honored, clamped to integer 2-10s                                               | Honored, clamped to integer 3-15s, sent as a string                                             | Honored, rounded to the nearest of `"5s"`/`"9s"`                  | Honored, rounded to the nearest of `"5"`/`"10"`                               |
| `aspectRatio`     | Honored, passed through directly (`16:9`/`9:16` confirmed) | Honored, translated to a literal pixel-dimension ratio enum                     | Honored for text-to-video only; image-to-video has no such field (derived from the input image) | Honored directly (7-value enum matches this package's own format) | Honored for text-to-video only; single-image image-to-video has no such field |
| `seed`            | Honored, uint32 range, passed through                      | Honored (model-specific on Runway's side; `gen4.5` supports it), passed through | **Not supported by Kling at all; silently dropped**                                             | **Not supported by Luma at all; silently dropped**                | Honored, passed through                                                       |

Every "not supported" cell reflects the adapter's own documented behavior:
the normalized field is silently ignored (never sent on the wire), not
rejected. See each adapter's own module doc for the exact translation used
for a "Honored" cell.

## Google Veo (Flow)

**Adapter**: `packages/providers/src/veo-provider.ts` (`createVeoProvider`).

Built against the **Gemini API** (`generativelanguage.googleapis.com`), not
Vertex AI (GCP-project/service-account auth, enterprise-oriented) and not
"Flow." Google's own blog
(`blog.google/technology/ai/veo-updates-flow/`) confirms Flow itself has no
public developer API of its own; Veo is exposed through the Gemini API and
Vertex AI instead. This is the one vendor in this phase where "the naming
has changed / marketed jointly with another product" (the research task's
own anticipated failure mode) turned out to be exactly true, and the
adapter is built around the real underlying API rather than a
nonexistent "Flow API."

- **Verified directly** (literal curl bodies from
  `ai.google.dev/gemini-api/docs/veo`): `x-goog-api-key` header auth; submit
  via `POST /v1beta/models/{model}:predictLongRunning` with an
  `instances[0].prompt` / `parameters.{aspectRatio,durationSeconds,seed}`
  body; the response is a Google long-running `Operation` (`{ name, done }`);
  polling is `GET /v1beta/{operation_name}`; the success path is
  `response.generateVideoResponse.generatedSamples[0].video.uri`.
- **Left uncertain, not guessed**: the exact failed-operation JSON shape (no
  Veo-specific worked example was found; this adapter assumes Google's
  standard cross-API `{ error: { code, message } }` envelope, a reasonable
  default, not a confirmed one). The current best default model id is also
  left deliberately uncertain: `veo-2.0-generate-001`'s documented shutdown
  date had already passed by research time, and conflicting secondary
  signals existed about `veo-3.0-generate-001` vs `veo-3.1-generate-001` vs
  `veo-3.1-generate-preview` with no single primary source resolving them.
  The adapter defaults to `veo-3.1-generate-preview` (confirmed live on
  Google's own canonical model list) but exposes `model` as a fully
  overridable option rather than hardcoding further.
- **Polling/status model**: `done: false` (or absent) is `"running"`;
  `done: true` with `response` populated is `"succeeded"`; `done: true` with
  `error` populated is `"failed"`. Google's own docs recommend polling
  roughly every 10 seconds (not enforced by this adapter; cadence is left to
  the caller, per `VideoProvider.poll`'s own doc).
- **Constraints**: duration documented as 4, 6, or 8 seconds for the current
  Veo 3.x family; aspect ratios `16:9`/`9:16`; resolutions `720p`/`1080p`/
  `4k` depending on model; the completed video's downloadable `uri` is
  documented as expiring after approximately 2 days (medium confidence, not
  re-verified verbatim); no Veo-specific requests-per-minute figure was
  found in Google's static rate-limit docs.
- **Image-to-video is out of scope for this adapter**: Veo's API requires
  the reference image as inline base64 bytes (the `instances[0].image`
  field's own `inlineData`), not a fetchable URL, which this package's own
  `referenceImageUrls` (a list of URLs) cannot satisfy without this package
  fetching and re-encoding bytes on a caller's behalf (out of scope for this
  phase). `submit` throws a clear, descriptive error if
  `referenceImageUrls` is non-empty, rather than silently dropping the
  image or fabricating a payload never actually sent.

## Runway

**Adapter**: `packages/providers/src/runway-provider.ts` (`createRunwayProvider`).

- **Verified directly against Runway's own official OpenAPI spec**
  (`github.com/runwayml/openapi`, `info.version: "2024-11-06"`), cross-checked
  against `docs.dev.runwayml.com` and the official `@runwayml/sdk` Node SDK.
- Auth: `Authorization: Bearer <key>` plus a required
  `X-Runway-Version: 2024-11-06` header (currently the only valid value per
  Runway's own versioning docs).
- Submit: `POST /v1/text_to_video` (no reference image) or
  `POST /v1/image_to_video` (a reference image is given), model `gen4.5`
  (chosen because it is one of the few Runway models supporting both
  endpoints with an identical duration/seed range; `gen4_turbo`, by
  contrast, is image-to-video only). Response: `{ id }`.
- Poll: `GET /v1/tasks/{id}`, a six-value status union verified directly
  from the OpenAPI schema: `PENDING`, `THROTTLED` (both mapped to
  `"pending"`), `RUNNING` (mapped to `"running"`), `SUCCEEDED` (output at
  `output[0]`), `FAILED` (`failure`/optional `failureCode`), `CANCELLED`
  (mapped to `"failed"`).
- **Constraints**: `gen4.5` duration is an integer 2-10 seconds; `ratio` enum
  differs by endpoint (six values for image-to-video, two - `1280:720`/
  `720:1280` - for text-to-video; this adapter only maps normalized
  `aspectRatio` values onto the two shared between both endpoints, so
  routing never silently changes behavior based on whether an image was
  attached); rate limiting is a concurrency-plus-daily-cap model tiered by
  account spend (an over-limit submission comes back `THROTTLED`, not a
  `429`) rather than a flat requests-per-minute limit.

## Kling (Kuaishou)

**Adapter**: `packages/providers/src/kling-provider.ts` (`createKlingProvider`).

- **Verified directly against Kling's own official docs**, found live at
  `kling.ai/document-api` (not the `docs.qingque.cn`-style URL this
  research initially guessed at; `klingai.com` mirrors the same tree).
- Auth: Kling documents two parallel schemes. This adapter implements the
  legacy **Access Key (AK) / Secret Key (SK) JWT** scheme (header
  `{"alg": "HS256", "typ": "JWT"}`, payload `{"iss": AK, "exp": now + 1800,
"nbf": now - 5}`, HMAC-SHA256-signed with the SK), verified directly from
  Kling's own official Python sample and cross-checked byte-for-byte
  against a `PyJWT`-based reference implementation while building this
  adapter. Kling's newer static "API Key" bearer scheme is documented as the
  long-term direction but, at research time, was documented as not yet
  universally supported by every one of Kling's own first-party
  integrations; a future phase can add that simpler path once confirmed.
- Base host: `api-singapore.klingai.com` for non-China traffic (changed from
  the older `api.klingai.com`, which remains in use only for China-based
  callers) - kept fully configurable via `baseUrl` since which host is
  correct depends on the caller's own region.
- Submit: `POST /v1/videos/text2video` or `POST /v1/videos/image2video`,
  model `kling-v2-master`. Response: `{ data: { task_id } }`.
- Poll: `GET /v1/videos/{text2video|image2video}/{task_id}` (this adapter
  tries `text2video` first, falling back to `image2video` on a 404, since a
  `VideoGenerationJob` carries no memory of which endpoint created it).
  `data.task_status` is one of `submitted`/`processing`/`succeed`/`failed`;
  output at `data.task_result.videos[0].url` on success,
  `data.task_status_msg` on failure.
- **Constraints**: duration is a string enum `"3"`-`"15"` (whole seconds;
  wider than this research's initial `5`/`10`-only hypothesis, driven by
  newer multi-shot/storyboard support), default `"5"`; aspect ratio
  `16:9`/`9:16`/`1:1` for text2video only; **no seed parameter exists
  anywhere in Kling's schemas** (confirmed absent, not merely unlisted);
  Kling's own docs state explicitly "the system does not impose any QPS
  limits," using a concurrency cap instead of a requests-per-minute limit.

## Luma AI (Dream Machine)

**Adapter**: `packages/providers/src/luma-provider.ts` (`createLumaProvider`).

- **Verified directly against Luma's own official OpenAPI reference**
  (`docs.lumalabs.ai/reference/creategeneration.md` and `getgeneration.md`,
  fetched twice independently, byte-identical both times).
- Auth: `Authorization: Bearer <key>`.
- Submit: `POST /generations/video` (read directly from the OpenAPI
  operation schema; one secondary, unconfirmed source showed a path with no
  `/video` suffix, deliberately not used here since it was not corroborated
  by a primary source), model `ray-2` by default. Response:
  `{ id, state: "queued", ... }`.
- Poll: `GET /generations/{id}`. `state` is one of exactly
  `queued`/`dreaming`/`completed`/`failed`; output at `assets.video` on
  success, `failure_reason` (a plain string) on failure.
- **Reference images use a genuinely distinct shape**: `keyframes.frame0`/
  `frame1` (start/end frame), each `{ type: "image", url }`, not a flat
  image list. `referenceImageUrls[0]` maps to `frame0`,
  `referenceImageUrls[1]` (if present) to `frame1`.
- **Constraints**: duration exactly `"5s"`/`"9s"`; aspect ratio one of seven
  documented values (default `16:9`); resolution `540p`/`720p`/`1080p`/`4k`
  (not currently set by this adapter, since this package's own
  `VideoGenerationParams` has no resolution field); documented rate limit
  (Build/default tier) of 10 concurrent video generations and 20 requests
  per minute; **no seed parameter exists anywhere in Luma's schema**
  (confirmed absent).
- **Flagged, unresolved discrepancy**: Luma's marketing pages advertise a
  newer Ray3/Ray3.2 model family as "available as an API," but the live
  OpenAPI schema's own `model` enum, fetched twice, only ever listed
  `ray-2`/`ray-flash-2`. This adapter defaults to `ray-2` (the OpenAPI
  schema's own documented default) rather than guessing at an unconfirmed
  newer id, and exposes `model` as a fully overridable option.

## Pika

**Adapter**: `packages/providers/src/pika-provider.ts` (`createPikaProvider`).

**Pika Labs has no first-party public developer API.** This was directly
confirmed, not assumed: `pika.art/api`'s entire content is a single line
pointing developers to fal.ai (_"Get the power of Pika's video models from
the comfort of your own product on Fal AI"_), and `pika.art/faq` has zero
mentions of "API," "developer," or "integration." This is the "genuinely no
public API reference" case this phase's own research task explicitly
anticipated for one of the five named vendors, and it is Pika. A separate,
non-self-serve legacy enterprise/"Get in Touch" sales track also exists on
`pika.art` (inherited from the Pika 1.0/1.5 era) but has no public reference
documentation.

The only confirmed-live, self-serve, documented path to Pika's models is
**fal.ai hosting Pika's models as fal-branded endpoints**, under an official
partnership (`blog.fal.ai/pika-api-is-now-powered-by-fal/`, dated
2025-12-05). This adapter therefore talks to **fal.ai's own REST API** for
the `fal-ai/pika/v2.2/*` model family, not a Pika-owned endpoint - stated
plainly here and in the adapter's own module doc, not papered over.

- Auth: fal.ai's own platform-wide scheme, `Authorization: Key <FAL_KEY>`
  (the literal word `Key`, not `Bearer`) - one fal credential authenticates
  every model fal hosts, not a Pika-issued key.
- Submit: `POST https://queue.fal.run/fal-ai/pika/v2.2/text-to-video` or
  `.../image-to-video`, fal's standard async queue pattern. Response:
  `{ request_id }`.
- Poll: `GET .../requests/{request_id}/status` (`IN_QUEUE`/`IN_PROGRESS`/
  `COMPLETED`; a `COMPLETED` queue status can still carry a populated
  `error` field, which this adapter checks and maps to `"failed"`), then
  `GET .../requests/{request_id}` for the final result once genuinely
  complete: `{ video: { url } }`.
- **Constraints**: duration `"5"`/`"10"` seconds only; aspect ratio one of
  seven values (text-to-video only; the single-image image-to-video
  endpoint has no such field); resolution `720p`/`1080p`; rate limiting is
  concurrency-based and fal-wide (2 concurrent requests for new accounts,
  scaling to 40 as credits are purchased) rather than Pika-specific; seed
  is supported directly (the one Pika-family field this research confirmed
  alongside Runway and Veo).
- **Explicitly flagged as unconfirmed**: the exact shape of a genuinely
  failed generation's error payload was not confirmed against a real worked
  example in this research (no primary source showed one); this adapter's
  handling of the `error`/`error_type` fields on a `COMPLETED` status is a
  reasonable, schema-consistent best effort, not a verified-against-a-
  real-failure claim.
