import { createComposition, createIdentityTransform, createProject } from "@cadra/core";
import type { PreviewHandle } from "@cadra/player";
import type { SceneDocument } from "@cadra/schema";
import { CURRENT_SCHEMA_VERSION } from "@cadra/schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TimelinePanel } from "./TimelinePanel.js";

const COMPOSITION_ID = "comp-1";
const TRACK_A_ID = "track-a";
const TRACK_B_ID = "track-b";
const CLIP_1_ID = "clip-1";
const CLIP_2_ID = "clip-2";

/** A document with one composition, two tracks: track-a has clip-1 [10, 40) and clip-2 [50, 70); track-b is empty. */
function buildDocument(): SceneDocument {
  const composition = createComposition({
    id: COMPOSITION_ID,
    name: "Comp",
    fps: 30,
    durationInFrames: 300,
    width: 1920,
    height: 1080,
    tracks: [
      {
        id: TRACK_A_ID,
        clips: [
          {
            id: CLIP_1_ID,
            startFrame: 10,
            durationInFrames: 30,
            node: {
              id: "node-1",
              kind: "group",
              transform: createIdentityTransform(),
              visible: true,
              children: [],
            },
          },
          {
            id: CLIP_2_ID,
            startFrame: 50,
            durationInFrames: 20,
            node: {
              id: "node-2",
              kind: "group",
              transform: createIdentityTransform(),
              visible: true,
              children: [],
            },
          },
        ],
      },
      { id: TRACK_B_ID, clips: [] },
    ],
  });
  const project = createProject({ id: "p1", name: "Project", compositions: [composition] });
  return { schemaVersion: CURRENT_SCHEMA_VERSION, project };
}

/**
 * A fake `PreviewHandle`: records `seek` calls (exposed as a full `Mock`,
 * not narrowed to `PreviewHandle`'s own plain function signature, so tests
 * can call `.mockClear()`/inspect `.mock.calls` on it directly), supports
 * `onFrameChanged` subscription/emission for tests to drive directly via
 * `emitFrameChanged`.
 */
function createFakePreviewHandle(initialFrame = 0) {
  let currentFrame = initialFrame;
  const handlers = new Set<(frame: number) => void>();

  const seek = vi.fn((frame: number) => {
    currentFrame = frame;
    for (const handler of handlers) {
      handler(frame);
    }
  });
  const onFrameChanged = vi.fn((handler: (frame: number) => void) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  });

  const handle: PreviewHandle = {
    seek,
    play: vi.fn(),
    pause: vi.fn(),
    getFrame: () => currentFrame,
    onFrameChanged,
    dispose: vi.fn(),
  };

  return {
    ...handle,
    seek,
    onFrameChanged,
    emitFrameChanged: (frame: number) => {
      currentFrame = frame;
      for (const handler of handlers) {
        handler(frame);
      }
    },
  };
}

/** Stubs `getBoundingClientRect` on `element` to a fixed synthetic rect, the same seam `mount-preview.test.ts` uses for its own scrubber track. */
function stubTrackAreaRect(element: HTMLElement, left: number, width: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    left,
    right: left + width,
    width,
    top: 0,
    bottom: 100,
    height: 100,
    x: left,
    y: 0,
    toJSON: () => ({}),
  });
}

describe("TimelinePanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders one row per track and one box per clip", async () => {
    const commitDocument = vi.fn((_candidate: unknown) => true);
    await act(async () => {
      root.render(
        <TimelinePanel
          document={buildDocument()}
          selectedCompositionId={COMPOSITION_ID}
          commitDocument={commitDocument}
          previewHandle={undefined}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
        />,
      );
    });

    expect(container.querySelector(`[data-testid="timeline-track-${TRACK_A_ID}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="timeline-track-${TRACK_B_ID}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="timeline-clip-${CLIP_1_ID}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="timeline-clip-${CLIP_2_ID}"]`)).not.toBeNull();
  });

  it("renders the ruler and playhead", async () => {
    await act(async () => {
      root.render(
        <TimelinePanel
          document={buildDocument()}
          selectedCompositionId={COMPOSITION_ID}
          commitDocument={vi.fn((_candidate: unknown) => true)}
          previewHandle={undefined}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('[data-testid="timeline-ruler"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="timeline-playhead"]')).not.toBeNull();
  });

  it("shows a fallback message when selectedCompositionId does not match any composition", async () => {
    await act(async () => {
      root.render(
        <TimelinePanel
          document={buildDocument()}
          selectedCompositionId="does-not-exist"
          commitDocument={vi.fn((_candidate: unknown) => true)}
          previewHandle={undefined}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('[data-testid="studio-timeline-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="timeline-ruler"]')).toBeNull();
  });

  describe("zoom controls", () => {
    it("zoom-in increases the zoom readout", async () => {
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={vi.fn((_candidate: unknown) => true)}
            previewHandle={undefined}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      const before = container.querySelector(".cadra-studio-timeline__zoom-readout")?.textContent;
      const zoomInButton = container.querySelector(
        '[data-testid="timeline-zoom-in"]',
      ) as HTMLButtonElement;

      await act(async () => {
        zoomInButton.click();
      });

      const after = container.querySelector(".cadra-studio-timeline__zoom-readout")?.textContent;
      expect(after).not.toBe(before);
    });

    it("zoom-out decreases the zoom readout", async () => {
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={vi.fn((_candidate: unknown) => true)}
            previewHandle={undefined}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      const before = container.querySelector(".cadra-studio-timeline__zoom-readout")?.textContent;
      const zoomOutButton = container.querySelector(
        '[data-testid="timeline-zoom-out"]',
      ) as HTMLButtonElement;

      await act(async () => {
        zoomOutButton.click();
      });

      const after = container.querySelector(".cadra-studio-timeline__zoom-readout")?.textContent;
      expect(after).not.toBe(before);
    });
  });

  describe("undo/redo buttons", () => {
    it("clicking Undo calls onUndo", async () => {
      const onUndo = vi.fn();
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={vi.fn((_candidate: unknown) => true)}
            previewHandle={undefined}
            onUndo={onUndo}
            onRedo={vi.fn()}
          />,
        );
      });

      const undoButton = container.querySelector(
        '[data-testid="timeline-undo"]',
      ) as HTMLButtonElement;
      await act(async () => {
        undoButton.click();
      });

      expect(onUndo).toHaveBeenCalledTimes(1);
    });

    it("clicking Redo calls onRedo", async () => {
      const onRedo = vi.fn();
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={vi.fn((_candidate: unknown) => true)}
            previewHandle={undefined}
            onUndo={vi.fn()}
            onRedo={onRedo}
          />,
        );
      });

      const redoButton = container.querySelector(
        '[data-testid="timeline-redo"]',
      ) as HTMLButtonElement;
      await act(async () => {
        redoButton.click();
      });

      expect(onRedo).toHaveBeenCalledTimes(1);
    });
  });

  describe("playhead binding to the shared PreviewHandle", () => {
    it("initializes the playhead from previewHandle.getFrame()", async () => {
      const previewHandle = createFakePreviewHandle(42);
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={vi.fn((_candidate: unknown) => true)}
            previewHandle={previewHandle}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      expect(previewHandle.onFrameChanged).toHaveBeenCalledTimes(1);
    });

    it("updates the rendered playhead position when the handle emits onFrameChanged", async () => {
      const previewHandle = createFakePreviewHandle(0);
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={vi.fn((_candidate: unknown) => true)}
            previewHandle={previewHandle}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      const playheadBefore = container.querySelector(
        '[data-testid="timeline-playhead"]',
      ) as HTMLElement;
      const leftBefore = playheadBefore.style.left;

      await act(async () => {
        previewHandle.emitFrameChanged(100);
      });

      const playheadAfter = container.querySelector(
        '[data-testid="timeline-playhead"]',
      ) as HTMLElement;
      expect(playheadAfter.style.left).not.toBe(leftBefore);
    });

    it("dragging the ruler (playhead) calls previewHandle.seek with the pointer's frame", async () => {
      const previewHandle = createFakePreviewHandle(0);
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={vi.fn((_candidate: unknown) => true)}
            previewHandle={previewHandle}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      const trackArea = container.querySelector(
        '[data-testid="timeline-track-area"]',
      ) as HTMLElement;
      stubTrackAreaRect(trackArea, 0, 1200); // pixelsPerFrame 4 by default: 1200px = 300 frames visible

      const ruler = container.querySelector('[data-testid="timeline-ruler"]') as HTMLElement;
      await act(async () => {
        ruler.dispatchEvent(
          new MouseEvent("mousedown", { clientX: 40, bubbles: true, cancelable: true }),
        );
      });

      // clientX 40 at pixelsPerFrame 4, scrollOffsetFrames 0 -> frame 10.
      expect(previewHandle.seek).toHaveBeenCalledWith(10);
    });

    it("dragging the ruler continues seeking on subsequent mousemove", async () => {
      const previewHandle = createFakePreviewHandle(0);
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={vi.fn((_candidate: unknown) => true)}
            previewHandle={previewHandle}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      const trackArea = container.querySelector(
        '[data-testid="timeline-track-area"]',
      ) as HTMLElement;
      stubTrackAreaRect(trackArea, 0, 1200);

      const ruler = container.querySelector('[data-testid="timeline-ruler"]') as HTMLElement;
      await act(async () => {
        ruler.dispatchEvent(
          new MouseEvent("mousedown", { clientX: 40, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        document.dispatchEvent(
          new MouseEvent("mousemove", { clientX: 80, bubbles: true, cancelable: true }),
        );
      });

      expect(previewHandle.seek).toHaveBeenLastCalledWith(20);
    });

    it("mousemove after mouseup no longer seeks", async () => {
      const previewHandle = createFakePreviewHandle(0);
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={vi.fn((_candidate: unknown) => true)}
            previewHandle={previewHandle}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      const trackArea = container.querySelector(
        '[data-testid="timeline-track-area"]',
      ) as HTMLElement;
      stubTrackAreaRect(trackArea, 0, 1200);

      const ruler = container.querySelector('[data-testid="timeline-ruler"]') as HTMLElement;
      await act(async () => {
        ruler.dispatchEvent(
          new MouseEvent("mousedown", { clientX: 40, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      });
      previewHandle.seek.mockClear();
      await act(async () => {
        document.dispatchEvent(
          new MouseEvent("mousemove", { clientX: 200, bubbles: true, cancelable: true }),
        );
      });

      expect(previewHandle.seek).not.toHaveBeenCalled();
    });
  });

  describe("dragging a clip to move it", () => {
    it("dragging a clip right by a pixel delta updates its committed startFrame", async () => {
      const commitDocument = vi.fn((_candidate: unknown) => true);
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={commitDocument}
            previewHandle={undefined}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      const clip = container.querySelector(`[data-testid="timeline-clip-${CLIP_1_ID}"]`) as HTMLElement;

      await act(async () => {
        clip.dispatchEvent(
          new MouseEvent("mousedown", { clientX: 100, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        // pixelsPerFrame defaults to 4: +40px = +10 frames. clip-1 starts at
        // 10, so the target startFrame is 20 (far enough from clip-2's
        // boundaries at 50/70 to not trigger a snap).
        document.dispatchEvent(
          new MouseEvent("mousemove", { clientX: 140, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      });

      expect(commitDocument).toHaveBeenCalledTimes(1);
      const candidate = commitDocument.mock.calls[0]?.[0] as SceneDocument;
      const track = candidate.project.compositions[0]?.tracks.find((t) => t.id === TRACK_A_ID);
      const movedClip = track?.clips.find((c) => c.id === CLIP_1_ID);
      expect(movedClip?.startFrame).toBe(20);
      expect(movedClip?.durationInFrames).toBe(30); // unchanged
    });

    it("dragging a clip left clamps startFrame to 0, never negative", async () => {
      const commitDocument = vi.fn((_candidate: unknown) => true);
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={commitDocument}
            previewHandle={undefined}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      const clip = container.querySelector(`[data-testid="timeline-clip-${CLIP_1_ID}"]`) as HTMLElement;

      await act(async () => {
        clip.dispatchEvent(
          new MouseEvent("mousedown", { clientX: 100, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        // -1000px is far more than enough to drive startFrame negative
        // before clamping (clip-1 starts at 10, at 4px/frame that is 40px).
        document.dispatchEvent(
          new MouseEvent("mousemove", { clientX: -900, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      });

      const candidate = commitDocument.mock.calls[0]?.[0] as SceneDocument;
      const track = candidate.project.compositions[0]?.tracks.find((t) => t.id === TRACK_A_ID);
      const movedClip = track?.clips.find((c) => c.id === CLIP_1_ID);
      expect(movedClip?.startFrame).toBe(0);
    });

    it("a clip drag snaps to a nearby clip boundary on the same track", async () => {
      const commitDocument = vi.fn((_candidate: unknown) => true);
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={commitDocument}
            previewHandle={undefined}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      const clip = container.querySelector(`[data-testid="timeline-clip-${CLIP_1_ID}"]`) as HTMLElement;

      await act(async () => {
        clip.dispatchEvent(
          new MouseEvent("mousedown", { clientX: 100, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        // clip-1 starts at 10; +160px at 4px/frame = +40 frames -> raw target
        // 50, which is exactly clip-2's own startFrame (a snap target within
        // the default 5-frame threshold).
        document.dispatchEvent(
          new MouseEvent("mousemove", { clientX: 260, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      });

      const candidate = commitDocument.mock.calls[0]?.[0] as SceneDocument;
      const track = candidate.project.compositions[0]?.tracks.find((t) => t.id === TRACK_A_ID);
      const movedClip = track?.clips.find((c) => c.id === CLIP_1_ID);
      expect(movedClip?.startFrame).toBe(50);
    });

    it("dragging a clip onto a different track's row moves it there (reorder across tracks)", async () => {
      const commitDocument = vi.fn((_candidate: unknown) => true);
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={commitDocument}
            previewHandle={undefined}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      const clip = container.querySelector(`[data-testid="timeline-clip-${CLIP_1_ID}"]`) as HTMLElement;
      const trackBRow = container.querySelector(
        `[data-testid="timeline-track-${TRACK_B_ID}"]`,
      ) as HTMLElement;

      await act(async () => {
        clip.dispatchEvent(
          new MouseEvent("mousedown", { clientX: 100, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        // A real cross-track drag involves both entering the new row
        // (recording it as the drop target) and at least one mousemove
        // (which is what actually computes and records a dragPreview;
        // mouseup only ever acts on a drag that produced one, matching this
        // suite's own "a click with no movement does not commit" case).
        //
        // Dispatched as a bubbling "mouseover", not "mouseenter": React
        // implements its synthetic onMouseEnter by listening for the
        // bubbling native "mouseover" and synthesizing enter/leave
        // semantics itself, not by listening for the (non-bubbling) native
        // "mouseenter" event directly. A real browser's actual mouse
        // movement always dispatches a genuine "mouseover" alongside the
        // "mouseenter" it also fires, so this is exactly what a real drag
        // produces; it is only a synthetic single-event dispatch in a test
        // that has to pick the one React's delegation actually listens for.
        trackBRow.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
        document.dispatchEvent(
          new MouseEvent("mousemove", { clientX: 105, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      });

      const candidate = commitDocument.mock.calls[0]?.[0] as SceneDocument;
      const trackA = candidate.project.compositions[0]?.tracks.find((t) => t.id === TRACK_A_ID);
      const trackB = candidate.project.compositions[0]?.tracks.find((t) => t.id === TRACK_B_ID);
      expect(trackA?.clips.map((c) => c.id)).toEqual([CLIP_2_ID]);
      expect(trackB?.clips.map((c) => c.id)).toEqual([CLIP_1_ID]);
    });

    it("does not call commitDocument for a mousedown/mouseup with no movement in between (a click, not a drag)", async () => {
      const commitDocument = vi.fn((_candidate: unknown) => true);
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={commitDocument}
            previewHandle={undefined}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      const clip = container.querySelector(`[data-testid="timeline-clip-${CLIP_1_ID}"]`) as HTMLElement;

      await act(async () => {
        clip.dispatchEvent(
          new MouseEvent("mousedown", { clientX: 100, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      });

      // No mousemove happened, so dragPreview was never set; mouseup should
      // not call commitDocument with a no-op "move to the same place".
      expect(commitDocument).not.toHaveBeenCalled();
    });
  });

  describe("trimming a clip's edges", () => {
    it("dragging the left trim handle right shrinks duration and moves startFrame later, keeping the end frame fixed", async () => {
      const commitDocument = vi.fn((_candidate: unknown) => true);
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={commitDocument}
            previewHandle={undefined}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      const trimLeftHandle = container.querySelector(
        `[data-testid="timeline-clip-${CLIP_1_ID}-trim-left"]`,
      ) as HTMLElement;

      await act(async () => {
        trimLeftHandle.dispatchEvent(
          new MouseEvent("mousedown", { clientX: 40, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        // clip-1 spans [10, 40). +20px at 4px/frame = +5 frames -> startFrame 15, duration 25.
        document.dispatchEvent(
          new MouseEvent("mousemove", { clientX: 60, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      });

      const candidate = commitDocument.mock.calls[0]?.[0] as SceneDocument;
      const track = candidate.project.compositions[0]?.tracks.find((t) => t.id === TRACK_A_ID);
      const trimmedClip = track?.clips.find((c) => c.id === CLIP_1_ID);
      expect(trimmedClip?.startFrame).toBe(15);
      expect(trimmedClip?.durationInFrames).toBe(25);
      expect((trimmedClip?.startFrame ?? 0) + (trimmedClip?.durationInFrames ?? 0)).toBe(40);
    });

    it("dragging the right trim handle right grows duration, startFrame unchanged", async () => {
      const commitDocument = vi.fn((_candidate: unknown) => true);
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={commitDocument}
            previewHandle={undefined}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      const trimRightHandle = container.querySelector(
        `[data-testid="timeline-clip-${CLIP_1_ID}-trim-right"]`,
      ) as HTMLElement;

      await act(async () => {
        trimRightHandle.dispatchEvent(
          new MouseEvent("mousedown", { clientX: 40, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        // clip-1 spans [10, 40). +40px at 4px/frame = +10 frames -> duration 40.
        document.dispatchEvent(
          new MouseEvent("mousemove", { clientX: 80, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      });

      const candidate = commitDocument.mock.calls[0]?.[0] as SceneDocument;
      const track = candidate.project.compositions[0]?.tracks.find((t) => t.id === TRACK_A_ID);
      const trimmedClip = track?.clips.find((c) => c.id === CLIP_1_ID);
      expect(trimmedClip?.startFrame).toBe(10); // unchanged
      expect(trimmedClip?.durationInFrames).toBe(40);
    });

    it("trimming the right handle never shrinks duration below 1 frame", async () => {
      const commitDocument = vi.fn((_candidate: unknown) => true);
      await act(async () => {
        root.render(
          <TimelinePanel
            document={buildDocument()}
            selectedCompositionId={COMPOSITION_ID}
            commitDocument={commitDocument}
            previewHandle={undefined}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />,
        );
      });

      const trimRightHandle = container.querySelector(
        `[data-testid="timeline-clip-${CLIP_1_ID}-trim-right"]`,
      ) as HTMLElement;

      await act(async () => {
        trimRightHandle.dispatchEvent(
          new MouseEvent("mousedown", { clientX: 40, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        document.dispatchEvent(
          new MouseEvent("mousemove", { clientX: -900, bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      });

      const candidate = commitDocument.mock.calls[0]?.[0] as SceneDocument;
      const track = candidate.project.compositions[0]?.tracks.find((t) => t.id === TRACK_A_ID);
      const trimmedClip = track?.clips.find((c) => c.id === CLIP_1_ID);
      expect(trimmedClip?.durationInFrames).toBe(1);
    });
  });
});
