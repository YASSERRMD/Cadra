import { describe, expect, it } from "vitest";

import { createComposition } from "../primitives/composition.js";
import { Sequence } from "../primitives/sequence.js";
import { Series } from "../primitives/series.js";
import { Shape } from "../primitives/shape.js";
import { createIdentityTransform } from "../scene-graph/primitives.js";
import { createProject } from "../scene-graph/project-factory.js";
import type { CompositionRefNode, SceneNode } from "../scene-graph/scene-node.js";
import type { Composition, Project } from "../scene-graph/timeline.js";
import { CompositionCycleError, CompositionNotFoundError } from "./errors.js";
import { resolveSceneAtFrame } from "./resolve-scene.js";

/** Builds a `compositionRef` node pointing at `compositionId`. */
function CompositionRef(id: string, compositionId: string): CompositionRefNode {
  return {
    id,
    kind: "compositionRef",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    compositionId,
  };
}

describe("resolveSceneAtFrame: single track, single clip", () => {
  const shape = Shape({ id: "shape-1" });
  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: 30,
    durationInFrames: 60,
    width: 1920,
    height: 1080,
    tracks: [
      {
        id: "track-1",
        clips: [Sequence({ id: "clip-1", from: 10, durationInFrames: 20, content: shape })],
      },
    ],
  });
  const project = createProject({ id: "p1", name: "Project", compositions: [composition] });

  it("resolves zero layers one frame before the clip starts", () => {
    const state = resolveSceneAtFrame(project, "comp-1", 9);
    expect(state.layers).toEqual([]);
  });

  it("resolves at frame 0 (before the clip window) with zero layers", () => {
    const state = resolveSceneAtFrame(project, "comp-1", 0);
    expect(state.layers).toEqual([]);
  });

  it("resolves the clip content at its first visible frame, with localFrame 0", () => {
    const state = resolveSceneAtFrame(project, "comp-1", 10);
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0]).toEqual({
      compositionId: "comp-1",
      trackId: "track-1",
      clipId: "clip-1",
      node: shape,
      zIndex: 0,
      localFrame: 0,
      opacity: 1,
    });
  });

  it("resolves at a middle frame with the correct localFrame", () => {
    const state = resolveSceneAtFrame(project, "comp-1", 20);
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0]?.localFrame).toBe(10);
  });

  it("resolves at the clip's last visible frame", () => {
    const state = resolveSceneAtFrame(project, "comp-1", 29);
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0]?.localFrame).toBe(19);
  });

  it("resolves zero layers at the clip's end frame (exclusive boundary)", () => {
    const state = resolveSceneAtFrame(project, "comp-1", 30);
    expect(state.layers).toEqual([]);
  });

  it("resolves zero layers well after the clip ends", () => {
    const state = resolveSceneAtFrame(project, "comp-1", 59);
    expect(state.layers).toEqual([]);
  });

  it("resolves at the composition's own last valid frame", () => {
    const state = resolveSceneAtFrame(project, "comp-1", composition.durationInFrames - 1);
    expect(state.layers).toEqual([]);
    expect(state.frame).toBe(59);
    expect(state.width).toBe(1920);
    expect(state.height).toBe(1080);
    expect(state.compositionId).toBe("comp-1");
  });
});

describe("resolveSceneAtFrame: multiple tracks establish z-order", () => {
  const back = Shape({ id: "back-shape" });
  const middle = Shape({ id: "middle-shape" });
  const front = Shape({ id: "front-shape" });

  const composition = createComposition({
    id: "comp-z",
    name: "Z-order",
    fps: 30,
    durationInFrames: 30,
    width: 100,
    height: 100,
    tracks: [
      {
        id: "track-back",
        clips: [Sequence({ id: "clip-back", from: 0, durationInFrames: 30, content: back })],
      },
      {
        id: "track-middle",
        clips: [Sequence({ id: "clip-middle", from: 0, durationInFrames: 30, content: middle })],
      },
      {
        id: "track-front",
        clips: [Sequence({ id: "clip-front", from: 0, durationInFrames: 30, content: front })],
      },
    ],
  });
  const project = createProject({ id: "p-z", name: "Project", compositions: [composition] });

  it("orders layers so later tracks render on top (higher zIndex, later array index)", () => {
    const state = resolveSceneAtFrame(project, "comp-z", 0);

    expect(state.layers.map((layer) => layer.trackId)).toEqual([
      "track-back",
      "track-middle",
      "track-front",
    ]);
    expect(state.layers.map((layer) => layer.zIndex)).toEqual([0, 1, 2]);
    expect(state.layers[state.layers.length - 1]?.node).toEqual(front);
  });
});

describe("resolveSceneAtFrame: sequential clips on one track (Series)", () => {
  const first = Shape({ id: "first-shape" });
  const second = Shape({ id: "second-shape" });
  const third = Shape({ id: "third-shape" });

  const clips = Series([
    { id: "clip-a", durationInFrames: 10, content: first },
    { id: "clip-b", durationInFrames: 10, content: second },
    { id: "clip-c", durationInFrames: 10, content: third },
  ]);

  const composition = createComposition({
    id: "comp-series",
    name: "Series",
    fps: 30,
    durationInFrames: 30,
    width: 100,
    height: 100,
    tracks: [{ id: "track-series", clips }],
  });
  const project = createProject({ id: "p-series", name: "Project", compositions: [composition] });

  it("shows only the first clip's content early in its window", () => {
    const state = resolveSceneAtFrame(project, "comp-series", 5);
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0]?.clipId).toBe("clip-a");
    expect(state.layers[0]?.node).toEqual(first);
    expect(state.layers[0]?.localFrame).toBe(5);
  });

  it("shows only the second clip's content once the first ends", () => {
    const state = resolveSceneAtFrame(project, "comp-series", 15);
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0]?.clipId).toBe("clip-b");
    expect(state.layers[0]?.node).toEqual(second);
    expect(state.layers[0]?.localFrame).toBe(5);
  });

  it("shows only the third clip's content, with a correct local frame, at the boundary", () => {
    const state = resolveSceneAtFrame(project, "comp-series", 20);
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0]?.clipId).toBe("clip-c");
    expect(state.layers[0]?.localFrame).toBe(0);
  });

  it("never shows two clips from the same track at once", () => {
    for (let frame = 0; frame < 30; frame += 1) {
      const state = resolveSceneAtFrame(project, "comp-series", frame);
      expect(state.layers.length).toBeLessThanOrEqual(1);
    }
  });
});

describe("resolveSceneAtFrame: nested compositionRef", () => {
  const innerShape = Shape({ id: "inner-shape" });
  const inner: Composition = createComposition({
    id: "comp-inner",
    name: "Inner",
    fps: 30,
    durationInFrames: 50,
    width: 640,
    height: 480,
    tracks: [
      {
        id: "inner-track",
        clips: [Sequence({ id: "inner-clip", from: 5, durationInFrames: 40, content: innerShape })],
      },
    ],
  });

  const outer: Composition = createComposition({
    id: "comp-outer",
    name: "Outer",
    fps: 30,
    durationInFrames: 100,
    width: 1920,
    height: 1080,
    tracks: [
      {
        id: "outer-track",
        clips: [
          Sequence({
            id: "outer-clip",
            from: 20,
            durationInFrames: 60,
            content: CompositionRef("ref-1", "comp-inner"),
          }),
        ],
      },
    ],
  });

  const project = createProject({ id: "p-nested", name: "Project", compositions: [outer, inner] });

  it("splices the inner composition's content at the outer clip's remapped local frame", () => {
    // Outer clip starts at 20, so outer frame 30 -> outer-local frame 10.
    // Inner clip starts at 5, so inner-local frame is 10 - 5 = 5.
    const state = resolveSceneAtFrame(project, "comp-outer", 30);

    expect(state.layers).toHaveLength(1);
    expect(state.layers[0]).toEqual({
      compositionId: "comp-inner",
      trackId: "inner-track",
      clipId: "inner-clip",
      node: innerShape,
      zIndex: 0,
      localFrame: 5,
      opacity: 1,
    });
  });

  it("shows nothing once the outer clip is active but before the inner clip's own window opens", () => {
    // Outer frame 20 -> outer-local frame 0, which is before the inner
    // clip's own startFrame of 5, so the inner composition contributes
    // nothing even though the compositionRef itself is visible.
    const state = resolveSceneAtFrame(project, "comp-outer", 20);
    expect(state.layers).toEqual([]);
  });

  it("respects the referenced composition's own durationInFrames for its visibility bounds", () => {
    // Inner composition's own duration is 50 frames; outer clip runs from
    // frame 20 to 79 (60 frames), which maps to inner-local frames 0..59.
    // The inner clip itself only runs 5..44, so nothing extra leaks through
    // just because the outer clip's window is longer than the inner
    // composition's duration.
    const state = resolveSceneAtFrame(project, "comp-outer", 79);
    expect(state.layers).toEqual([]);
  });

  it("splices nested content at the correct relative z-position among sibling tracks", () => {
    const behind = Shape({ id: "behind-shape" });
    const aheadComposition = createComposition({
      id: "comp-outer-2",
      name: "Outer2",
      fps: 30,
      durationInFrames: 100,
      width: 1920,
      height: 1080,
      tracks: [
        {
          id: "behind-track",
          clips: [Sequence({ id: "behind-clip", from: 0, durationInFrames: 100, content: behind })],
        },
        {
          id: "ref-track",
          clips: [
            Sequence({
              id: "ref-clip",
              from: 20,
              durationInFrames: 60,
              content: CompositionRef("ref-2", "comp-inner"),
            }),
          ],
        },
      ],
    });
    const multiTrackProject = createProject({
      id: "p-nested-2",
      name: "Project",
      compositions: [aheadComposition, inner],
    });

    const state = resolveSceneAtFrame(multiTrackProject, "comp-outer-2", 30);

    expect(state.layers).toHaveLength(2);
    expect(state.layers[0]?.node).toEqual(behind);
    expect(state.layers[1]?.node).toEqual(innerShape);
    expect(state.layers.map((layer) => layer.zIndex)).toEqual([0, 1]);
  });
});

describe("resolveSceneAtFrame: compositionRef nested inside an ordinary group", () => {
  it("splices the referenced content in and still emits the surrounding ordinary content as its own layer", () => {
    const innerShape = Shape({ id: "deep-inner-shape" });
    const inner = createComposition({
      id: "comp-deep-inner",
      name: "DeepInner",
      fps: 30,
      durationInFrames: 10,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "t",
          clips: [Sequence({ id: "c", from: 0, durationInFrames: 10, content: innerShape })],
        },
      ],
    });

    const sibling = Shape({ id: "sibling-shape" });
    const group: SceneNode = {
      id: "wrapper-group",
      kind: "group",
      transform: createIdentityTransform(),
      visible: true,
      children: [sibling, CompositionRef("deep-ref", "comp-deep-inner")],
    };

    const outer = createComposition({
      id: "comp-deep-outer",
      name: "DeepOuter",
      fps: 30,
      durationInFrames: 10,
      width: 100,
      height: 100,
      tracks: [
        { id: "t", clips: [Sequence({ id: "c", from: 0, durationInFrames: 10, content: group })] },
      ],
    });

    const project = createProject({ id: "p-deep", name: "Project", compositions: [outer, inner] });

    const state = resolveSceneAtFrame(project, "comp-deep-outer", 3);

    expect(state.layers).toHaveLength(2);
    // Nested compositionRef content splices in before the pruned remainder,
    // since it is walked/appended before the loop falls through to push the
    // pruned ordinary-content layer.
    expect(state.layers[0]?.node).toEqual(innerShape);
    expect(state.layers[1]?.node).toEqual({
      id: "wrapper-group",
      kind: "group",
      transform: createIdentityTransform(),
      visible: true,
      children: [sibling],
    });
  });
});

describe("resolveSceneAtFrame: cycle detection", () => {
  it("throws a clear CompositionCycleError instead of recursing forever", () => {
    const compA = createComposition({
      id: "comp-a",
      name: "A",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-a",
          clips: [
            Sequence({
              id: "clip-a",
              from: 0,
              durationInFrames: 30,
              content: CompositionRef("ref-a-to-b", "comp-b"),
            }),
          ],
        },
      ],
    });
    const compB = createComposition({
      id: "comp-b",
      name: "B",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-b",
          clips: [
            Sequence({
              id: "clip-b",
              from: 0,
              durationInFrames: 30,
              content: CompositionRef("ref-b-to-a", "comp-a"),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p-cycle", name: "Project", compositions: [compA, compB] });

    expect(() => resolveSceneAtFrame(project, "comp-a", 0)).toThrow(CompositionCycleError);
    expect(() => resolveSceneAtFrame(project, "comp-b", 0)).toThrow(CompositionCycleError);
  });

  it("names the exact reference chain in the thrown error's message", () => {
    const compA = createComposition({
      id: "cycle-a",
      name: "A",
      fps: 30,
      durationInFrames: 10,
      width: 10,
      height: 10,
      tracks: [
        {
          id: "t",
          clips: [
            Sequence({
              id: "c",
              from: 0,
              durationInFrames: 10,
              content: CompositionRef("r", "cycle-a"),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p-self-cycle", name: "Project", compositions: [compA] });

    expect(() => resolveSceneAtFrame(project, "cycle-a", 0)).toThrow(/cycle-a -> cycle-a/);
  });
});

describe("resolveSceneAtFrame: referencing a nonexistent composition", () => {
  it("throws CompositionNotFoundError", () => {
    const outer = createComposition({
      id: "comp-missing-ref",
      name: "Outer",
      fps: 30,
      durationInFrames: 10,
      width: 10,
      height: 10,
      tracks: [
        {
          id: "t",
          clips: [
            Sequence({
              id: "c",
              from: 0,
              durationInFrames: 10,
              content: CompositionRef("r", "does-not-exist"),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p-missing", name: "Project", compositions: [outer] });

    expect(() => resolveSceneAtFrame(project, "comp-missing-ref", 0)).toThrow(
      CompositionNotFoundError,
    );
  });

  it("throws CompositionNotFoundError for an unresolvable top-level compositionId too", () => {
    const project = createProject({ id: "p-empty", name: "Project", compositions: [] });
    expect(() => resolveSceneAtFrame(project, "nope", 0)).toThrow(CompositionNotFoundError);
  });
});

describe("resolveSceneAtFrame: purity and memoization safety", () => {
  function buildProject(): Project {
    const shape = Shape({ id: "purity-shape" });
    const composition = createComposition({
      id: "comp-purity",
      name: "Purity",
      fps: 30,
      durationInFrames: 30,
      width: 640,
      height: 360,
      tracks: [
        {
          id: "track-purity",
          clips: [Sequence({ id: "clip-purity", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
    });
    return createProject({ id: "p-purity", name: "Project", compositions: [composition] });
  }

  it("returns deep-equal results across repeated calls with the same Project reference", () => {
    const project = buildProject();

    const first = resolveSceneAtFrame(project, "comp-purity", 15);
    const second = resolveSceneAtFrame(project, "comp-purity", 15);

    expect(first).toEqual(second);
  });

  it("returns the exact same cached object on a repeated call with the same reference and frame", () => {
    const project = buildProject();

    const first = resolveSceneAtFrame(project, "comp-purity", 15);
    const second = resolveSceneAtFrame(project, "comp-purity", 15);

    expect(first).toBe(second);
  });

  it("two distinct but deep-equal Project objects both resolve correctly and deep-equal each other", () => {
    const projectA = buildProject();
    const projectB = buildProject();

    expect(projectA).not.toBe(projectB);
    expect(projectA).toEqual(projectB);

    const stateA = resolveSceneAtFrame(projectA, "comp-purity", 15);
    const stateB = resolveSceneAtFrame(projectB, "comp-purity", 15);

    expect(stateA).toEqual(stateB);
    expect(stateA.layers).toHaveLength(1);
    expect(stateB.layers).toHaveLength(1);
  });

  it("does not let a cached result for one frame leak into a different frame's resolution", () => {
    const project = buildProject();

    resolveSceneAtFrame(project, "comp-purity", 15);
    const otherFrame = resolveSceneAtFrame(project, "comp-purity", 100);

    expect(otherFrame.layers).toEqual([]);
    expect(otherFrame.frame).toBe(100);
  });
});
