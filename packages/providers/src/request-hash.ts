/**
 * Phase 35: content-hash keying for the generation job store's dedup cache
 * (`./generation-store.ts`).
 *
 * The dedup cache's whole point is "the exact same `VideoGenerationRequest`,
 * requested again from anywhere, must reuse the already-known result rather
 * than resubmitting to the vendor" (see this phase's design note). A naive
 * `JSON.stringify(request)` almost gets there, but does not canonicalize
 * object key order: `{ durationSeconds: 5, aspectRatio: "16:9" }` and
 * `{ aspectRatio: "16:9", durationSeconds: 5 }` are the same logical request
 * (same fields, same values) yet `JSON.stringify` emits keys in whatever
 * order they were inserted, so those two would hash differently and silently
 * defeat the cache. `canonicalJsonStringify` below recursively sorts every
 * object's own keys before serializing, so hashing is stable across however
 * a request's `params` object happened to be constructed.
 *
 * `hashAssetBytes` (`@cadra/core`) is reused as-is for the actual byte
 * hashing, per this phase's own design note: it is this codebase's one
 * standardized, dependency-free content-hashing primitive, and this module's
 * only job is producing the canonical byte serialization that goes into it,
 * not inventing a second hash function.
 */
import type { ContentHash } from "@cadra/core";
import { hashAssetBytes } from "@cadra/core";

import type { VideoGenerationRequest } from "./video-provider.js";

/**
 * Recursively sorts every plain object's own keys (by ordinary string
 * comparison) before handing the whole structure to `JSON.stringify`, so two
 * structurally-identical values serialize identically regardless of the
 * order their keys happened to be inserted in.
 *
 * Arrays keep their existing element order (order is significant there,
 * e.g. `referenceImageUrls`), only plain object keys are reordered. `null`
 * and primitives pass through `JSON.stringify` unchanged (there is nothing to
 * reorder). Not exported: this is `hashVideoGenerationRequest`'s own internal
 * canonicalization step, not a general-purpose utility this phase's spec
 * asks for elsewhere.
 */
function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** Recursively rebuilds `value`, sorting object keys, so `JSON.stringify` on the result always emits keys in the same order for the same logical value. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value).sort();
    const sorted: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Hashes a `VideoGenerationRequest` down to a deterministic {@link ContentHash},
 * canonicalizing key order first (see this module's own doc) so the same
 * logical request always hashes the same way no matter how its `params`
 * object was built up. This is the dedup cache's own key (`./generation-store.ts`):
 * two requests that hash equal are treated as "the same request" and never
 * cause a second vendor `submit` call.
 *
 * Deliberately hashes the full request, including `params.seed`: a caller
 * that wants a genuinely new generation (this phase's task 5,
 * `regenerateSlot`) is expected to change the seed (or whatever else), which
 * naturally produces a different hash and therefore a new, independent cache
 * entry, rather than this function trying to special-case "insignificant"
 * fields itself.
 */
export function hashVideoGenerationRequest(request: VideoGenerationRequest): ContentHash {
  const canonical = canonicalJsonStringify(request);
  return hashAssetBytes(new TextEncoder().encode(canonical));
}
