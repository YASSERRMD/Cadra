import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AssetPanel } from "./AssetPanel.js";
import { InspectorPanel } from "./InspectorPanel.js";

/**
 * A shared suite for the two panels still stubs as of this phase
 * (asset/inspector): each is a labeled placeholder box, with real contents
 * landing in Phases 40/39 respectively (see each component's own doc). Kept
 * in one file since there is exactly one behavior to prove per panel: it
 * renders, with its expected `data-testid`.
 *
 * `TimelinePanel` (this phase's own real, non-stub component) is no longer
 * covered here: it now requires real props (`document`,
 * `selectedCompositionId`, `commitDocument`, `previewHandle`, `onUndo`,
 * `onRedo`), so a bare `<TimelinePanel />` no longer typechecks the way the
 * other two stubs still do. Its own behavior has a dedicated
 * `TimelinePanel.test.tsx`; `App.test.tsx` also continues to prove it
 * renders correctly within the full shell.
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
});
