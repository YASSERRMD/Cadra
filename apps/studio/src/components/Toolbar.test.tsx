import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Toolbar } from "./Toolbar.js";

describe("Toolbar", () => {
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

  it("shows the document name and no error slots when there is nothing to report", async () => {
    await act(async () => {
      root.render(
        <Toolbar
          documentName="my-scene.cadra.json"
          isPersistenceBusy={false}
          lastPersistenceError={undefined}
          lastValidationError={undefined}
          onNew={() => {}}
          onOpen={() => {}}
          onSave={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain("my-scene.cadra.json");
    expect(container.querySelector('[data-testid="studio-persistence-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="studio-validation-error"]')).toBeNull();
  });

  it("disables new/open/save while persistence is busy", async () => {
    await act(async () => {
      root.render(
        <Toolbar
          documentName="doc"
          isPersistenceBusy={true}
          lastPersistenceError={undefined}
          lastValidationError={undefined}
          onNew={() => {}}
          onOpen={() => {}}
          onSave={() => {}}
        />,
      );
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
    }
  });

  it("invokes onOpen when the Open button is clicked", async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(
        <Toolbar
          documentName="doc"
          isPersistenceBusy={false}
          lastPersistenceError={undefined}
          lastValidationError={undefined}
          onNew={() => {}}
          onOpen={onOpen}
          onSave={() => {}}
        />,
      );
    });

    const openButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Open",
    );

    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders a persistence error message when one is set", async () => {
    await act(async () => {
      root.render(
        <Toolbar
          documentName="doc"
          isPersistenceBusy={false}
          lastPersistenceError="Save failed: disk full"
          lastValidationError={undefined}
          onNew={() => {}}
          onOpen={() => {}}
          onSave={() => {}}
        />,
      );
    });

    expect(container.querySelector('[data-testid="studio-persistence-error"]')?.textContent).toBe(
      "Save failed: disk full",
    );
  });
});
