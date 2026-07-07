/**
 * Phase 35 task 2: the placeholder descriptor a pending or running
 * generation slot resolves to, so a preview or render path has something
 * sensible to show while a clip is still generating instead of blocking on
 * the vendor.
 *
 * This module is deliberately plain data and pure functions only: no pixels
 * are drawn here, and nothing here knows about `packages/renderer`, a
 * `VideoNode`, or a scene at all. Binding a resolved placeholder/ready state
 * into the actual render path is explicitly Phase 36's job (see this
 * package's own `README`/the Phase 35 spec); this module's job stops at
 * "given a slot's current generation state, what should be shown instead,
 * and what is the data needed to show it."
 */
import type { VideoGenerationFailed, VideoGenerationRequest, VideoGenerationStatus } from "./video-provider.js";

/** An RGBA color, each channel a normalized `0..1` float, matching this codebase's existing color convention (e.g. keyframed `color` tracks in `@cadra/core`'s animatable properties). */
export type PlaceholderColor = readonly [r: number, g: number, b: number, a: number];

/** Shows a flat, solid-colored frame while generation is in progress. The simplest placeholder kind; a reasonable default when no more specific placeholder is available or needed. */
export interface SolidPlaceholder {
  kind: "solid";
  /** The solid color to show. Defaults are left to the caller (e.g. a caller-configured "generating" color); this module does not hardcode one. */
  color: PlaceholderColor;
}

/** Shows an indeterminate spinner/loading indicator while generation is in progress. */
export interface SpinnerPlaceholder {
  kind: "spinner";
}

/**
 * Shows the last successfully-generated clip for this slot while a new
 * generation (a regeneration; see `./generation-store.ts`'s `regenerateSlot`)
 * is running, instead of a generic spinner. `outputUrl` is a
 * `VideoGenerationSucceeded.outputUrl` from that slot's *previous* completed
 * job (see `resolveSlotState`'s own doc for exactly which prior result this
 * is drawn from); it carries the same "vendor-hosted, possibly time-limited,
 * fetching bytes is the caller's job" caveats as that field does everywhere
 * else in this package (`./video-provider.ts`).
 */
export interface LastKnownFramePlaceholder {
  kind: "lastKnownFrame";
  outputUrl: string;
}

/** The full discriminated union a pending/running slot resolves to. Plain data only: no drawing/decoding logic lives here (see this module's own doc). */
export type GenerationPlaceholder = SolidPlaceholder | SpinnerPlaceholder | LastKnownFramePlaceholder;

/** A slot whose current job has not yet reached a terminal state: resolves to a {@link GenerationPlaceholder}, never to a clip. */
export interface SlotPending {
  status: "pending" | "running";
  placeholder: GenerationPlaceholder;
}

/** A slot whose current job finished successfully: resolves to the vendor's own `outputUrl`, exactly as `VideoGenerationSucceeded` carries it (see that type's own doc on the caveats around it). */
export interface SlotReady {
  status: "ready";
  outputUrl: string;
}

/** A slot whose current job terminally failed: resolves to the vendor's own failure reason, exactly as `VideoGenerationFailed` carries it. */
export interface SlotFailed {
  status: "failed";
  error: string;
}

/**
 * The full discriminated union a generation slot's current state resolves
 * to: a placeholder while generating, or the finished clip's `outputUrl`, or
 * a failure reason. This is the "ready" `outputUrl` case named in this
 * phase's task 1 doc: "ready" means the vendor reported success and the
 * store holds its `outputUrl`, not that this package has downloaded or
 * re-hosted the underlying bytes (see `VideoGenerationSucceeded`'s own doc).
 */
export type SlotResolution = SlotPending | SlotReady | SlotFailed;

/** Preference order used by {@link resolvePlaceholder} when no explicit preference is requested: prefer showing the last known frame over a generic spinner whenever one is available, since it is strictly more informative to a viewer. */
export type PlaceholderPreference = "lastKnownFrame" | "spinner" | "solid";

/** Options accepted by {@link resolvePlaceholder}. */
export interface ResolvePlaceholderOptions {
  /**
   * Which placeholder kind to prefer when a previous successful result is
   * available for this slot (making `lastKnownFrame` possible). Defaults to
   * `"lastKnownFrame"`: if a prior result exists, show it instead of a
   * generic spinner or solid color, per this phase's own task 2 framing
   * ("last known frame" as the more informative default placeholder).
   *
   * Ignored when no prior successful result is available (`previousOutputUrl`
   * is `undefined`): falls back to `"spinner"` in that case regardless of
   * this preference, since there is no frame to show.
   */
  prefer?: PlaceholderPreference;
  /** The solid color to use when the resolved placeholder kind is `"solid"` (either because `prefer` was `"solid"`, or because `"solid"` was requested with no other kind available). Defaults to opaque mid-gray (`[0.5, 0.5, 0.5, 1]`), a neutral "something is happening here" fill. */
  solidColor?: PlaceholderColor;
}

/** Default solid placeholder color: opaque mid-gray, a neutral "generating" fill with no vendor- or theme-specific meaning baked in. */
export const DEFAULT_PLACEHOLDER_SOLID_COLOR: PlaceholderColor = [0.5, 0.5, 0.5, 1];

/**
 * Resolves which {@link GenerationPlaceholder} a pending/running slot should
 * show right now, given an optional `previousOutputUrl` (this slot's most
 * recent prior successful result, if it has one; see
 * `./generation-store.ts`'s `GenerationSlot.previousResult`) and an optional
 * {@link ResolvePlaceholderOptions.prefer} preference.
 *
 * - If `previousOutputUrl` is given and `prefer` is `"lastKnownFrame"`
 *   (the default) or omitted, resolves to `{ kind: "lastKnownFrame",
 *   outputUrl: previousOutputUrl }`.
 * - Otherwise, if `prefer` is `"solid"`, resolves to a solid placeholder
 *   using `solidColor` (or the default).
 * - Otherwise (no prior result, or `prefer` is `"spinner"`), resolves to a
 *   spinner.
 */
export function resolvePlaceholder(
  previousOutputUrl: string | undefined,
  options: ResolvePlaceholderOptions = {},
): GenerationPlaceholder {
  const prefer = options.prefer ?? "lastKnownFrame";

  if (previousOutputUrl !== undefined && prefer === "lastKnownFrame") {
    return { kind: "lastKnownFrame", outputUrl: previousOutputUrl };
  }

  if (prefer === "solid") {
    return { kind: "solid", color: options.solidColor ?? DEFAULT_PLACEHOLDER_SOLID_COLOR };
  }

  return { kind: "spinner" };
}

/**
 * Resolves a single `VideoGenerationStatus` (as returned by a
 * `VideoProvider.poll` call, or held in the dedup cache; see
 * `./generation-store.ts`) into the {@link SlotResolution} a caller-facing
 * status check reports, given the same `previousOutputUrl`/preference inputs
 * {@link resolvePlaceholder} takes.
 *
 * This is the single place `"pending"`/`"running"` collapse into a
 * placeholder, `"succeeded"` collapses into `{ status: "ready", outputUrl }`,
 * and `"failed"` collapses into `{ status: "failed", error }`; both
 * `./generation-store.ts`'s `getSlotStatus` and any future direct caller of
 * a raw `VideoGenerationStatus` share this one resolution function rather
 * than re-deriving the same three-way branch.
 */
export function resolveGenerationStatus(
  status: VideoGenerationStatus,
  previousOutputUrl: string | undefined,
  options: ResolvePlaceholderOptions = {},
): SlotResolution {
  if (status.status === "succeeded") {
    return { status: "ready", outputUrl: status.outputUrl };
  }
  if (status.status === "failed") {
    return { status: "failed", error: (status as VideoGenerationFailed).error };
  }
  return {
    status: status.status,
    placeholder: resolvePlaceholder(previousOutputUrl, options),
  };
}

/**
 * Re-exported purely so a caller building a `previousOutputUrl` from its own
 * prior request/response pair has the exact request type at hand without a
 * second import from `./video-provider.js`; this module otherwise never
 * constructs a `VideoGenerationRequest` itself.
 */
export type { VideoGenerationRequest };
