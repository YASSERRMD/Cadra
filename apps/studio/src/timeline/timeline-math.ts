/**
 * Pure pixel <-> frame conversion and drag/trim/snap math for the timeline
 * panel. Mirrors `@cadra/player`'s `preview/scrubber-math.ts`
 * (`pointerPositionToFrame`) exactly in shape: every function here takes
 * plain numbers (never a `DOMRect`/`PointerEvent`/React ref) and is
 * unit-testable with a synthetic numeric table, since jsdom implements no
 * real layout engine (`getBoundingClientRect` returns zeros), so nothing
 * that only works via real layout could be meaningfully unit-tested. The
 * actual pixel-geometry reads (a `getBoundingClientRect` call, a pointer
 * event's `clientX`) stay thin call sites in `TimelinePanel.tsx`; all real
 * logic lives here.
 *
 * Zoom/scroll model: the timeline's ruler/track area maps a frame number to
 * an x pixel position via a `pixelsPerFrame` zoom level and a
 * `scrollOffsetFrames` horizontal scroll position, both local, UI-only state
 * in `TimelinePanel` (never part of the persisted `SceneDocument`, matching
 * this phase's own scope: zoom/scroll is a view concern, not an authored
 * property). `frameToPixel`/`pixelToFrame` below are exact inverses of each
 * other (mod the integer rounding `pixelToFrame` applies, since a frame is
 * always an integer but a pixel position is not).
 */

/** Converts a frame number to its x pixel position within the timeline's scrollable track area. */
export function frameToPixel(frame: number, pixelsPerFrame: number, scrollOffsetFrames: number): number {
  return (frame - scrollOffsetFrames) * pixelsPerFrame;
}

/**
 * Converts an x pixel position (relative to the track area's left edge, i.e.
 * already net of the area's own `getBoundingClientRect().left`) to the frame
 * number under it, rounding to the nearest whole frame.
 *
 * Returns `0` for a non-positive `pixelsPerFrame` (a degenerate/uninitialized
 * zoom level), matching `pointerPositionToFrame`'s own "non-positive extent
 * maps to 0" convention for a non-positive `trackWidth`.
 */
export function pixelToFrame(
  pixelX: number,
  pixelsPerFrame: number,
  scrollOffsetFrames: number,
): number {
  if (pixelsPerFrame <= 0) {
    return 0;
  }
  return Math.round(pixelX / pixelsPerFrame + scrollOffsetFrames);
}

/**
 * Converts a pixel delta (e.g. a drag's `event.clientX - dragStartClientX`)
 * to a frame delta, at the given zoom level. Rounds to the nearest whole
 * frame (a drag's rendered position can be sub-frame; the frame delta
 * actually applied to a clip's integer `startFrame`/`durationInFrames` never
 * is).
 *
 * Returns `0` for a non-positive `pixelsPerFrame`, same convention as
 * `pixelToFrame`.
 */
export function pixelDeltaToFrameDelta(pixelDeltaX: number, pixelsPerFrame: number): number {
  if (pixelsPerFrame <= 0) {
    return 0;
  }
  return Math.round(pixelDeltaX / pixelsPerFrame);
}

/**
 * A candidate frame boundary a drag/trim can magnetically snap to: another
 * clip's `startFrame` or its end frame (`startFrame + durationInFrames`), or
 * the current playhead position. See this module's own top-level doc for
 * this phase's interpretation of the spec's "snapping to ... markers":
 * these boundaries (other clips' edges on the same or adjacent tracks, plus
 * the playhead) are the only "marker"-shaped concept that exists anywhere in
 * this codebase's data model, so they are what this phase snaps to; there is
 * no separate, persisted "marker" entity.
 */
export interface SnapTarget {
  frame: number;
}

/**
 * Snaps `frame` to the nearest entry in `targets` if one lies within
 * `thresholdFrames` (inclusive) of it; returns `frame` unchanged otherwise.
 *
 * Ties (two targets exactly equidistant from `frame`) resolve to whichever
 * appears first in `targets`, an arbitrary but deterministic choice (no
 * ordering significance is implied by "first"; a caller that cares about a
 * particular tie-break should order `targets` accordingly).
 */
export function snapFrameToTargets(
  frame: number,
  targets: SnapTarget[],
  thresholdFrames: number,
): number {
  let closest: SnapTarget | undefined;
  let closestDistance = Infinity;

  for (const target of targets) {
    const distance = Math.abs(target.frame - frame);
    if (distance <= thresholdFrames && distance < closestDistance) {
      closest = target;
      closestDistance = distance;
    }
  }

  return closest?.frame ?? frame;
}

/** Result of a clip-move computation: the clip's new position, unchanged duration. */
export interface ClipMoveResult {
  startFrame: number;
}

/**
 * Computes a dragged clip's new `startFrame`, given the pixel delta the
 * pointer has moved since the drag began.
 *
 * Order of operations: convert the pixel delta to a frame delta, add it to
 * the clip's original `startFrame`, clamp to `>= 0` (a clip can never start
 * before the composition's own frame 0), then snap the clamped result
 * against `snapTargets` within `snapThresholdFrames`. Snapping after
 * clamping means a snap target at or near frame 0 is still reachable (the
 * clamp does not shadow it), and clamping before snapping means a snap
 * target can never pull a clip to a negative `startFrame`.
 */
export function computeClipMove(
  originalStartFrame: number,
  pixelDeltaX: number,
  pixelsPerFrame: number,
  snapTargets: SnapTarget[],
  snapThresholdFrames: number,
): ClipMoveResult {
  const frameDelta = pixelDeltaToFrameDelta(pixelDeltaX, pixelsPerFrame);
  const rawStartFrame = Math.max(originalStartFrame + frameDelta, 0);
  const startFrame = snapFrameToTargets(rawStartFrame, snapTargets, snapThresholdFrames);
  return { startFrame };
}

/** Result of a left-edge trim computation: both fields change together (the clip's end frame stays fixed). */
export interface TrimLeftResult {
  startFrame: number;
  durationInFrames: number;
}

/**
 * Computes a clip's new `startFrame`/`durationInFrames` when its left
 * (start) edge is dragged, given the pixel delta the pointer has moved.
 *
 * The clip's end frame (`originalStartFrame + originalDurationInFrames`) is
 * held fixed: only where the clip's visible window *begins* changes, exactly
 * like trimming the in-point of a clip in a conventional NLE. `startFrame` is
 * clamped to `[0, endFrame - 1]` so `durationInFrames` never drops below `1`
 * (a clip must always be at least one frame long), then the clamped
 * `startFrame` is snapped against `snapTargets`, and `durationInFrames` is
 * finally recomputed from whatever `startFrame` snapping landed on, so the
 * end frame invariant holds even after a snap.
 */
export function computeTrimLeft(
  originalStartFrame: number,
  originalDurationInFrames: number,
  pixelDeltaX: number,
  pixelsPerFrame: number,
  snapTargets: SnapTarget[],
  snapThresholdFrames: number,
): TrimLeftResult {
  const endFrame = originalStartFrame + originalDurationInFrames;
  const frameDelta = pixelDeltaToFrameDelta(pixelDeltaX, pixelsPerFrame);
  const rawStartFrame = Math.min(Math.max(originalStartFrame + frameDelta, 0), endFrame - 1);
  const startFrame = snapFrameToTargets(rawStartFrame, snapTargets, snapThresholdFrames);
  const clampedStartFrame = Math.min(Math.max(startFrame, 0), endFrame - 1);
  return { startFrame: clampedStartFrame, durationInFrames: endFrame - clampedStartFrame };
}

/** Result of a right-edge trim computation: only the duration changes. */
export interface TrimRightResult {
  durationInFrames: number;
}

/**
 * Computes a clip's new `durationInFrames` when its right (end) edge is
 * dragged, given the pixel delta the pointer has moved. `startFrame` never
 * changes for a right-edge trim.
 *
 * The new end frame (`originalStartFrame + originalDurationInFrames +
 * frameDelta`) is clamped to be at least one frame past `originalStartFrame`
 * (so `durationInFrames` never drops below `1`), then snapped against
 * `snapTargets` (matched against the candidate *end frame*, not the
 * duration itself, since snap targets are expressed as absolute frame
 * positions), and `durationInFrames` is recomputed from the snapped end
 * frame.
 */
export function computeTrimRight(
  originalStartFrame: number,
  originalDurationInFrames: number,
  pixelDeltaX: number,
  pixelsPerFrame: number,
  snapTargets: SnapTarget[],
  snapThresholdFrames: number,
): TrimRightResult {
  const originalEndFrame = originalStartFrame + originalDurationInFrames;
  const frameDelta = pixelDeltaToFrameDelta(pixelDeltaX, pixelsPerFrame);
  const rawEndFrame = Math.max(originalEndFrame + frameDelta, originalStartFrame + 1);
  const snappedEndFrame = snapFrameToTargets(rawEndFrame, snapTargets, snapThresholdFrames);
  const endFrame = Math.max(snappedEndFrame, originalStartFrame + 1);
  return { durationInFrames: endFrame - originalStartFrame };
}

/**
 * Clamps a proposed `pixelsPerFrame` zoom level to `[minPixelsPerFrame,
 * maxPixelsPerFrame]`. A pure clamp, factored out purely so `TimelinePanel`'s
 * zoom handler (e.g. a scroll-wheel or +/- control) never needs to duplicate
 * the clamp bounds inline, and so the bounds themselves are unit-testable
 * without constructing a wheel event.
 */
export function clampZoom(
  pixelsPerFrame: number,
  minPixelsPerFrame: number,
  maxPixelsPerFrame: number,
): number {
  return Math.min(Math.max(pixelsPerFrame, minPixelsPerFrame), maxPixelsPerFrame);
}

/**
 * Clamps a proposed `scrollOffsetFrames` so the visible window never scrolls
 * past either end of the composition: never negative, and never past the
 * point where the composition's last frame would leave the visible track
 * area's left edge. `visibleWidthPixels` is the track area's own on-screen
 * width; `totalDurationFrames` is the composition's `durationInFrames`.
 *
 * A composition shorter than the visible area at the current zoom level
 * (`totalDurationFrames * pixelsPerFrame <= visibleWidthPixels`) clamps
 * `scrollOffsetFrames` to exactly `0`: there is nothing to scroll to.
 */
export function clampScrollOffset(
  scrollOffsetFrames: number,
  totalDurationFrames: number,
  pixelsPerFrame: number,
  visibleWidthPixels: number,
): number {
  if (pixelsPerFrame <= 0) {
    return 0;
  }
  const visibleWidthFrames = visibleWidthPixels / pixelsPerFrame;
  const maxScrollOffsetFrames = Math.max(totalDurationFrames - visibleWidthFrames, 0);
  return Math.min(Math.max(scrollOffsetFrames, 0), maxScrollOffsetFrames);
}
