import { createComposition, createProject } from "@cadra/core";
import type { ObservedSize, ObserveResizeFn, UnobserveResizeFn } from "@cadra/player";
import type { Renderer, RendererCapabilities, RenderSize, RenderTarget } from "@cadra/renderer";
import type { SceneDocument } from "@cadra/schema";
import { CURRENT_SCHEMA_VERSION } from "@cadra/schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Viewport } from "./Viewport.js";

/**
 * A fake `Renderer`, matching `@cadra/player`'s own `mount-preview.test.ts`
 * fakes: records calls, touches no GPU. Needed here for exactly the same
 * reason: a real `Renderer` (via `createRenderer`) reaches into real
 * WebGPU/WebGL2 canvas contexts jsdom does not implement.
 */
function createFakeRenderer(): Renderer {
  return {
    init: vi.fn(async (_target: RenderTarget, _size: RenderSize) => undefined),
    renderFrame: vi.fn(() => undefined),
    resize: vi.fn((_size: RenderSize) => undefined),
    dispose: vi.fn(() => undefined),
    backend: "webgl2",
    capabilities: {
      backend: "webgl2",
      isFallback: true,
      maxTextureSize: 4096,
    } as RendererCapabilities,
  };
}

/** A fake `ObserveResizeFn` that never touches a real `ResizeObserver` (jsdom implements none). */
function createFakeObserveResize(): ObserveResizeFn {
  return (_element: Element, _onResize: (size: ObservedSize) => void): UnobserveResizeFn =>
    () => {
      // no-op unobserve
    };
}

function buildDocument(compositionId: string): SceneDocument {
  const composition = createComposition({
    id: compositionId,
    name: "Comp",
    fps: 30,
    durationInFrames: 60,
    width: 640,
    height: 360,
  });
  const project = createProject({ id: "p1", name: "Project", compositions: [composition] });
  return { schemaVersion: CURRENT_SCHEMA_VERSION, project };
}

describe("Viewport", () => {
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

  it("mounts a preview surface into the DOM", async () => {
    const createRenderer = vi.fn(createFakeRenderer);
    const observeResize = createFakeObserveResize();

    await act(async () => {
      root.render(
        <Viewport
          document={buildDocument("comp-1")}
          selectedCompositionId="comp-1"
          createRenderer={createRenderer}
          observeResize={observeResize}
        />,
      );
    });

    expect(container.querySelector('[data-testid="studio-viewport"]')).not.toBeNull();
    expect(container.querySelector(".cadra-preview__canvas")).not.toBeNull();
    expect(createRenderer).toHaveBeenCalledTimes(1);
  });

  it("remounts (disposes the old renderer, constructs a new one) when the document changes", async () => {
    const firstRenderer = createFakeRenderer();
    const secondRenderer = createFakeRenderer();
    const createRenderer = vi
      .fn()
      .mockReturnValueOnce(firstRenderer)
      .mockReturnValueOnce(secondRenderer);
    const observeResize = createFakeObserveResize();

    await act(async () => {
      root.render(
        <Viewport
          document={buildDocument("comp-1")}
          selectedCompositionId="comp-1"
          createRenderer={createRenderer}
          observeResize={observeResize}
        />,
      );
    });

    await act(async () => {
      root.render(
        <Viewport
          document={buildDocument("comp-2")}
          selectedCompositionId="comp-2"
          createRenderer={createRenderer}
          observeResize={observeResize}
        />,
      );
    });

    expect(createRenderer).toHaveBeenCalledTimes(2);
    expect(firstRenderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not remount when neither document nor selectedCompositionId change", async () => {
    const createRenderer = vi.fn(createFakeRenderer);
    const observeResize = createFakeObserveResize();
    const document = buildDocument("comp-1");

    await act(async () => {
      root.render(
        <Viewport
          document={document}
          selectedCompositionId="comp-1"
          createRenderer={createRenderer}
          observeResize={observeResize}
        />,
      );
    });

    // Re-render with the exact same document reference and selection: this
    // simulates a parent re-render that did not itself come from a new
    // commitDocument() (e.g. an unrelated store field changing), which
    // should not tear down and reconstruct the preview.
    await act(async () => {
      root.render(
        <Viewport
          document={document}
          selectedCompositionId="comp-1"
          createRenderer={createRenderer}
          observeResize={observeResize}
        />,
      );
    });

    expect(createRenderer).toHaveBeenCalledTimes(1);
  });

  it("disposes the renderer on unmount", async () => {
    const renderer = createFakeRenderer();
    const createRenderer = vi.fn().mockReturnValue(renderer);
    const observeResize = createFakeObserveResize();

    await act(async () => {
      root.render(
        <Viewport
          document={buildDocument("comp-1")}
          selectedCompositionId="comp-1"
          createRenderer={createRenderer}
          observeResize={observeResize}
        />,
      );
    });

    act(() => {
      root.unmount();
    });

    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  describe("click-to-select", () => {
    it("calls onSelectNode on a canvas click (a fake Renderer is not a real ThreeRenderer, so pickNodeAtPoint gracefully reports no hit)", async () => {
      const createRenderer = vi.fn(createFakeRenderer);
      const observeResize = createFakeObserveResize();
      const onSelectNode = vi.fn();

      await act(async () => {
        root.render(
          <Viewport
            document={buildDocument("comp-1")}
            selectedCompositionId="comp-1"
            createRenderer={createRenderer}
            observeResize={observeResize}
            onSelectNode={onSelectNode}
          />,
        );
      });

      const canvas = container.querySelector(".cadra-preview__canvas");
      expect(canvas).not.toBeNull();
      // getBoundingClientRect defaults to all-zero in jsdom (no real
      // layout); Viewport's own click handler bails out early on a
      // zero-size rect (see its own guard), so this stubs a non-zero rect,
      // the same seam TimelinePanel.test.tsx's own stubTrackAreaRect uses
      // for an identical reason.
      vi.spyOn(canvas as HTMLCanvasElement, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        right: 640,
        bottom: 360,
        width: 640,
        height: 360,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      act(() => {
        canvas?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, clientX: 320, clientY: 180 }),
        );
      });

      // A fake Renderer is never `instanceof ThreeRenderer`, so
      // pickNodeAtPoint's own graceful "not a real renderer" path always
      // reports undefined here: this proves the click listener is wired
      // through to onSelectNode at all (the pure data-flow this codebase
      // tests in this situation), not that real raycast hit-testing works
      // (proven instead by pick-node-at-point.test.ts in @cadra/renderer,
      // against a real ThreeRenderer/scene/camera).
      expect(onSelectNode).toHaveBeenCalledWith(undefined);
    });

    it("removes the click listener when the canvas is torn down (document change)", async () => {
      const createRenderer = vi.fn(createFakeRenderer);
      const observeResize = createFakeObserveResize();
      const onSelectNode = vi.fn();

      await act(async () => {
        root.render(
          <Viewport
            document={buildDocument("comp-1")}
            selectedCompositionId="comp-1"
            createRenderer={createRenderer}
            observeResize={observeResize}
            onSelectNode={onSelectNode}
          />,
        );
      });

      const firstCanvas = container.querySelector(".cadra-preview__canvas");
      expect(firstCanvas).not.toBeNull();

      await act(async () => {
        root.render(
          <Viewport
            document={buildDocument("comp-2")}
            selectedCompositionId="comp-2"
            createRenderer={createRenderer}
            observeResize={observeResize}
            onSelectNode={onSelectNode}
          />,
        );
      });

      act(() => {
        firstCanvas?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }),
        );
      });

      // The old canvas element is gone from the DOM after the remount; a
      // click dispatched directly against the detached reference must not
      // still be wired to onSelectNode.
      expect(onSelectNode).not.toHaveBeenCalled();
    });
  });

  describe("selection-driven gizmo attach", () => {
    it("does not throw when selectedNodeId is set against a fake (non-ThreeRenderer) Renderer", async () => {
      const createRenderer = vi.fn(createFakeRenderer);
      const observeResize = createFakeObserveResize();

      await expect(
        act(async () => {
          root.render(
            <Viewport
              document={buildDocument("comp-1")}
              selectedCompositionId="comp-1"
              createRenderer={createRenderer}
              observeResize={observeResize}
              selectedNodeId="some-node"
              commitDocument={vi.fn(() => true)}
            />,
          );
        }),
      ).resolves.not.toThrow();

      expect(container.querySelector('[data-testid="studio-viewport"]')).not.toBeNull();
    });

    it("does not throw when selectedNodeId changes across a re-render", async () => {
      const createRenderer = vi.fn(createFakeRenderer);
      const observeResize = createFakeObserveResize();
      const document = buildDocument("comp-1");

      await act(async () => {
        root.render(
          <Viewport
            document={document}
            selectedCompositionId="comp-1"
            createRenderer={createRenderer}
            observeResize={observeResize}
            selectedNodeId="node-a"
            commitDocument={vi.fn(() => true)}
          />,
        );
      });

      await expect(
        act(async () => {
          root.render(
            <Viewport
              document={document}
              selectedCompositionId="comp-1"
              createRenderer={createRenderer}
              observeResize={observeResize}
              selectedNodeId="node-b"
              commitDocument={vi.fn(() => true)}
            />,
          );
        }),
      ).resolves.not.toThrow();
    });

    it("does not throw when selectedNodeId is cleared back to undefined", async () => {
      const createRenderer = vi.fn(createFakeRenderer);
      const observeResize = createFakeObserveResize();
      const document = buildDocument("comp-1");

      await act(async () => {
        root.render(
          <Viewport
            document={document}
            selectedCompositionId="comp-1"
            createRenderer={createRenderer}
            observeResize={observeResize}
            selectedNodeId="node-a"
            commitDocument={vi.fn(() => true)}
          />,
        );
      });

      await expect(
        act(async () => {
          root.render(
            <Viewport
              document={document}
              selectedCompositionId="comp-1"
              createRenderer={createRenderer}
              observeResize={observeResize}
              selectedNodeId={undefined}
              commitDocument={vi.fn(() => true)}
            />,
          );
        }),
      ).resolves.not.toThrow();
    });
  });
});
