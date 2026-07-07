import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AssetPanel } from "./AssetPanel.js";

/**
 * A shared suite for the one panel still a stub as of this phase (asset;
 * real asset browsing/import lands in Phase 40): a labeled placeholder box.
 * Kept as its own minimal file since there is exactly one behavior to
 * prove: it renders, with its expected `data-testid`.
 *
 * Neither `TimelinePanel` (Phase 38) nor `InspectorPanel` (this phase, 39)
 * is covered here any longer: both are now real, non-stub components
 * requiring real props (`InspectorPanel` needs `document`, `selectedNodeId`,
 * `previewHandle`, `commitPropertyEdit`), so a bare `<InspectorPanel />`
 * with no props no longer typechecks the way a stub component does. Each
 * has its own dedicated test file (`TimelinePanel.test.tsx`,
 * `InspectorPanel.test.tsx`); `App.test.tsx` also continues to prove both
 * render correctly within the full shell.
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
});
