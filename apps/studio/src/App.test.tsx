import type { ObservedSize, ObserveResizeFn, UnobserveResizeFn } from "@cadra/player";
import type { Renderer, RendererCapabilities, RenderSize, RenderTarget } from "@cadra/renderer";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import { createFakeDocumentPersistence } from "./persistence/fake-document-persistence.js";
import { createDocumentStore } from "./store/document-store.js";

/** Same fake `Renderer` shape used by `Viewport.test.tsx`; touches no GPU. */
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

/** A fake `ObserveResizeFn` that never touches a real `ResizeObserver`. */
function createFakeObserveResize(): ObserveResizeFn {
  return (_element: Element, _onResize: (size: ObservedSize) => void): UnobserveResizeFn =>
    () => {
      // no-op unobserve
    };
}

describe("App", () => {
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

  it("renders the toolbar, viewport, and every stub panel", async () => {
    const useStore = createDocumentStore(createFakeDocumentPersistence());

    await act(async () => {
      root.render(
        <App
          useStore={useStore}
          createRenderer={createFakeRenderer}
          observeResize={createFakeObserveResize()}
        />,
      );
    });

    expect(container.querySelector('[data-testid="studio-toolbar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="studio-viewport"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="studio-timeline-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="studio-inspector-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="studio-asset-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="studio-dsl-panel"]')).not.toBeNull();
  });

  it("shows the current document's provenance name in the toolbar", async () => {
    const useStore = createDocumentStore(createFakeDocumentPersistence());

    await act(async () => {
      root.render(
        <App
          useStore={useStore}
          createRenderer={createFakeRenderer}
          observeResize={createFakeObserveResize()}
        />,
      );
    });

    expect(container.querySelector(".cadra-studio-toolbar__document-name")?.textContent).toBe(
      "Untitled",
    );
  });

  it("clicking New calls the store's newDocument action", async () => {
    const useStore = createDocumentStore(createFakeDocumentPersistence());
    const newDocumentSpy = vi.spyOn(useStore.getState(), "newDocument");

    await act(async () => {
      root.render(
        <App
          useStore={useStore}
          createRenderer={createFakeRenderer}
          observeResize={createFakeObserveResize()}
        />,
      );
    });

    const newButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "New",
    );
    expect(newButton).toBeDefined();

    await act(async () => {
      newButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(newDocumentSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a validation error via the toolbar's error slot when the store has one", async () => {
    const useStore = createDocumentStore(createFakeDocumentPersistence());
    act(() => {
      useStore.getState().commitDocument({ notEvenACadraDocument: true });
    });

    await act(async () => {
      root.render(
        <App
          useStore={useStore}
          createRenderer={createFakeRenderer}
          observeResize={createFakeObserveResize()}
        />,
      );
    });

    expect(container.querySelector('[data-testid="studio-validation-error"]')).not.toBeNull();
  });
});
