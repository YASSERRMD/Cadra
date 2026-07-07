/**
 * Phase 35: the generation job store. Two distinct concerns live here, kept
 * deliberately separate per this phase's own design note (do not conflate
 * them):
 *
 * 1. **The dedup cache** (tasks 1 and 3): a plain `Map` from a request's
 *    {@link hashVideoGenerationRequest} to that request's one underlying
 *    vendor job/result. Given the exact same `VideoGenerationRequest`
 *    (canonically hashed; see `./request-hash.ts`) is requested again, from
 *    anywhere, this cache is checked first and the already-known job/result
 *    is reused, with no redundant `VideoProvider.submit` call. Entries in
 *    this cache are never mutated to point somewhere else and have no notion
 *    of "supersedes" - a cache entry for a given hash is the one, permanent
 *    record of that exact request's outcome.
 *
 * 2. **Generation slots** (task 5, plus the "last known frame" part of task
 *    2): a caller-assigned, stable id (e.g. a `VideoNode`'s own `id`, or any
 *    other caller-chosen key) tracking "the current/latest request for this
 *    slot," separate from the dedup cache above. `regenerateSlot` computes a
 *    fresh request (a new seed by default, or whatever overrides the caller
 *    supplies), which naturally hashes differently from the slot's previous
 *    request and therefore becomes a new, independent dedup-cache entry; the
 *    slot itself remembers both the new in-flight cache entry and the
 *    *previous* request's cache entry (if it had one and it succeeded), so
 *    `getSlotStatus` can resolve a regenerating slot to a `lastKnownFrame`
 *    placeholder referencing that previous result instead of a generic
 *    spinner.
 *
 * Both concerns are scoped to one `GenerationStore` instance (via
 * {@link createGenerationStore}), not module-level singletons: a caller
 * (e.g. a test, or an application juggling more than one independent
 * workspace) constructs exactly the stores it needs, matching this
 * package's existing "no hidden global state" discipline (every adapter
 * already takes its own injected `FetchLike`/options; nothing in this
 * package reaches for a process-wide singleton).
 */
import type { ResolvePlaceholderOptions, SlotResolution } from "./placeholder.js";
import { resolveGenerationStatus } from "./placeholder.js";
import { hashVideoGenerationRequest } from "./request-hash.js";
import type {
  VideoGenerationJob,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoProvider,
} from "./video-provider.js";

/** A `ContentHash`-shaped string keying the dedup cache; re-declared locally (rather than importing `@cadra/core`'s `ContentHash`) to avoid this module depending on `@cadra/core` for a type alias its own callers never need to import themselves. */
export type RequestHash = string;

/**
 * One dedup-cache entry: exactly one vendor job/result for exactly one
 * canonically-hashed `VideoGenerationRequest`. `status` mirrors
 * `VideoGenerationStatus`'s own three-way shape (task 1: "pending, running,
 * ready, failed"; `"ready"` here is this task's own name for
 * `VideoGenerationStatus`'s `"succeeded"`, renamed by this store's own
 * internal `toCacheEntry` helper), plus this entry's own `provider`/`job`/
 * `request` bookkeeping needed to keep polling it and to know which request
 * produced it in the first place.
 */
export type GenerationCacheEntry =
  | {
      status: "pending" | "running";
      request: VideoGenerationRequest;
      provider: string;
      job: VideoGenerationJob;
    }
  | {
      status: "ready";
      request: VideoGenerationRequest;
      provider: string;
      job: VideoGenerationJob;
      outputUrl: string;
    }
  | {
      status: "failed";
      request: VideoGenerationRequest;
      provider: string;
      job: VideoGenerationJob;
      error: string;
    };

/**
 * One generation slot's bookkeeping: a caller-assigned `slotId` plus the
 * hash of its current (most recently submitted) request, and, if this slot
 * has ever had an earlier request succeed, the hash of that earlier
 * request's cache entry too (kept solely so a regenerating slot can resolve
 * to a `lastKnownFrame` placeholder; see `./placeholder.ts`).
 *
 * Deliberately holds hashes, not the cache entries themselves: the dedup
 * cache (`GenerationStore.cache`) remains the single owner of actual job/
 * result data, a slot is only ever a named pointer into it, matching this
 * module's own design note ("(2) never mutates (1), only points into it").
 */
export interface GenerationSlot {
  slotId: string;
  /** Hash of this slot's current (most recently submitted) request; always set once a slot has been submitted to at least once. */
  currentRequestHash: RequestHash;
  /** Hash of this slot's previous request, if an earlier `submitGeneration`/`regenerateSlot` call for this same `slotId` produced a request that later succeeded. `undefined` for a slot on its first generation, or one whose only prior attempt never reached `"ready"`. */
  previousSucceededRequestHash?: RequestHash;
}

/** A `GenerationStore`'s provider registry: every `VideoProvider` a caller might submit a request against, keyed by that provider's own `.name` (matching `VideoGenerationJob.provider`, so `poll` calls route back to the right adapter). */
export type ProviderRegistry = Record<string, VideoProvider>;

/** Options accepted by {@link createGenerationStore}. */
export interface CreateGenerationStoreOptions {
  /** Every `VideoProvider` this store can submit/poll against, keyed by provider name. A request naming a provider not present here fails fast with a descriptive error rather than silently trying every registered provider. */
  providers: ProviderRegistry;
}

/**
 * Computes a slot's next request when regenerating it (task 5): by default,
 * shallow-clones the previous request with a freshly randomized
 * `params.seed`, so a regeneration is a genuinely different request (and
 * therefore genuinely different cache hash; see `./request-hash.ts`) purely
 * by construction, with no other field needing to change unless the caller
 * explicitly overrides one.
 *
 * Exported so a caller wanting `regenerateSlot`'s exact default seed
 * behavior without going through the full store (e.g. to preview what the
 * next request would look like) can call it directly; `regenerateSlot`
 * itself is the only place in this module that calls it as part of its own
 * flow.
 */
export function deriveRegeneratedRequest(
  previousRequest: VideoGenerationRequest,
  overrides?: Partial<VideoGenerationRequest>,
): VideoGenerationRequest {
  if (overrides !== undefined) {
    return {
      ...previousRequest,
      ...overrides,
      params: { ...previousRequest.params, ...overrides.params },
    };
  }

  return {
    ...previousRequest,
    params: { ...previousRequest.params, seed: randomSeed() },
  };
}

/** Generates a fresh, non-negative 32-bit integer seed for a default regeneration (no caller-supplied override). Not used for anything security-sensitive (only to make a regenerated request's hash differ from its predecessor's), so an ordinary PRNG is sufficient; this is the one function in this module that touches randomness, isolated here so a caller needing fully deterministic regeneration in a test supplies an explicit `overrides.params.seed` instead of relying on this default. */
function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

/** Thrown when a request/regeneration names a provider not present in the store's `providers` registry. */
export class UnknownProviderError extends Error {
  constructor(public readonly providerName: string) {
    super(
      `No VideoProvider named "${providerName}" is registered with this generation store. ` +
        "Pass it in createGenerationStore's providers option.",
    );
    this.name = "UnknownProviderError";
  }
}

/** Thrown when an operation names a `slotId` this store has never seen a `submitGeneration` call for. */
export class UnknownSlotError extends Error {
  constructor(public readonly slotId: string) {
    super(`No generation slot with id "${slotId}" is known to this store. Call submitGeneration for it first.`);
    this.name = "UnknownSlotError";
  }
}

/**
 * A generation job store, scoped to one `providers` registry (see
 * {@link createGenerationStore}). Owns both the dedup cache and the slot
 * registry (this module's own doc explains why they are kept distinct
 * concerns within one store rather than two entirely separate types: a slot
 * is meaningless without a cache to point into, and in practice every real
 * caller needs both together).
 */
export interface GenerationStore {
  /**
   * Submits (or reuses) a generation request for `slotId`.
   *
   * Hashes `request` (`./request-hash.ts`); if an entry for that exact hash
   * already exists in the dedup cache (from this call or any earlier one,
   * for this slot or any other), reuses it as-is with no new
   * `VideoProvider.submit` call (task 3: "identical requests, from anywhere,
   * resolve to the same cached job/result"). Otherwise submits a genuinely
   * new job via the named provider's own `submit`, and records a new
   * `"pending"` cache entry for that hash.
   *
   * Either way, updates `slotId`'s own bookkeeping to point its
   * `currentRequestHash` at this request's hash. If `slotId` already existed
   * and its previous `currentRequestHash` cache entry was `"ready"`, that
   * hash becomes the slot's new `previousSucceededRequestHash` (so
   * `getSlotStatus` can offer a `lastKnownFrame` placeholder while this new
   * request is still generating); if the previous entry was not `"ready"`
   * (still pending/running, or failed), the slot's
   * `previousSucceededRequestHash` is left as it was (an in-flight or failed
   * attempt is not a "last known frame" worth falling back to).
   *
   * Returns the resulting cache entry's hash (whether freshly submitted or
   * reused).
   */
  submitGeneration(slotId: string, providerName: string, request: VideoGenerationRequest): Promise<RequestHash>;

  /**
   * Regenerates `slotId`: computes a fresh request from its current one
   * (`deriveRegeneratedRequest`, defaulting to a new random seed, or exactly
   * `overrides` if given) and calls {@link submitGeneration} with it under
   * the same provider `slotId` was last submitted against.
   *
   * Because the fresh request's `params.seed` (or whatever `overrides`
   * changed) differs from the previous request, it hashes differently
   * (`./request-hash.ts`) and therefore always lands as a new, independent
   * dedup-cache entry - this never reuses the slot's previous cache entry,
   * by construction (task 5's "regeneration creates a genuinely new job/
   * cache entry rather than reusing the old one").
   *
   * Throws {@link UnknownSlotError} if `slotId` has never been submitted.
   */
  regenerateSlot(slotId: string, overrides?: Partial<VideoGenerationRequest>): Promise<RequestHash>;

  /**
   * Polls every not-yet-terminal cache entry against its owning provider,
   * updating the cache in place. Call this on whatever cadence the caller
   * chooses (this store, like `VideoProvider.poll` itself, never sleeps/
   * loops/schedules its own polling; see `./video-provider.ts`'s own doc for
   * why that stays the caller's job) before calling `getSlotStatus` if the
   * caller wants a fresh status rather than whatever this store last
   * observed.
   */
  refresh(): Promise<void>;

  /**
   * Resolves `slotId`'s current status: a placeholder while its current
   * request's cache entry is pending/running (offering a `lastKnownFrame`
   * placeholder referencing `previousSucceededRequestHash`'s own `outputUrl`
   * when this slot has one; see `./placeholder.ts`), the finished
   * `outputUrl` once ready, or the failure reason once failed.
   *
   * Reads the cache as it currently stands (i.e. as of the last `refresh`
   * call, or as of `submitGeneration`/`regenerateSlot`'s own initial
   * `"pending"` write); does not itself poll the provider - call `refresh`
   * first for a live status.
   *
   * Throws {@link UnknownSlotError} if `slotId` has never been submitted.
   */
  getSlotStatus(slotId: string, options?: ResolvePlaceholderOptions): SlotResolution;

  /** Looks up a dedup-cache entry directly by its {@link RequestHash} (e.g. `hashVideoGenerationRequest(request)`), or `undefined` if no such entry exists. Exposed mainly for tests verifying task 3/6's dedup behavior (two identical requests share one entry) without needing a slot in between. */
  getCacheEntry(hash: RequestHash): GenerationCacheEntry | undefined;

  /** Looks up a slot's own bookkeeping record directly, or `undefined` if `slotId` has never been submitted. Exposed mainly for tests/introspection; `getSlotStatus` is the normal way to read a slot's resolved state. */
  getSlot(slotId: string): GenerationSlot | undefined;
}

/**
 * Constructs a fresh, empty {@link GenerationStore} bound to `options.providers`.
 * Every one of this function's returned store's own state (its dedup cache
 * and slot registry) is private to that one instance - two separate
 * `createGenerationStore` calls never share state, matching this package's
 * "no hidden global state" discipline (see this module's own doc).
 */
export function createGenerationStore(options: CreateGenerationStoreOptions): GenerationStore {
  const { providers } = options;
  const cache = new Map<RequestHash, GenerationCacheEntry>();
  const slots = new Map<string, GenerationSlot>();

  function requireProvider(providerName: string): VideoProvider {
    const provider = providers[providerName];
    if (provider === undefined) {
      throw new UnknownProviderError(providerName);
    }
    return provider;
  }

  function requireSlot(slotId: string): GenerationSlot {
    const slot = slots.get(slotId);
    if (slot === undefined) {
      throw new UnknownSlotError(slotId);
    }
    return slot;
  }

  /** Converts a freshly-observed `VideoGenerationStatus` plus its owning request/provider/job into the {@link GenerationCacheEntry} shape this store persists (renaming `"succeeded"` to `"ready"`; see task 1's own naming). */
  function toCacheEntry(
    request: VideoGenerationRequest,
    provider: string,
    job: VideoGenerationJob,
    status: VideoGenerationStatus,
  ): GenerationCacheEntry {
    if (status.status === "succeeded") {
      return { status: "ready", request, provider, job, outputUrl: status.outputUrl };
    }
    if (status.status === "failed") {
      return { status: "failed", request, provider, job, error: status.error };
    }
    return { status: status.status, request, provider, job };
  }

  async function submitGeneration(
    slotId: string,
    providerName: string,
    request: VideoGenerationRequest,
  ): Promise<RequestHash> {
    const hash = hashVideoGenerationRequest(request);

    if (!cache.has(hash)) {
      const provider = requireProvider(providerName);
      const job = await provider.submit(request);
      cache.set(hash, { status: "pending", request, provider: providerName, job });
    }

    const existingSlot = slots.get(slotId);
    const previousHash = existingSlot?.currentRequestHash;
    const previousEntry = previousHash !== undefined ? cache.get(previousHash) : undefined;
    const previousSucceededRequestHash =
      previousEntry?.status === "ready" ? previousHash : existingSlot?.previousSucceededRequestHash;

    slots.set(slotId, {
      slotId,
      currentRequestHash: hash,
      ...(previousSucceededRequestHash !== undefined ? { previousSucceededRequestHash } : {}),
    });

    return hash;
  }

  async function regenerateSlot(
    slotId: string,
    overrides?: Partial<VideoGenerationRequest>,
  ): Promise<RequestHash> {
    const slot = requireSlot(slotId);
    const currentEntry = cache.get(slot.currentRequestHash);
    if (currentEntry === undefined) {
      // Cannot happen through this store's own public API (a slot's
      // currentRequestHash always has a matching cache entry by
      // construction), but guarded rather than asserted with a cast so a
      // future bug here fails loudly instead of producing an `undefined`
      // used as a VideoGenerationRequest.
      throw new UnknownSlotError(slotId);
    }

    const freshRequest = deriveRegeneratedRequest(currentEntry.request, overrides);
    return submitGeneration(slotId, currentEntry.provider, freshRequest);
  }

  async function refresh(): Promise<void> {
    const pendingHashes = Array.from(cache.entries())
      .filter(([, entry]) => entry.status === "pending" || entry.status === "running")
      .map(([hash]) => hash);

    await Promise.all(
      pendingHashes.map(async (hash) => {
        const entry = cache.get(hash);
        if (entry === undefined || (entry.status !== "pending" && entry.status !== "running")) {
          return;
        }
        const provider = requireProvider(entry.provider);
        const status = await provider.poll(entry.job);
        cache.set(hash, toCacheEntry(entry.request, entry.provider, entry.job, status));
      }),
    );
  }

  function getSlotStatus(slotId: string, statusOptions?: ResolvePlaceholderOptions): SlotResolution {
    const slot = requireSlot(slotId);
    const currentEntry = cache.get(slot.currentRequestHash);
    if (currentEntry === undefined) {
      throw new UnknownSlotError(slotId);
    }

    const previousOutputUrl = resolvePreviousOutputUrl(slot);

    if (currentEntry.status === "ready") {
      return { status: "ready", outputUrl: currentEntry.outputUrl };
    }
    if (currentEntry.status === "failed") {
      return { status: "failed", error: currentEntry.error };
    }
    return resolveGenerationStatus({ status: currentEntry.status }, previousOutputUrl, statusOptions);
  }

  function resolvePreviousOutputUrl(slot: GenerationSlot): string | undefined {
    if (slot.previousSucceededRequestHash === undefined) {
      return undefined;
    }
    const previousEntry = cache.get(slot.previousSucceededRequestHash);
    return previousEntry?.status === "ready" ? previousEntry.outputUrl : undefined;
  }

  return {
    submitGeneration,
    regenerateSlot,
    refresh,
    getSlotStatus,
    getCacheEntry: (hash) => cache.get(hash),
    getSlot: (slotId) => slots.get(slotId),
  };
}
