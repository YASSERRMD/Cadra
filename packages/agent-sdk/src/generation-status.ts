/**
 * Phase 35 task 4: the agent-SDK-facing surface for checking a generative-
 * video slot's status while building a scene programmatically.
 *
 * This is a deliberately thin layer over `@cadra/providers`'s Phase 35
 * `createGenerationStore` (dedup cache plus generation slots; see that
 * package's own `generation-store.ts` doc for the full design): a caller
 * already holding a `GenerationStore` (constructed once per application/
 * workspace, exactly like a caller constructs its own `VideoProvider`
 * instances) uses {@link getGenerationSlotStatus} to resolve one slot's
 * current state - a placeholder while generating, the finished clip's
 * `outputUrl` once ready, or the failure reason once failed - without
 * needing to import from `@cadra/providers` directly for the common case.
 *
 * This module intentionally does not construct its own `GenerationStore` or
 * cache one internally: exactly like `@cadra/providers` itself, this
 * package holds no hidden global state, so every caller supplies the same
 * `GenerationStore` instance it uses everywhere else in its own
 * application. Scene-building (`.build()`) and slot-status-checking are
 * therefore two independent concerns a caller composes itself, not
 * something this SDK's builder chain performs automatically - binding a
 * slot's resolved state into a `VideoNode` placed in a scene is explicitly
 * Phase 36's job, not this phase's.
 */
import type {
  GenerationStore,
  ResolvePlaceholderOptions,
  SlotResolution,
} from "@cadra/providers";

/**
 * Resolves `slotId`'s current generation status from `store`: a placeholder
 * (solid/spinner/lastKnownFrame) while the slot's current request is still
 * pending or running, the finished clip's `outputUrl` once the vendor
 * reports success, or the failure reason once it terminally fails.
 *
 * A thin, named wrapper around `GenerationStore.getSlotStatus` so a caller
 * building scenes with `@cadra/agent-sdk` can check a slot's status without
 * a second import from `@cadra/providers` for this one common call; every
 * other `GenerationStore` capability (`submitGeneration`, `regenerateSlot`,
 * `refresh`) is still reached directly on the `store` instance itself, not
 * re-wrapped here, since this phase's task 4 asks only for a "small, clean"
 * status-checking surface, not a full second facade over the whole store.
 *
 * Reads the store as it currently stands; does not itself poll the
 * underlying `VideoProvider` - call `store.refresh()` first for a live
 * status, exactly as `GenerationStore.getSlotStatus` itself documents.
 *
 * Throws `UnknownSlotError` (re-exported from `@cadra/providers` below) if
 * `slotId` has never been submitted to `store`.
 */
export function getGenerationSlotStatus(
  store: GenerationStore,
  slotId: string,
  options?: ResolvePlaceholderOptions,
): SlotResolution {
  return store.getSlotStatus(slotId, options);
}

export type {
  CreateGenerationStoreOptions,
  GenerationCacheEntry,
  GenerationPlaceholder,
  GenerationSlot,
  GenerationStore,
  LastKnownFramePlaceholder,
  PlaceholderColor,
  PlaceholderPreference,
  ProviderRegistry,
  RequestHash,
  ResolvePlaceholderOptions,
  SlotFailed,
  SlotPending,
  SlotReady,
  SlotResolution,
  SolidPlaceholder,
  SpinnerPlaceholder,
} from "@cadra/providers";
export {
  createGenerationStore,
  deriveRegeneratedRequest,
  hashVideoGenerationRequest,
  UnknownProviderError,
  UnknownSlotError,
} from "@cadra/providers";
