import { createIdentityTransform } from "@cadra/core";
import type { SceneDocument, SceneParseDiagnostic } from "@cadra/schema";
import { CURRENT_SCHEMA_VERSION } from "@cadra/schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DslPanel } from "./DslPanel.js";

const COMPOSITION_ID = "comp-1";
const TRACK_ID = "track-1";
const CLIP_ID = "clip-1";
const NODE_ID = "node-1";
const OTHER_NODE_ID = "node-2";

/** A document with one composition/track/clip, whose root node is a plain group. */
function buildDocument(): SceneDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
      id: "project-1",
      name: "Project",
      compositions: [
        {
          id: COMPOSITION_ID,
          name: "Comp",
          fps: 30,
          durationInFrames: 100,
          width: 1920,
          height: 1080,
          tracks: [
            {
              id: TRACK_ID,
              clips: [
                {
                  id: CLIP_ID,
                  startFrame: 0,
                  durationInFrames: 100,
                  node: {
                    id: NODE_ID,
                    kind: "group",
                    transform: createIdentityTransform(),
                    visible: true,
                    children: [
                      {
                        id: OTHER_NODE_ID,
                        kind: "group",
                        transform: createIdentityTransform(),
                        visible: true,
                        children: [],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** Sets a `<textarea>`'s value the way React's own change detection actually observes (via the native value setter, so React's controlled-input tracking is not bypassed), then dispatches a real `input` event. Mirrors `InspectorPanel.test.tsx`'s own `typeIntoInput` for `HTMLInputElement`. */
function typeIntoTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  nativeTextareaValueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("DslPanel", () => {
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

  it("shows JSON.stringify(document, null, 2) in the textarea", async () => {
    const document = buildDocument();
    await act(async () => {
      root.render(<DslPanel document={document} commitDslEdit={vi.fn()} />);
    });

    const textarea = container.querySelector(
      '[data-testid="dsl-panel-textarea"]',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe(JSON.stringify(document, null, 2));
  });

  it("re-syncs the textarea when document changes and the textarea is not dirty", async () => {
    const firstDocument = buildDocument();
    await act(async () => {
      root.render(<DslPanel document={firstDocument} commitDslEdit={vi.fn()} />);
    });

    const secondDocument: SceneDocument = {
      ...firstDocument,
      project: { ...firstDocument.project, name: "Renamed Project" },
    };
    await act(async () => {
      root.render(<DslPanel document={secondDocument} commitDslEdit={vi.fn()} />);
    });

    const textarea = container.querySelector(
      '[data-testid="dsl-panel-textarea"]',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe(JSON.stringify(secondDocument, null, 2));
  });

  it("does NOT clobber the textarea's text when document changes while the user has an unapplied (dirty) edit", async () => {
    const firstDocument = buildDocument();
    await act(async () => {
      root.render(<DslPanel document={firstDocument} commitDslEdit={vi.fn()} />);
    });

    const textarea = container.querySelector(
      '[data-testid="dsl-panel-textarea"]',
    ) as HTMLTextAreaElement;

    await act(async () => {
      typeIntoTextarea(textarea, "this is not valid JSON yet, still typing");
    });
    expect(textarea.value).toBe("this is not valid JSON yet, still typing");

    // An external document change lands (e.g. a gizmo drag committed
    // elsewhere) while the user still has this unapplied text pending.
    const secondDocument: SceneDocument = {
      ...firstDocument,
      project: { ...firstDocument.project, name: "Renamed While Editing" },
    };
    await act(async () => {
      root.render(<DslPanel document={secondDocument} commitDslEdit={vi.fn()} />);
    });

    expect(textarea.value).toBe("this is not valid JSON yet, still typing");
  });

  describe("apply", () => {
    it("commits the parsed JSON via commitDslEdit on the Apply button, clearing dirty state on success", async () => {
      const document = buildDocument();
      const commitDslEdit = vi.fn((_candidate: unknown) => undefined);
      await act(async () => {
        root.render(<DslPanel document={document} commitDslEdit={commitDslEdit} />);
      });

      const textarea = container.querySelector(
        '[data-testid="dsl-panel-textarea"]',
      ) as HTMLTextAreaElement;
      const edited: SceneDocument = {
        ...document,
        project: { ...document.project, name: "Edited via DSL" },
      };
      await act(async () => {
        typeIntoTextarea(textarea, JSON.stringify(edited, null, 2));
      });

      const applyButton = container.querySelector(
        '[data-testid="dsl-panel-apply"]',
      ) as HTMLButtonElement;
      await act(async () => {
        applyButton.click();
      });

      expect(commitDslEdit).toHaveBeenCalledTimes(1);
      expect(commitDslEdit).toHaveBeenCalledWith(edited);
      expect(container.querySelector('[data-testid="dsl-panel-dirty-indicator"]')).toBeNull();
    });

    it("applies on blur, not only via the explicit Apply button", async () => {
      const document = buildDocument();
      const commitDslEdit = vi.fn((_candidate: unknown) => undefined);
      await act(async () => {
        root.render(<DslPanel document={document} commitDslEdit={commitDslEdit} />);
      });

      const textarea = container.querySelector(
        '[data-testid="dsl-panel-textarea"]',
      ) as HTMLTextAreaElement;
      const edited: SceneDocument = {
        ...document,
        project: { ...document.project, name: "Edited via blur" },
      };
      await act(async () => {
        textarea.focus();
        typeIntoTextarea(textarea, JSON.stringify(edited, null, 2));
        textarea.blur();
      });

      expect(commitDslEdit).toHaveBeenCalledWith(edited);
    });

    it("shows an inline parse error and does not call commitDslEdit when the text is not valid JSON", async () => {
      const document = buildDocument();
      const commitDslEdit = vi.fn((_candidate: unknown) => undefined);
      await act(async () => {
        root.render(<DslPanel document={document} commitDslEdit={commitDslEdit} />);
      });

      const textarea = container.querySelector(
        '[data-testid="dsl-panel-textarea"]',
      ) as HTMLTextAreaElement;
      await act(async () => {
        typeIntoTextarea(textarea, "{ this is not json");
      });

      const applyButton = container.querySelector(
        '[data-testid="dsl-panel-apply"]',
      ) as HTMLButtonElement;
      await act(async () => {
        applyButton.click();
      });

      expect(commitDslEdit).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="dsl-panel-parse-error"]')).not.toBeNull();
    });

    it("shows inline validation diagnostics and does not clear dirty state when commitDslEdit rejects the edit", async () => {
      const document = buildDocument();
      const diagnostics: SceneParseDiagnostic[] = [
        {
          path: "project.compositions[0].fps",
          message: "Expected number, got string",
          code: "INVALID_TYPE",
        },
      ];
      const commitDslEdit = vi.fn((_candidate: unknown) => diagnostics);
      await act(async () => {
        root.render(<DslPanel document={document} commitDslEdit={commitDslEdit} />);
      });

      const textarea = container.querySelector(
        '[data-testid="dsl-panel-textarea"]',
      ) as HTMLTextAreaElement;
      await act(async () => {
        typeIntoTextarea(
          textarea,
          JSON.stringify({ ...document, schemaVersion: "invalid" }, null, 2),
        );
      });

      const applyButton = container.querySelector(
        '[data-testid="dsl-panel-apply"]',
      ) as HTMLButtonElement;
      await act(async () => {
        applyButton.click();
      });

      expect(commitDslEdit).toHaveBeenCalledTimes(1);
      const diagnosticsList = container.querySelector(
        '[data-testid="dsl-panel-validation-errors"]',
      );
      expect(diagnosticsList).not.toBeNull();
      expect(diagnosticsList?.textContent).toContain("Expected number, got string");
      // Still dirty: the edit was rejected, not applied.
      expect(container.querySelector('[data-testid="dsl-panel-dirty-indicator"]')).not.toBeNull();
    });
  });

  describe("revert", () => {
    it("restores the textarea to the last-known-valid document's serialized form and clears diagnostics", async () => {
      const document = buildDocument();
      const commitDslEdit = vi.fn((_candidate: unknown) => undefined);
      await act(async () => {
        root.render(<DslPanel document={document} commitDslEdit={commitDslEdit} />);
      });

      const textarea = container.querySelector(
        '[data-testid="dsl-panel-textarea"]',
      ) as HTMLTextAreaElement;
      await act(async () => {
        typeIntoTextarea(textarea, "{ not valid json");
      });

      const applyButton = container.querySelector(
        '[data-testid="dsl-panel-apply"]',
      ) as HTMLButtonElement;
      await act(async () => {
        applyButton.click();
      });
      expect(container.querySelector('[data-testid="dsl-panel-parse-error"]')).not.toBeNull();

      const revertButton = container.querySelector(
        '[data-testid="dsl-panel-revert"]',
      ) as HTMLButtonElement;
      await act(async () => {
        revertButton.click();
      });

      expect(textarea.value).toBe(JSON.stringify(document, null, 2));
      expect(container.querySelector('[data-testid="dsl-panel-parse-error"]')).toBeNull();
      expect(container.querySelector('[data-testid="dsl-panel-dirty-indicator"]')).toBeNull();
    });
  });

  describe("bounded click-to-select", () => {
    it("selects the node whose id nearest-precedes the click's cursor position", async () => {
      const document = buildDocument();
      const onSelectNode = vi.fn();
      await act(async () => {
        root.render(
          <DslPanel document={document} commitDslEdit={vi.fn()} onSelectNode={onSelectNode} />,
        );
      });

      const textarea = container.querySelector(
        '[data-testid="dsl-panel-textarea"]',
      ) as HTMLTextAreaElement;
      const text = textarea.value;
      const nodeIdIndex = text.indexOf(`"id": "${NODE_ID}"`);
      expect(nodeIdIndex).toBeGreaterThan(-1);
      // A click just after this node's own "id" occurrence (still before
      // any nested child's own "id"), simulated by placing the cursor
      // (selectionStart/selectionEnd) there before dispatching the click.
      const cursorPosition = nodeIdIndex + `"id": "${NODE_ID}"`.length + 5;
      textarea.setSelectionRange(cursorPosition, cursorPosition);

      await act(async () => {
        textarea.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(onSelectNode).toHaveBeenCalledWith(NODE_ID);
    });

    it('does not call onSelectNode when the click is before any "id" occurrence', async () => {
      const document = buildDocument();
      const onSelectNode = vi.fn();
      await act(async () => {
        root.render(
          <DslPanel document={document} commitDslEdit={vi.fn()} onSelectNode={onSelectNode} />,
        );
      });

      const textarea = container.querySelector(
        '[data-testid="dsl-panel-textarea"]',
      ) as HTMLTextAreaElement;
      textarea.setSelectionRange(0, 0);

      await act(async () => {
        textarea.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(onSelectNode).not.toHaveBeenCalled();
    });

    it("does not call onSelectNode when the nearest preceding id does not match any real node in the document", async () => {
      const document = buildDocument();
      const onSelectNode = vi.fn();
      await act(async () => {
        root.render(
          <DslPanel document={document} commitDslEdit={vi.fn()} onSelectNode={onSelectNode} />,
        );
      });

      const textarea = container.querySelector(
        '[data-testid="dsl-panel-textarea"]',
      ) as HTMLTextAreaElement;
      // project.id ("project-1") is a real "id" occurrence in the text, but
      // is not a SceneNode id findSelectedClip's own tree walk would ever
      // match.
      const text = textarea.value;
      const projectIdIndex = text.indexOf(`"id": "project-1"`);
      expect(projectIdIndex).toBeGreaterThan(-1);
      const cursorPosition = projectIdIndex + `"id": "project-1"`.length + 2;
      textarea.setSelectionRange(cursorPosition, cursorPosition);

      await act(async () => {
        textarea.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(onSelectNode).not.toHaveBeenCalled();
    });
  });

  describe("selection-driven highlight", () => {
    it('selects the matching "id" occurrence\'s text range when selectedNodeId changes and the panel is not dirty', async () => {
      const document = buildDocument();
      await act(async () => {
        root.render(
          <DslPanel document={document} commitDslEdit={vi.fn()} selectedNodeId={undefined} />,
        );
      });

      await act(async () => {
        root.render(
          <DslPanel document={document} commitDslEdit={vi.fn()} selectedNodeId={OTHER_NODE_ID} />,
        );
      });

      const textarea = container.querySelector(
        '[data-testid="dsl-panel-textarea"]',
      ) as HTMLTextAreaElement;
      const needle = `"id": "${OTHER_NODE_ID}"`;
      const expectedIndex = textarea.value.indexOf(needle);
      expect(expectedIndex).toBeGreaterThan(-1);
      expect(textarea.selectionStart).toBe(expectedIndex);
      expect(textarea.selectionEnd).toBe(expectedIndex + needle.length);
    });

    it("does not move the cursor for a selection change while the textarea is dirty", async () => {
      const document = buildDocument();
      await act(async () => {
        root.render(
          <DslPanel document={document} commitDslEdit={vi.fn()} selectedNodeId={undefined} />,
        );
      });

      const textarea = container.querySelector(
        '[data-testid="dsl-panel-textarea"]',
      ) as HTMLTextAreaElement;
      await act(async () => {
        typeIntoTextarea(textarea, "still editing, unrelated pending text");
      });
      textarea.setSelectionRange(5, 5);

      await act(async () => {
        root.render(
          <DslPanel document={document} commitDslEdit={vi.fn()} selectedNodeId={OTHER_NODE_ID} />,
        );
      });

      // The textarea's own text is untouched (already covered by the
      // dedicated no-clobber test above); this asserts the cursor itself
      // was also left alone, not moved to highlight a match that (since the
      // displayed text is still the user's own pending edit, not the
      // document's real serialized form) may not even exist in it.
      expect(textarea.selectionStart).toBe(5);
      expect(textarea.selectionEnd).toBe(5);
    });
  });
});
