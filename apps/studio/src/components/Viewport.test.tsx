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
});
