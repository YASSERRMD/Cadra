import type { Composition } from "@cadra/core";
import { moveClipToTrack, updateClipTiming } from "@cadra/core";
import type { PreviewHandle } from "@cadra/player";
import type { SceneDocument } from "@cadra/schema";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";

import {
  clampZoom,
  computeClipMove,
  computeTrimLeft,
  computeTrimRight,
  frameToPixel,
  pixelToFrame,
} from "../timeline/timeline-math.js";

/** Props for `TimelinePanel`. */
export interface TimelinePanelProps {
  /** The current scene document; tracks/clips are read from its `selectedCompositionId` composition. */
  document: SceneDocument;
  /** Which of `document.project.compositions` this timeline renders and edits. */
  selectedCompositionId: string;
  /**
   * The store's `commitDocument` funnel. Every drag/trim/reorder gesture
   * this panel performs ends in exactly one call to this, with a candidate
   * `SceneDocument` built from splicing an updated `Composition` back into
   * `document` (see `replaceComposition` below) - never a second, parallel
   * way of mutating `document`, matching this codebase's established
   * invariant that `commitDocument` is the only funnel.
   */
  commitDocument: (candidate: unknown) => boolean;
  /**
   * The live `PreviewHandle` shared with `Viewport` (see `App.tsx` and
   * `Viewport.tsx`'s own docs for how the one real handle is lifted and
   * passed to both). `undefined` until `Viewport`'s effect has constructed
   * it (or if there is no composition to preview at all); this panel simply
   * renders its playhead at frame 0 and does not respond to drags on it
   * until a handle exists.
   */
  previewHandle: PreviewHandle | undefined;
  /** Calls the store's `undo` action. */
  onUndo: () => void;
  /** Calls the store's `redo` action. */
  onRedo: () => void;
}

/** Minimum/maximum pixels-per-frame zoom level this panel allows. */
const MIN_PIXELS_PER_FRAME = 0.5;
const MAX_PIXELS_PER_FRAME = 40;
/** Starting zoom level: comfortably readable for a composition a few hundred frames long. */
const DEFAULT_PIXELS_PER_FRAME = 4;
/** Multiplicative factor each zoom in/out button press applies. */
const ZOOM_STEP_FACTOR = 1.5;
/** How many frames a drag/trim/playhead-scrub snaps within of a clip boundary or the current playhead. */
const SNAP_THRESHOLD_FRAMES = 5;
/** Fixed per-track row height, in pixels. */
const TRACK_ROW_HEIGHT = 48;

/**
 * Returns a new `SceneDocument` equal to `sceneDocument` except that the
 * composition matching `compositionId` is replaced by `nextComposition`.
 *
 * A small, local, document-envelope-level splice (distinct from
 * `@cadra/core`'s `updateClipTiming`/`moveClipToTrack`, which operate one
 * level down, on a bare `Composition`): this is what turns "a new
 * `Composition` with one clip's timing changed" into the full candidate
 * `SceneDocument` `commitDocument` expects. Immutable; does not mutate
 * `sceneDocument`.
 */
function replaceComposition(
  sceneDocument: SceneDocument,
  compositionId: string,
  nextComposition: Composition,
): SceneDocument {
  return {
    ...sceneDocument,
    project: {
      ...sceneDocument.project,
      compositions: sceneDocument.project.compositions.map((composition) =>
        composition.id === compositionId ? nextComposition : composition,
      ),
    },
  };
}

/** A clip boundary (start or end frame) collected from every track, for magnetic-edge snapping. See this module's own top-level doc. */
interface ClipBoundary {
  frame: number;
}

/** Collects every clip's start and end frame across every track in `composition`, excluding `excludeClipId` (a clip being dragged should not snap to its own edges). */
function collectClipBoundaries(composition: Composition, excludeClipId: string): ClipBoundary[] {
  const boundaries: ClipBoundary[] = [];
  for (const track of composition.tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) {
        continue;
      }
      boundaries.push({ frame: clip.startFrame });
      boundaries.push({ frame: clip.startFrame + clip.durationInFrames });
    }
  }
  return boundaries;
}

/**
 * In-progress drag state for a clip move, held in a ref (not React state) so
 * mousemove handlers always see the latest values without stale closures.
 *
 * `currentTrackId` starts equal to `trackId` (the clip's source track) and
 * is updated by each track row's own `onMouseEnter` while the drag is in
 * progress (see `handleTrackRowMouseEnter`): whichever track the pointer is
 * currently over is the drop target. This is a DOM-event-driven mechanism
 * (each row dispatches its own `mouseenter`), not a geometry-driven one
 * (`document.elementFromPoint`, which jsdom does not implement at all), so
 * "drag a clip onto a different track" is exercisable the same way every
 * other gesture in this component is: by dispatching synthetic DOM events
 * in a test, never requiring real layout.
 */
interface MoveDragState {
  kind: "move";
  trackId: string;
  clipId: string;
  originalStartFrame: number;
  startClientX: number;
  currentTrackId: string;
}

/** In-progress drag state for a left/right trim. */
interface TrimDragState {
  kind: "trim-left" | "trim-right";
  trackId: string;
  clipId: string;
  originalStartFrame: number;
  originalDurationInFrames: number;
  startClientX: number;
}

/** In-progress drag state for the playhead. */
interface PlayheadDragState {
  kind: "playhead";
}

type DragState = MoveDragState | TrimDragState | PlayheadDragState;

/**
 * The editable timeline: a frame ruler, one row per `Track` with its `Clip`s
 * rendered as positioned/sized boxes, and a playhead bound to the shared
 * `PreviewHandle`.
 *
 * Zoom (`pixelsPerFrame`) and horizontal scroll are local, UI-only React
 * state, never part of the persisted `document`: `TimelinePanel` renders its
 * track content into a track area exactly `totalDurationFrames *
 * pixelsPerFrame` pixels wide inside a native `overflow-x: auto` scroll
 * container, so horizontal scrolling is the browser's own native scrollbar
 * behavior, not a hand-rolled one; `scrollOffsetFrames` is derived from that
 * container's own `scrollLeft` (read in the `onScroll` handler) purely for
 * the pixel/frame math below, not the other way around.
 *
 * Every drag gesture (clip move, left/right trim) follows the identical
 * shape: a `mousedown` on the clip/handle records a `DragState` in a ref
 * (global-`document`-scoped `mousemove`/`mouseup` listeners, mirroring
 * `mountPreview`'s own scrubber - not Pointer Events/`setPointerCapture`,
 * for the same jsdom-compatibility reason that module documents; the
 * component's own `SceneDocument` prop is destructured as `sceneDocument`,
 * not `document`, specifically so it never shadows the global `document`
 * object these listeners are attached to), each `mousemove` recomputes a
 * live preview position via the pure functions in
 * `../timeline/timeline-math.js` and stores it in a small piece of React
 * state purely for rendering feedback during the drag, and `mouseup`
 * performs exactly one `commitDocument` call with the final computed
 * result.
 *
 * Validation posture: this panel clamps in the pure math *before* ever
 * calling `commitDocument` (a drag can never propose a negative
 * `startFrame` or a non-positive `durationInFrames`, since
 * `computeClipMove`/`computeTrimLeft`/`computeTrimRight` themselves enforce
 * those bounds), so in practice the constructed candidate document already
 * satisfies every schema constraint a drag/trim could violate before
 * `commitDocument`'s own `parseScene` gate ever sees it. `commitDocument` is
 * still the real, only gate (this panel does not duplicate schema
 * validation, only the narrow numeric bounds a UI drag needs for sane
 * visual feedback); if a future gesture this phase does not anticipate ever
 * did produce an invalid candidate, `commitDocument` would reject it and
 * this panel's rendered state (driven by `sceneDocument`/
 * `selectedCompositionId` props, not by the drag's own local preview state
 * once the gesture ends) would simply continue showing the last-known-valid
 * document, exactly like every other rejected edit in this store.
 */
export function TimelinePanel({
  document: sceneDocument,
  selectedCompositionId,
  commitDocument,
  previewHandle,
  onUndo,
  onRedo,
}: TimelinePanelProps): JSX.Element {
  const [pixelsPerFrame, setPixelsPerFrame] = useState(DEFAULT_PIXELS_PER_FRAME);
  const [scrollOffsetFrames, setScrollOffsetFrames] = useState(0);
  const [playheadFrame, setPlayheadFrame] = useState(0);
  /**
   * Live visual feedback for whichever clip is currently mid-drag, or
   * `undefined` when nothing is being dragged. Purely a rendering concern:
   * the committed `sceneDocument` (via props) is the only source of truth
   * once a drag ends.
   *
   * Mirrored into `dragPreviewRef` below (the same "ref alongside state"
   * shape `dragStateRef` already uses): `handleDocumentMouseMove`/
   * `handleDocumentMouseUp` are registered once per gesture (in
   * `handleClipMouseDown`/`handleTrimHandleMouseDown`, via
   * `document.addEventListener`) and must always read the *latest*
   * `dragPreview` value, but a plain `useState` closure captured at
   * registration time would go stale the moment a later `mousemove` in the
   * same gesture calls `setDragPreview` and triggers a re-render: React does
   * not retroactively rebind an already-attached DOM listener to a new
   * closure, so the still-attached `mouseup` listener would otherwise see
   * whatever `dragPreview` was at gesture start (`undefined`), not
   * whatever the most recent `mousemove` actually computed. Reading from
   * `dragPreviewRef.current` inside these two handlers instead sidesteps
   * that entirely.
   */
  const [dragPreview, setDragPreview] = useState<
    { trackId: string; clipId: string; startFrame: number; durationInFrames: number } | undefined
  >(undefined);
  const dragPreviewRef = useRef<typeof dragPreview>(undefined);

  function updateDragPreview(next: typeof dragPreview): void {
    dragPreviewRef.current = next;
    setDragPreview(next);
  }

  const dragStateRef = useRef<DragState | undefined>(undefined);
  const trackAreaRef = useRef<HTMLDivElement>(null);

  const composition = sceneDocument.project.compositions.find(
    (candidate) => candidate.id === selectedCompositionId,
  );

  // Sync the playhead from the shared PreviewHandle: initialize from
  // getFrame() immediately (covers a handle that already exists with
  // playback/seeks having happened before this panel mounted), then
  // subscribe to onFrameChanged for every subsequent change, for any
  // reason (playback, a viewport scrub, or this panel's own playhead drag
  // below calling seek()).
  useEffect(() => {
    if (previewHandle === undefined) {
      return undefined;
    }
    setPlayheadFrame(previewHandle.getFrame());
    const unsubscribe = previewHandle.onFrameChanged((frame) => {
      setPlayheadFrame(frame);
    });
    return unsubscribe;
  }, [previewHandle]);

  function handleZoomIn(): void {
    setPixelsPerFrame((current) =>
      clampZoom(current * ZOOM_STEP_FACTOR, MIN_PIXELS_PER_FRAME, MAX_PIXELS_PER_FRAME),
    );
  }

  function handleZoomOut(): void {
    setPixelsPerFrame((current) =>
      clampZoom(current / ZOOM_STEP_FACTOR, MIN_PIXELS_PER_FRAME, MAX_PIXELS_PER_FRAME),
    );
  }

  function handleTrackAreaScroll(): void {
    const trackArea = trackAreaRef.current;
    if (trackArea === null) {
      return;
    }
    setScrollOffsetFrames(trackArea.scrollLeft / pixelsPerFrame);
  }

  /** Converts a mouse event's clientX to a frame, using the track area's live bounding rect (the one real DOM-geometry read this component needs). */
  function clientXToFrame(clientX: number): number {
    const trackArea = trackAreaRef.current;
    if (trackArea === null) {
      return 0;
    }
    const rect = trackArea.getBoundingClientRect();
    return pixelToFrame(clientX - rect.left, pixelsPerFrame, scrollOffsetFrames);
  }

  function handlePlayheadMouseDown(event: React.MouseEvent): void {
    dragStateRef.current = { kind: "playhead" };
    previewHandle?.seek(clientXToFrame(event.clientX));
    document.addEventListener("mousemove", handleDocumentMouseMove);
    document.addEventListener("mouseup", handleDocumentMouseUp);
  }

  function handleClipMouseDown(
    event: React.MouseEvent,
    trackId: string,
    clipId: string,
    originalStartFrame: number,
  ): void {
    event.stopPropagation();
    dragStateRef.current = {
      kind: "move",
      trackId,
      clipId,
      originalStartFrame,
      startClientX: event.clientX,
      currentTrackId: trackId,
    };
    document.addEventListener("mousemove", handleDocumentMouseMove);
    document.addEventListener("mouseup", handleDocumentMouseUp);
  }

  /**
   * A track row's `onMouseEnter`: if a clip move is currently in progress,
   * records this row's `trackId` as the current drop target. A no-op
   * otherwise (entering a track row while nothing is being dragged, or
   * while a trim/playhead drag is in progress, changes nothing).
   */
  function handleTrackRowMouseEnter(trackId: string): void {
    const dragState = dragStateRef.current;
    if (dragState === undefined || dragState.kind !== "move") {
      return;
    }
    dragState.currentTrackId = trackId;
  }

  function handleTrimHandleMouseDown(
    event: React.MouseEvent,
    kind: "trim-left" | "trim-right",
    trackId: string,
    clipId: string,
    originalStartFrame: number,
    originalDurationInFrames: number,
  ): void {
    event.stopPropagation();
    dragStateRef.current = {
      kind,
      trackId,
      clipId,
      originalStartFrame,
      originalDurationInFrames,
      startClientX: event.clientX,
    };
    document.addEventListener("mousemove", handleDocumentMouseMove);
    document.addEventListener("mouseup", handleDocumentMouseUp);
  }

  function handleDocumentMouseMove(event: MouseEvent): void {
    const dragState = dragStateRef.current;
    if (dragState === undefined || composition === undefined) {
      return;
    }

    if (dragState.kind === "playhead") {
      previewHandle?.seek(clientXToFrame(event.clientX));
      return;
    }

    const pixelDeltaX = event.clientX - dragState.startClientX;
    const snapTargets = [
      ...collectClipBoundaries(composition, dragState.clipId),
      { frame: playheadFrame },
    ];

    if (dragState.kind === "move") {
      const result = computeClipMove(
        dragState.originalStartFrame,
        pixelDeltaX,
        pixelsPerFrame,
        snapTargets,
        SNAP_THRESHOLD_FRAMES,
      );
      const sourceTrack = composition.tracks.find((candidate) => candidate.id === dragState.trackId);
      const clip = sourceTrack?.clips.find((candidate) => candidate.id === dragState.clipId);
      // Rendered under dragState.currentTrackId (the row the pointer is
      // currently over, updated by handleTrackRowMouseEnter), not the
      // clip's original trackId: this is what makes a cross-track drag show
      // the clip moving to the hovered row live, before the drag even ends.
      updateDragPreview({
        trackId: dragState.currentTrackId,
        clipId: dragState.clipId,
        startFrame: result.startFrame,
        durationInFrames: clip?.durationInFrames ?? 0,
      });
      return;
    }

    if (dragState.kind === "trim-left") {
      const result = computeTrimLeft(
        dragState.originalStartFrame,
        dragState.originalDurationInFrames,
        pixelDeltaX,
        pixelsPerFrame,
        snapTargets,
        SNAP_THRESHOLD_FRAMES,
      );
      updateDragPreview({
        trackId: dragState.trackId,
        clipId: dragState.clipId,
        startFrame: result.startFrame,
        durationInFrames: result.durationInFrames,
      });
      return;
    }

    // trim-right
    const result = computeTrimRight(
      dragState.originalStartFrame,
      dragState.originalDurationInFrames,
      pixelDeltaX,
      pixelsPerFrame,
      snapTargets,
      SNAP_THRESHOLD_FRAMES,
    );
    updateDragPreview({
      trackId: dragState.trackId,
      clipId: dragState.clipId,
      startFrame: dragState.originalStartFrame,
      durationInFrames: result.durationInFrames,
    });
  }

  function handleDocumentMouseUp(): void {
    document.removeEventListener("mousemove", handleDocumentMouseMove);
    document.removeEventListener("mouseup", handleDocumentMouseUp);

    const dragState = dragStateRef.current;
    dragStateRef.current = undefined;
    const finalPreview = dragPreviewRef.current;
    updateDragPreview(undefined);

    if (
      dragState === undefined ||
      dragState.kind === "playhead" ||
      composition === undefined ||
      finalPreview === undefined
    ) {
      return;
    }

    // A "move" drag that ended over a different track (dragState.trackId,
    // the clip's original track, versus dragState.currentTrackId, the row
    // last hovered per handleTrackRowMouseEnter) is a cross-track reorder,
    // via moveClipToTrack; every other case (a same-track move, or either
    // trim direction, which never changes track) is a same-track timing
    // update via updateClipTiming.
    const nextComposition =
      dragState.kind === "move" && dragState.currentTrackId !== dragState.trackId
        ? moveClipToTrack(composition, dragState.trackId, dragState.clipId, dragState.currentTrackId, {
            startFrame: finalPreview.startFrame,
            durationInFrames: finalPreview.durationInFrames,
          })
        : updateClipTiming(composition, dragState.trackId, dragState.clipId, {
            startFrame: finalPreview.startFrame,
            durationInFrames: finalPreview.durationInFrames,
          });
    const candidate = replaceComposition(sceneDocument, selectedCompositionId, nextComposition);
    commitDocument(candidate);
  }

  if (composition === undefined) {
    return (
      <div
        className="cadra-studio-panel cadra-studio-panel--timeline"
        data-testid="studio-timeline-panel"
      >
        <span className="cadra-studio-panel__label">No composition selected.</span>
      </div>
    );
  }

  const totalWidthPixels = composition.durationInFrames * pixelsPerFrame;
  const playheadLeftPixels = frameToPixel(playheadFrame, pixelsPerFrame, scrollOffsetFrames);

  return (
    <div className="cadra-studio-timeline" data-testid="studio-timeline-panel">
      <div className="cadra-studio-timeline__toolbar">
        <button type="button" onClick={onUndo} data-testid="timeline-undo">
          Undo
        </button>
        <button type="button" onClick={onRedo} data-testid="timeline-redo">
          Redo
        </button>
        <button type="button" onClick={handleZoomOut} data-testid="timeline-zoom-out">
          -
        </button>
        <span className="cadra-studio-timeline__zoom-readout">
          {pixelsPerFrame.toFixed(1)}px/frame
        </span>
        <button type="button" onClick={handleZoomIn} data-testid="timeline-zoom-in">
          +
        </button>
      </div>
      <div
        className="cadra-studio-timeline__scroll-area"
        ref={trackAreaRef}
        onScroll={handleTrackAreaScroll}
        data-testid="timeline-track-area"
      >
        <div className="cadra-studio-timeline__content" style={{ width: `${totalWidthPixels}px` }}>
          <div
            className="cadra-studio-timeline__ruler"
            data-testid="timeline-ruler"
            onMouseDown={handlePlayheadMouseDown}
          >
            <div
              className="cadra-studio-timeline__playhead"
              data-testid="timeline-playhead"
              style={{ left: `${playheadLeftPixels}px` }}
            />
          </div>
          {composition.tracks.map((track) => (
            <div
              className="cadra-studio-timeline__track"
              key={track.id}
              data-testid={`timeline-track-${track.id}`}
              style={{ height: `${TRACK_ROW_HEIGHT}px` }}
              onMouseEnter={() => handleTrackRowMouseEnter(track.id)}
            >
              {track.clips.map((clip) => {
                const isDragging =
                  dragPreview !== undefined &&
                  dragPreview.trackId === track.id &&
                  dragPreview.clipId === clip.id;
                const startFrame = isDragging ? dragPreview.startFrame : clip.startFrame;
                const durationInFrames = isDragging
                  ? dragPreview.durationInFrames
                  : clip.durationInFrames;
                const leftPixels = frameToPixel(startFrame, pixelsPerFrame, scrollOffsetFrames);
                const widthPixels = durationInFrames * pixelsPerFrame;

                return (
                  <div
                    className="cadra-studio-timeline__clip"
                    key={clip.id}
                    data-testid={`timeline-clip-${clip.id}`}
                    style={{ left: `${leftPixels}px`, width: `${widthPixels}px` }}
                    onMouseDown={(event) =>
                      handleClipMouseDown(event, track.id, clip.id, clip.startFrame)
                    }
                  >
                    <div
                      className="cadra-studio-timeline__clip-trim-handle cadra-studio-timeline__clip-trim-handle--left"
                      data-testid={`timeline-clip-${clip.id}-trim-left`}
                      onMouseDown={(event) =>
                        handleTrimHandleMouseDown(
                          event,
                          "trim-left",
                          track.id,
                          clip.id,
                          clip.startFrame,
                          clip.durationInFrames,
                        )
                      }
                    />
                    <span className="cadra-studio-timeline__clip-label">
                      {clip.id}
                    </span>
                    <div
                      className="cadra-studio-timeline__clip-trim-handle cadra-studio-timeline__clip-trim-handle--right"
                      data-testid={`timeline-clip-${clip.id}-trim-right`}
                      onMouseDown={(event) =>
                        handleTrimHandleMouseDown(
                          event,
                          "trim-right",
                          track.id,
                          clip.id,
                          clip.startFrame,
                          clip.durationInFrames,
                        )
                      }
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
