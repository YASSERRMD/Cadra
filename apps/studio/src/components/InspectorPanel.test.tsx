import { createIdentityTransform, resolveColorProperty, resolveNumberProperty } from "@cadra/core";
import type { PreviewHandle } from "@cadra/player";
import type { SceneDocument, SceneParseDiagnostic } from "@cadra/schema";
import { CURRENT_SCHEMA_VERSION, parseScene } from "@cadra/schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDocumentStore } from "../store/document-store.js";
import { InspectorPanel } from "./InspectorPanel.js";

const COMPOSITION_ID = "comp-1";
const TRACK_ID = "track-1";
const CLIP_ID = "clip-1";
const LIGHT_NODE_ID = "light-node-1";

/** A document with one composition/track/clip, whose root node is a `light`: covers all four `PropertyValueKind`s (transform.position: vector3, visible: boolean, color: color, intensity: number) from a single node kind. */
function buildDocumentWithLightNode(): SceneDocument {
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
                    id: LIGHT_NODE_ID,
                    kind: "light",
                    transform: createIdentityTransform(),
                    visible: true,
                    lightType: "point",
                    color: [1, 0, 0, 1],
                    intensity: 2,
                    children: [],
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

/** Same fake `PreviewHandle` shape used by `TimelinePanel.test.tsx`: records `seek` calls, supports `onFrameChanged` subscription/emission driven directly by `emitFrameChanged`. */
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

/** Sets a text/number `<input>`'s value the way React's own change detection actually observes (via the native value setter, so React's controlled-input tracking is not bypassed), then dispatches a real `input` event. */
function typeIntoInput(input: HTMLInputElement, value: string): void {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  nativeInputValueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("InspectorPanel", () => {
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

  it("shows a fallback message when selectedNodeId is undefined", async () => {
    await act(async () => {
      root.render(
        <InspectorPanel
          document={buildDocumentWithLightNode()}
          selectedNodeId={undefined}
          previewHandle={undefined}
          commitPropertyEdit={vi.fn(() => undefined)}
        />,
      );
    });

    expect(container.querySelector('[data-testid="studio-inspector-panel"]')).not.toBeNull();
    expect(container.textContent).toContain("No node selected");
  });

  it("shows a fallback message when selectedNodeId does not match any node in the document", async () => {
    await act(async () => {
      root.render(
        <InspectorPanel
          document={buildDocumentWithLightNode()}
          selectedNodeId="does-not-exist"
          previewHandle={undefined}
          commitPropertyEdit={vi.fn(() => undefined)}
        />,
      );
    });

    expect(container.textContent).toContain("No node selected");
  });

  it("renders one PropertyEditor per animatable property the selected node's kind has (light: transform.position/rotation/scale, color, intensity, matching LIGHT_ANIMATABLE_PROPERTIES exactly)", async () => {
    await act(async () => {
      root.render(
        <InspectorPanel
          document={buildDocumentWithLightNode()}
          selectedNodeId={LIGHT_NODE_ID}
          previewHandle={undefined}
          commitPropertyEdit={vi.fn(() => undefined)}
        />,
      );
    });

    // LIGHT_ANIMATABLE_PROPERTIES (Phase 7's own descriptor list for
    // "light") is exactly transform.position/rotation/scale plus color and
    // intensity: unlike SHAPE/TEXT/IMAGE/VIDEO, it deliberately does not
    // list "visible" (see that module's own doc in @cadra/core), even
    // though LightNode.visible exists and is resolved by the renderer like
    // every other kind's. This inspector renders driven by that list
    // exactly (task 1), not by an independent inference from the node
    // shape, so "visible" correctly has no editor here.
    for (const path of ["transform.position", "transform.rotation", "transform.scale", "color", "intensity"]) {
      expect(
        container.querySelector(`[data-testid="inspector-property-${path}"]`),
        `expected an editor for path "${path}"`,
      ).not.toBeNull();
    }
    expect(container.querySelector('[data-testid="inspector-property-visible"]')).toBeNull();
    // camera-only/text-only properties must not appear on a light node.
    expect(container.querySelector('[data-testid="inspector-property-fov"]')).toBeNull();
    expect(container.querySelector('[data-testid="inspector-property-fontSize"]')).toBeNull();
  });

  it("resolves a constant property's display value at the shared PreviewHandle's current frame", async () => {
    const previewHandle = createFakePreviewHandle(0);
    await act(async () => {
      root.render(
        <InspectorPanel
          document={buildDocumentWithLightNode()}
          selectedNodeId={LIGHT_NODE_ID}
          previewHandle={previewHandle}
          commitPropertyEdit={vi.fn(() => undefined)}
        />,
      );
    });

    const intensityInput = container.querySelector(
      '[data-testid="inspector-property-intensity-value"]',
    ) as HTMLInputElement;
    expect(intensityInput.value).toBe("2"); // the constant intensity: 2
  });

  describe("editing a constant value (commit-on-blur, not per-keystroke)", () => {
    it("does not call commitPropertyEdit while typing (only on blur)", async () => {
      const commitPropertyEdit = vi.fn((_candidate: unknown) => undefined);
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithLightNode()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={undefined}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const intensityInput = container.querySelector(
        '[data-testid="inspector-property-intensity-value"]',
      ) as HTMLInputElement;

      await act(async () => {
        typeIntoInput(intensityInput, "5");
      });

      // Design note: a plain numeric input commits on blur/Enter, never on
      // every keystroke, specifically to avoid re-triggering Viewport's
      // full remount-per-document-change on every intermediate value.
      expect(commitPropertyEdit).not.toHaveBeenCalled();
    });

    it("commits the parsed value on blur, splicing it into the candidate document at the right node/path", async () => {
      const commitPropertyEdit = vi.fn((_candidate: unknown) => undefined);
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithLightNode()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={undefined}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const intensityInput = container.querySelector(
        '[data-testid="inspector-property-intensity-value"]',
      ) as HTMLInputElement;

      await act(async () => {
        typeIntoInput(intensityInput, "7.5");
      });
      await act(async () => {
        intensityInput.focus();
        intensityInput.blur();
      });

      expect(commitPropertyEdit).toHaveBeenCalledTimes(1);
      const candidate = commitPropertyEdit.mock.calls[0]?.[0] as SceneDocument;
      const committedNode = candidate.project.compositions[0]?.tracks[0]?.clips[0]?.node;
      expect(committedNode?.kind).toBe("light");
      expect(committedNode?.kind === "light" ? committedNode.intensity : undefined).toBe(7.5);
    });

    it("commits on Enter (which blurs the input)", async () => {
      const commitPropertyEdit = vi.fn((_candidate: unknown) => undefined);
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithLightNode()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={undefined}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const intensityInput = container.querySelector(
        '[data-testid="inspector-property-intensity-value"]',
      ) as HTMLInputElement;

      await act(async () => {
        // A real Enter keypress only ever happens while the input actually
        // has focus (the user is typing into it), which is exactly what
        // makes NumberInput's own `event.currentTarget.blur()` call
        // meaningful: jsdom's `.blur()` (matching real browser behavior) is
        // a no-op unless the target is the current `document.activeElement`,
        // so this test focuses the input first to mirror that real
        // precondition, rather than dispatching a synthetic keydown against
        // an element nothing ever focused.
        intensityInput.focus();
        typeIntoInput(intensityInput, "9");
        intensityInput.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      });

      expect(commitPropertyEdit).toHaveBeenCalledTimes(1);
    });

    it("reverts to the last-known value on blur if the typed text is not a valid number", async () => {
      const commitPropertyEdit = vi.fn((_candidate: unknown) => undefined);
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithLightNode()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={undefined}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const intensityInput = container.querySelector(
        '[data-testid="inspector-property-intensity-value"]',
      ) as HTMLInputElement;

      await act(async () => {
        typeIntoInput(intensityInput, "not-a-number");
      });
      await act(async () => {
        intensityInput.focus();
        intensityInput.blur();
      });

      expect(commitPropertyEdit).not.toHaveBeenCalled();
      expect(intensityInput.value).toBe("2");
    });
  });

  describe("converting a constant to a keyframe track", () => {
    it("seeds exactly one keyframe at the current playhead frame, holding the existing constant value", async () => {
      const commitPropertyEdit = vi.fn((_candidate: unknown) => undefined);
      const previewHandle = createFakePreviewHandle(42);
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithLightNode()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={previewHandle}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const convertButton = container.querySelector(
        '[data-testid="inspector-property-intensity-convert-to-keyframes"]',
      ) as HTMLButtonElement;

      await act(async () => {
        convertButton.click();
      });

      expect(commitPropertyEdit).toHaveBeenCalledTimes(1);
      const candidate = commitPropertyEdit.mock.calls[0]?.[0] as SceneDocument;
      const committedNode = candidate.project.compositions[0]?.tracks[0]?.clips[0]?.node;
      const intensity = committedNode?.kind === "light" ? committedNode.intensity : undefined;
      expect(intensity).toEqual({
        type: "keyframeTrack",
        keyframes: [{ frame: 42, value: 2 }],
      });
    });

    it("no longer shows the convert button or constant input once the property is a track; shows the keyframe list instead", async () => {
      const store = createDocumentStore();
      act(() => {
        store.getState().commitDocument(buildDocumentWithLightNode());
      });
      const previewHandle = createFakePreviewHandle(0);

      function commitPropertyEdit(candidate: unknown): SceneParseDiagnostic[] | undefined {
        const committed = store.getState().commitDocument(candidate);
        return committed ? undefined : store.getState().lastValidationError;
      }

      await act(async () => {
        root.render(
          <InspectorPanel
            document={store.getState().document}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={previewHandle}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const convertButton = container.querySelector(
        '[data-testid="inspector-property-intensity-convert-to-keyframes"]',
      ) as HTMLButtonElement;
      await act(async () => {
        convertButton.click();
      });

      // Re-render with the freshly committed document (mirroring how App.tsx
      // would re-render InspectorPanel with the store's new `document`).
      await act(async () => {
        root.render(
          <InspectorPanel
            document={store.getState().document}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={previewHandle}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      expect(
        container.querySelector('[data-testid="inspector-property-intensity-convert-to-keyframes"]'),
      ).toBeNull();
      expect(container.querySelector('[data-testid="inspector-property-intensity-constant"]')).toBeNull();
      expect(
        container.querySelector('[data-testid="inspector-property-intensity-keyframe-list"]'),
      ).not.toBeNull();
    });
  });

  describe("keyframe editor (add, move, delete, easing)", () => {
    /** A document whose light node's `intensity` is already a two-keyframe track: 2 at frame 0, 10 at frame 50. */
    function buildDocumentWithKeyframedIntensity(): SceneDocument {
      const document = buildDocumentWithLightNode();
      const node = document.project.compositions[0]?.tracks[0]?.clips[0]?.node;
      if (node?.kind !== "light") {
        throw new Error("test setup: expected a light node");
      }
      node.intensity = {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: 2 },
          { frame: 50, value: 10 },
        ],
      };
      return document;
    }

    it("lists every existing keyframe (frame, value, easing)", async () => {
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithKeyframedIntensity()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={undefined}
            commitPropertyEdit={vi.fn(() => undefined)}
          />,
        );
      });

      expect(
        container.querySelector('[data-testid="inspector-property-intensity-keyframe-0"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="inspector-property-intensity-keyframe-1"]'),
      ).not.toBeNull();
      const frame0Input = container.querySelector(
        '[data-testid="inspector-property-intensity-keyframe-0-frame"]',
      ) as HTMLInputElement;
      const frame1Input = container.querySelector(
        '[data-testid="inspector-property-intensity-keyframe-1-frame"]',
      ) as HTMLInputElement;
      expect(frame0Input.value).toBe("0");
      expect(frame1Input.value).toBe("50");
    });

    it("adds a new keyframe at the current playhead frame", async () => {
      const commitPropertyEdit = vi.fn((_candidate: unknown) => undefined);
      const previewHandle = createFakePreviewHandle(25);
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithKeyframedIntensity()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={previewHandle}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const addButton = container.querySelector(
        '[data-testid="inspector-property-intensity-add-keyframe"]',
      ) as HTMLButtonElement;
      await act(async () => {
        addButton.click();
      });

      expect(commitPropertyEdit).toHaveBeenCalledTimes(1);
      const candidate = commitPropertyEdit.mock.calls[0]?.[0] as SceneDocument;
      const node = candidate.project.compositions[0]?.tracks[0]?.clips[0]?.node;
      const intensity = node?.kind === "light" ? node.intensity : undefined;
      expect(intensity).toMatchObject({
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: 2 },
          { frame: 25 },
          { frame: 50, value: 10 },
        ],
      });
    });

    it("does not add a second keyframe at a frame that already has one", async () => {
      const commitPropertyEdit = vi.fn((_candidate: unknown) => undefined);
      const previewHandle = createFakePreviewHandle(0); // frame 0 already has a keyframe
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithKeyframedIntensity()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={previewHandle}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const addButton = container.querySelector(
        '[data-testid="inspector-property-intensity-add-keyframe"]',
      ) as HTMLButtonElement;
      await act(async () => {
        addButton.click();
      });

      expect(commitPropertyEdit).not.toHaveBeenCalled();
    });

    it("deletes a keyframe", async () => {
      const commitPropertyEdit = vi.fn((_candidate: unknown) => undefined);
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithKeyframedIntensity()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={undefined}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const deleteButton = container.querySelector(
        '[data-testid="inspector-property-intensity-keyframe-1-delete"]',
      ) as HTMLButtonElement;
      await act(async () => {
        deleteButton.click();
      });

      expect(commitPropertyEdit).toHaveBeenCalledTimes(1);
      const candidate = commitPropertyEdit.mock.calls[0]?.[0] as SceneDocument;
      const node = candidate.project.compositions[0]?.tracks[0]?.clips[0]?.node;
      const intensity = node?.kind === "light" ? node.intensity : undefined;
      expect(intensity).toEqual({
        type: "keyframeTrack",
        keyframes: [{ frame: 0, value: 2 }],
      });
    });

    it("retypes an existing keyframe's frame (on blur)", async () => {
      const commitPropertyEdit = vi.fn((_candidate: unknown) => undefined);
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithKeyframedIntensity()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={undefined}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const frameInput = container.querySelector(
        '[data-testid="inspector-property-intensity-keyframe-1-frame"]',
      ) as HTMLInputElement;

      await act(async () => {
        typeIntoInput(frameInput, "75");
      });
      await act(async () => {
        frameInput.focus();
        frameInput.blur();
      });

      expect(commitPropertyEdit).toHaveBeenCalledTimes(1);
      const candidate = commitPropertyEdit.mock.calls[0]?.[0] as SceneDocument;
      const node = candidate.project.compositions[0]?.tracks[0]?.clips[0]?.node;
      const intensity = node?.kind === "light" ? node.intensity : undefined;
      expect(intensity).toEqual({
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: 2 },
          { frame: 75, value: 10 },
        ],
      });
    });

    it("retypes an existing keyframe's value (on blur)", async () => {
      const commitPropertyEdit = vi.fn((_candidate: unknown) => undefined);
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithKeyframedIntensity()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={undefined}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const valueInput = container.querySelector(
        '[data-testid="inspector-property-intensity-keyframe-1-value"]',
      ) as HTMLInputElement;

      await act(async () => {
        typeIntoInput(valueInput, "99");
      });
      await act(async () => {
        valueInput.focus();
        valueInput.blur();
      });

      expect(commitPropertyEdit).toHaveBeenCalledTimes(1);
      const candidate = commitPropertyEdit.mock.calls[0]?.[0] as SceneDocument;
      const node = candidate.project.compositions[0]?.tracks[0]?.clips[0]?.node;
      const intensity = node?.kind === "light" ? node.intensity : undefined;
      expect(intensity).toEqual({
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: 2 },
          { frame: 50, value: 99 },
        ],
      });
    });

    it("changes a keyframe's easing", async () => {
      const commitPropertyEdit = vi.fn((_candidate: unknown) => undefined);
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithKeyframedIntensity()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={undefined}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const easingSelect = container.querySelector(
        '[data-testid="inspector-property-intensity-keyframe-0-easing"]',
      ) as HTMLSelectElement;

      await act(async () => {
        easingSelect.value = "easeInOutCubic";
        easingSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });

      expect(commitPropertyEdit).toHaveBeenCalledTimes(1);
      const candidate = commitPropertyEdit.mock.calls[0]?.[0] as SceneDocument;
      const node = candidate.project.compositions[0]?.tracks[0]?.clips[0]?.node;
      const intensity = node?.kind === "light" ? node.intensity : undefined;
      expect(intensity).toEqual({
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: 2, easing: "easeInOutCubic" },
          { frame: 50, value: 10 },
        ],
      });
    });

    it("the easing picker offers every Easing value", async () => {
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithKeyframedIntensity()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={undefined}
            commitPropertyEdit={vi.fn(() => undefined)}
          />,
        );
      });

      const easingSelect = container.querySelector(
        '[data-testid="inspector-property-intensity-keyframe-0-easing"]',
      ) as HTMLSelectElement;
      const optionValues = Array.from(easingSelect.options).map((option) => option.value);

      expect(optionValues).toEqual([
        "linear",
        "easeInCubic",
        "easeOutCubic",
        "easeInOutCubic",
        "easeInExpo",
        "easeOutExpo",
        "easeInOutExpo",
        "easeInBack",
        "easeOutBack",
        "easeInOutBack",
        "easeInElastic",
        "easeOutElastic",
        "easeInOutElastic",
        "hold",
      ]);
    });

    it("clicking a keyframe's seek control calls previewHandle.seek with that keyframe's frame", async () => {
      const previewHandle = createFakePreviewHandle(0);
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithKeyframedIntensity()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={previewHandle}
            commitPropertyEdit={vi.fn(() => undefined)}
          />,
        );
      });

      const seekButton = container.querySelector(
        '[data-testid="inspector-property-intensity-keyframe-1-seek"]',
      ) as HTMLButtonElement;
      await act(async () => {
        seekButton.click();
      });

      expect(previewHandle.seek).toHaveBeenCalledWith(50);
    });
  });

  describe("inline validation diagnostics", () => {
    it("shows the rejected edit's diagnostics next to the specific field, not just a generic toolbar-level display", async () => {
      const diagnostics: SceneParseDiagnostic[] = [
        {
          path: "project.compositions[0].tracks[0].clips[0].node.intensity",
          message: "Expected a number, received a string.",
          code: "WRONG_TYPE",
        },
      ];
      const commitPropertyEdit = vi.fn(() => diagnostics);
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithLightNode()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={undefined}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const intensityInput = container.querySelector(
        '[data-testid="inspector-property-intensity-value"]',
      ) as HTMLInputElement;
      await act(async () => {
        typeIntoInput(intensityInput, "42");
      });
      await act(async () => {
        intensityInput.focus();
        intensityInput.blur();
      });

      const diagnosticsSlot = container.querySelector(
        '[data-testid="inspector-property-intensity-diagnostics"]',
      );
      expect(diagnosticsSlot).not.toBeNull();
      expect(diagnosticsSlot?.textContent).toContain("Expected a number, received a string.");

      // A different, unrelated field must not show this diagnostic.
      expect(
        container.querySelector('[data-testid="inspector-property-color-diagnostics"]'),
      ).toBeNull();
    });

    it("clears a field's diagnostics once a subsequent edit to that same field succeeds", async () => {
      let shouldReject = true;
      const commitPropertyEdit = vi.fn((): SceneParseDiagnostic[] | undefined =>
        shouldReject
          ? [{ path: "intensity", message: "rejected", code: "WRONG_TYPE" }]
          : undefined,
      );
      await act(async () => {
        root.render(
          <InspectorPanel
            document={buildDocumentWithLightNode()}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={undefined}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const intensityInput = container.querySelector(
        '[data-testid="inspector-property-intensity-value"]',
      ) as HTMLInputElement;
      await act(async () => {
        typeIntoInput(intensityInput, "42");
        intensityInput.focus();
        intensityInput.blur();
      });
      expect(
        container.querySelector('[data-testid="inspector-property-intensity-diagnostics"]'),
      ).not.toBeNull();

      shouldReject = false;
      await act(async () => {
        typeIntoInput(intensityInput, "43");
        intensityInput.focus();
        intensityInput.blur();
      });

      expect(
        container.querySelector('[data-testid="inspector-property-intensity-diagnostics"]'),
      ).toBeNull();
    });
  });

  describe("task 6: adding a keyframe animates the property and updates the committed document", () => {
    it("converting a constant to a keyframe track, then adding a second keyframe, changes the resolved value at two different frames and is reflected in the store's committed document", () => {
      const store = createDocumentStore();
      act(() => {
        store.getState().commitDocument(buildDocumentWithLightNode());
      });

      function findLightNode(document: SceneDocument) {
        const node = document.project.compositions[0]?.tracks[0]?.clips[0]?.node;
        if (node?.kind !== "light") {
          throw new Error("expected a light node");
        }
        return node;
      }

      // Before any keyframing: intensity is the constant 2 at every frame.
      const before = findLightNode(store.getState().document);
      expect(resolveNumberProperty(before.intensity, 0)).toBe(2);
      expect(resolveNumberProperty(before.intensity, 50)).toBe(2);

      // Convert to a keyframe track seeded at frame 0 with the existing
      // constant (2), then commit a second keyframe at frame 50 with a
      // different value (20): this is exactly what PropertyEditor's own
      // "Convert to keyframes" button followed by KeyframeListEditor's own
      // "Add keyframe" button produce, exercised here directly against the
      // real store (not a fake commitPropertyEdit) to prove the full
      // two-way-bound path, per this phase's task 6.
      act(() => {
        const seeded = {
          ...before,
          intensity: { type: "keyframeTrack" as const, keyframes: [{ frame: 0, value: 2 }] },
        };
        const composition = store.getState().document.project.compositions[0];
        if (composition === undefined) {
          throw new Error("expected a composition");
        }
        const nextComposition = {
          ...composition,
          tracks: composition.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((clip) => ({ ...clip, node: seeded })),
          })),
        };
        const candidate = {
          ...store.getState().document,
          project: {
            ...store.getState().document.project,
            compositions: store.getState().document.project.compositions.map((composition) =>
              composition.id === nextComposition.id ? nextComposition : composition,
            ),
          },
        };
        const committed = store.getState().commitDocument(candidate);
        expect(committed).toBe(true);
      });

      act(() => {
        const current = findLightNode(store.getState().document);
        const track = current.intensity;
        if (typeof track !== "object" || !("keyframes" in track)) {
          throw new Error("expected intensity to already be a keyframe track");
        }
        const nextNode = {
          ...current,
          intensity: {
            type: "keyframeTrack" as const,
            keyframes: [...track.keyframes, { frame: 50, value: 20 }],
          },
        };
        const composition = store.getState().document.project.compositions[0];
        if (composition === undefined) {
          throw new Error("expected a composition");
        }
        const nextComposition = {
          ...composition,
          tracks: composition.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((clip) => ({ ...clip, node: nextNode })),
          })),
        };
        const candidate = {
          ...store.getState().document,
          project: {
            ...store.getState().document.project,
            compositions: store.getState().document.project.compositions.map((composition) =>
              composition.id === nextComposition.id ? nextComposition : composition,
            ),
          },
        };
        const committed = store.getState().commitDocument(candidate);
        expect(committed).toBe(true);
      });

      // The store's committed document now resolves to different intensity
      // values at frame 0 versus frame 50: the property genuinely animates.
      const after = findLightNode(store.getState().document);
      const resolvedAtFrame0 = resolveNumberProperty(after.intensity, 0);
      const resolvedAtFrame50 = resolveNumberProperty(after.intensity, 50);
      expect(resolvedAtFrame0).toBe(2);
      expect(resolvedAtFrame50).toBe(20);
      expect(resolvedAtFrame0).not.toBe(resolvedAtFrame50);
      // And parseScene still accepts the committed document: the animated
      // property is a genuinely valid part of the store's document, not a
      // side channel that bypasses validation.
      expect(parseScene(store.getState().document).success).toBe(true);
    });

    it("InspectorPanel's own UI (convert-to-keyframes then add-keyframe) drives the identical store commit, verified end to end through resolveColorProperty for a non-number value kind too", async () => {
      const store = createDocumentStore();
      act(() => {
        store.getState().commitDocument(buildDocumentWithLightNode());
      });
      const previewHandleAtZero = createFakePreviewHandle(0);

      function commitPropertyEdit(candidate: unknown): SceneParseDiagnostic[] | undefined {
        const committed = store.getState().commitDocument(candidate);
        return committed ? undefined : store.getState().lastValidationError;
      }

      await act(async () => {
        root.render(
          <InspectorPanel
            document={store.getState().document}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={previewHandleAtZero}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      // Convert `color` (a ColorRGBA property) to a keyframe track at frame 0.
      const convertButton = container.querySelector(
        '[data-testid="inspector-property-color-convert-to-keyframes"]',
      ) as HTMLButtonElement;
      await act(async () => {
        convertButton.click();
      });

      // Re-render with the store's freshly committed document, then seek to
      // frame 50 and add a second keyframe with a different color there.
      const previewHandleAtFifty = createFakePreviewHandle(50);
      await act(async () => {
        root.render(
          <InspectorPanel
            document={store.getState().document}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={previewHandleAtFifty}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const addKeyframeButton = container.querySelector(
        '[data-testid="inspector-property-color-add-keyframe"]',
      ) as HTMLButtonElement;
      await act(async () => {
        addKeyframeButton.click();
      });

      // As with the convert-to-keyframes step above: InspectorPanel is a
      // plain prop-driven component (matching TimelinePanel's own posture),
      // not itself subscribed to the store, so seeing the freshly committed
      // second keyframe requires re-rendering with the store's latest
      // `document`, exactly mirroring how App.tsx's real zustand
      // subscription would re-render it in production.
      await act(async () => {
        root.render(
          <InspectorPanel
            document={store.getState().document}
            selectedNodeId={LIGHT_NODE_ID}
            previewHandle={previewHandleAtFifty}
            commitPropertyEdit={commitPropertyEdit}
          />,
        );
      });

      const colorValueInput = container.querySelector(
        '[data-testid="inspector-property-color-keyframe-1-value"]',
      ) as HTMLInputElement;
      await act(async () => {
        // Same native-value-setter approach typeIntoInput uses for a plain
        // text input: React tracks a controlled <input type="color">'s own
        // changes via the native "input" event too (not "change"), so a
        // raw `.value =` assignment plus a bare "change" dispatch never
        // reaches ColorInput's onChange at all.
        typeIntoInput(colorValueInput, "#00ff00");
      });

      const finalNode = store.getState().document.project.compositions[0]?.tracks[0]?.clips[0]?.node;
      const color = finalNode?.kind === "light" ? finalNode.color : undefined;
      expect(color).toBeDefined();
      if (color === undefined) {
        throw new Error("expected color to be defined");
      }
      const resolvedAtZero = resolveColorProperty(color, 0);
      const resolvedAtFifty = resolveColorProperty(color, 50);
      expect(resolvedAtZero).not.toEqual(resolvedAtFifty);
      expect(parseScene(store.getState().document).success).toBe(true);
    });
  });
});
