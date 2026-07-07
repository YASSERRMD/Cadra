import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AssetPanel } from "./AssetPanel.js";
import { InspectorPanel } from "./InspectorPanel.js";
import { TimelinePanel } from "./TimelinePanel.js";

/**
 * A single shared suite for this phase's three stub panels
 * (asset/inspector/timeline): each is a labeled placeholder box this phase,
 * with real contents landing in Phases 38/39/40 respectively (see each
 * component's own doc). Kept in one file since there is exactly one
 * behavior to prove per panel this phase: it renders, with its expected
 * `data-testid`.
 */
describe("stub panels", () => {
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

  it("AssetPanel renders its placeholder", async () => {
    await act(async () => {
      root.render(<AssetPanel />);
    });
    expect(container.querySelector('[data-testid="studio-asset-panel"]')).not.toBeNull();
  });

  it("InspectorPanel renders its placeholder", async () => {
    await act(async () => {
      root.render(<InspectorPanel />);
    });
    expect(container.querySelector('[data-testid="studio-inspector-panel"]')).not.toBeNull();
  });

  it("TimelinePanel renders its placeholder", async () => {
    await act(async () => {
      root.render(<TimelinePanel />);
    });
    expect(container.querySelector('[data-testid="studio-timeline-panel"]')).not.toBeNull();
  });
});
