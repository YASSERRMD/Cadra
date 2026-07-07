/**
 * The single seam every adapter in this package is written against for
 * outbound HTTP: a vendor-neutral, structural subset of the standard `fetch`
 * signature.
 *
 * Deliberately typed as a plain function accepting `(input, init)` and
 * returning a `Promise<Response>`, using the DOM lib's own `RequestInfo`/
 * `RequestInit`/`Response` types (already available via this repo's
 * `tsconfig.base.json`, which includes `"DOM"` in `lib`) rather than a
 * bespoke request/response shape: every adapter's real HTTP calls (built on
 * plain JSON request/response bodies, bearer/API-key headers, and ordinary
 * HTTP status codes) map directly onto `fetch`'s own shape with zero
 * translation layer, so the real default implementation is
 * `globalThis.fetch` itself with no wrapping at all.
 *
 * This mirrors the same injectable-seam pattern already used throughout this
 * codebase for every other real external dependency (`LlmCompletionFn` in
 * `@cadra/agent-sdk`'s `text-to-scene/llm-completion.ts`, `BrowserLauncher` in
 * `@cadra/headless`, `VideoEncoderConstructor` in `@cadra/encode`): a real
 * implementation is available as a default, but every adapter takes one of
 * these as a plain injectable function, with zero knowledge of, or
 * dependency on, whether a real network call is ever actually made. A test
 * suite for this package never needs a real network connection at all; it
 * just supplies a fake `FetchLike` that resolves with hand-authored fixture
 * `Response` bodies.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * The real default `FetchLike`: `globalThis.fetch` itself, bound so it does
 * not lose its `this` context when passed around as a bare function
 * reference (some `fetch` implementations, including Node's undici-backed
 * global, throw an `Illegal invocation`-style error if called unbound).
 *
 * Referenced lazily by every adapter's option-resolution code (i.e. `options
 * .fetchFn ?? defaultFetchLike()`), never imported eagerly at module load
 * time, so a package consumer who always injects their own `fetchFn` (every
 * test in this package's suite does) never depends on a global `fetch`
 * existing at all.
 */
export function defaultFetchLike(): FetchLike {
  return globalThis.fetch.bind(globalThis);
}
