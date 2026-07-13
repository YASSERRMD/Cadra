import { describe, expect, it } from "vitest";

import { createComposition } from "../primitives/composition.js";
import { Sequence } from "../primitives/sequence.js";
import { Series } from "../primitives/series.js";
import { Shape } from "../primitives/shape.js";
import { createIdentityTransform } from "../scene-graph/primitives.js";
import { createProject } from "../scene-graph/project-factory.js";
import type { CompositionRefNode, SceneNode } from "../scene-graph/scene-node.js";
import type {
  Composition,
  CompositionFog,
  CompositionPhysics,
  PhysicsConstraintConfig,
  Project,
} from "../scene-graph/timeline.js";
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

/** The exact synthetic wrapper `resolveClipContent`'s own `wrapCompositionRefTransform` produces around one nested layer's own root node, mirroring that function's own id/transform/visible convention - see `resolve-scene.ts`'s own doc for why this wrapping is what actually carries a `compositionRef`'s own `transform` through to the resolved layer. */
function wrappedNode(compositionRefNode: CompositionRefNode, nestedRootNode: SceneNode): SceneNode {
  return {
    id: `${compositionRefNode.id}:wraps:${nestedRootNode.id}`,
    kind: "group",
    transform: compositionRefNode.transform,
    visible: compositionRefNode.visible,
    children: [nestedRootNode],
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

  const refOne = CompositionRef("ref-1", "comp-inner");
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
            content: refOne,
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
      node: wrappedNode(refOne, innerShape),
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
    const refTwo = CompositionRef("ref-2", "comp-inner");
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
              content: refTwo,
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
    expect(state.layers[1]?.node).toEqual(wrappedNode(refTwo, innerShape));
    expect(state.layers.map((layer) => layer.zIndex)).toEqual([0, 1]);
  });

  it("carries a non-identity compositionRef transform through to the resolved layer, instead of silently dropping it", () => {
    const movedRef: CompositionRefNode = {
      ...CompositionRef("ref-moved", "comp-inner"),
      transform: { position: [10, 20, 30], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] },
    };
    const outerMoved = createComposition({
      id: "comp-outer-moved",
      name: "OuterMoved",
      fps: 30,
      durationInFrames: 100,
      width: 1920,
      height: 1080,
      tracks: [
        {
          id: "outer-track",
          clips: [Sequence({ id: "outer-clip", from: 20, durationInFrames: 60, content: movedRef })],
        },
      ],
    });
    const movedProject = createProject({ id: "p-moved", name: "Project", compositions: [outerMoved, inner] });

    const state = resolveSceneAtFrame(movedProject, "comp-outer-moved", 30);

    expect(state.layers).toHaveLength(1);
    const wrapper = state.layers[0]?.node;
    expect(wrapper?.kind).toBe("group");
    expect(wrapper?.transform).toEqual(movedRef.transform);
    expect(wrapper?.children).toEqual([innerShape]);
    // Not the identity transform every other test in this file uses -
    // proves this is actually the compositionRef's own authored transform,
    // not some coincidental default.
    expect(wrapper?.transform).not.toEqual(createIdentityTransform());
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
    const deepRef = CompositionRef("deep-ref", "comp-deep-inner");
    const group: SceneNode = {
      id: "wrapper-group",
      kind: "group",
      transform: createIdentityTransform(),
      visible: true,
      children: [sibling, deepRef],
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
    expect(state.layers[0]?.node).toEqual(wrappedNode(deepRef, innerShape));
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

describe("resolveSceneAtFrame: clip transitionIn (crossDissolve) opacity blending", () => {
  const firstShape = Shape({ id: "transition-first-shape" });
  const secondShape = Shape({ id: "transition-second-shape" });

  // Two clips back to back on one track: clip-first runs frames 0..29,
  // clip-second runs frames 30..59 and blends in with a 10-frame
  // crossDissolve, so the transition window is [30, 40).
  const clipFirst = Sequence({
    id: "clip-first",
    from: 0,
    durationInFrames: 30,
    content: firstShape,
  });
  const clipSecond = {
    ...Sequence({ id: "clip-second", from: 30, durationInFrames: 30, content: secondShape }),
    transitionIn: { type: "crossDissolve" as const, durationInFrames: 10 },
  };

  const composition = createComposition({
    id: "comp-transition",
    name: "Transition",
    fps: 30,
    durationInFrames: 60,
    width: 100,
    height: 100,
    tracks: [{ id: "track-transition", clips: [clipFirst, clipSecond] }],
  });
  const project = createProject({
    id: "p-transition",
    name: "Project",
    compositions: [composition],
  });

  it("shows only the first clip at opacity 1 before the transition window opens", () => {
    const state = resolveSceneAtFrame(project, "comp-transition", 20);
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0]?.clipId).toBe("clip-first");
    expect(state.layers[0]?.opacity).toBe(1);
  });

  it("shows only the first clip at opacity 1 on the last frame strictly before the transition starts", () => {
    const state = resolveSceneAtFrame(project, "comp-transition", 29);
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0]?.clipId).toBe("clip-first");
    expect(state.layers[0]?.opacity).toBe(1);
  });

  it("at the transition's first frame, both layers are present: incoming opacity 0, outgoing opacity 1", () => {
    const state = resolveSceneAtFrame(project, "comp-transition", 30);
    expect(state.layers).toHaveLength(2);
    expect(state.layers[0]?.clipId).toBe("clip-first");
    expect(state.layers[0]?.opacity).toBe(1);
    expect(state.layers[1]?.clipId).toBe("clip-second");
    expect(state.layers[1]?.opacity).toBe(0);
  });

  it("at the transition's midpoint, both clips' layers are present with opacities summing to 1 and matching the exact blend factor", () => {
    const state = resolveSceneAtFrame(project, "comp-transition", 35);

    expect(state.layers).toHaveLength(2);

    // Outgoing (clip-first) is positioned before the incoming clip's layer in z-order.
    const outgoing = state.layers[0];
    const incoming = state.layers[1];
    expect(outgoing?.clipId).toBe("clip-first");
    expect(incoming?.clipId).toBe("clip-second");

    // framesIntoTransition = 35 - 30 = 5, durationInFrames = 10 -> blend = 0.5 exactly.
    expect(incoming?.opacity).toBe(0.5);
    expect(outgoing?.opacity).toBe(0.5);
    expect((incoming?.opacity ?? 0) + (outgoing?.opacity ?? 0)).toBe(1);

    // zIndex still matches array position, unaffected by opacity.
    expect(outgoing?.zIndex).toBe(0);
    expect(incoming?.zIndex).toBe(1);
  });

  it("at the transition's last frame (framesIntoTransition = 9), blend is close to but not yet 1", () => {
    const state = resolveSceneAtFrame(project, "comp-transition", 39);
    expect(state.layers).toHaveLength(2);
    const outgoing = state.layers[0];
    const incoming = state.layers[1];
    expect(incoming?.opacity).toBeCloseTo(0.9);
    expect(outgoing?.opacity).toBeCloseTo(0.1);
  });

  it("shows only the second clip at opacity 1 once the transition window closes, with the first clip gone", () => {
    const state = resolveSceneAtFrame(project, "comp-transition", 40);
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0]?.clipId).toBe("clip-second");
    expect(state.layers[0]?.opacity).toBe(1);
  });

  it("shows only the second clip at opacity 1 well after the transition ends", () => {
    const state = resolveSceneAtFrame(project, "comp-transition", 50);
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0]?.clipId).toBe("clip-second");
    expect(state.layers[0]?.opacity).toBe(1);
  });
});

describe("resolveSceneAtFrame: clip transitionIn with no preceding clip (fade-in from nothing)", () => {
  it("applies opacity = blend to the sole incoming clip, with no outgoing layer to pair it with", () => {
    const shape = Shape({ id: "solo-fade-shape" });
    const soleClip = {
      ...Sequence({ id: "clip-solo", from: 0, durationInFrames: 30, content: shape }),
      transitionIn: { type: "fade" as const, durationInFrames: 10 },
    };
    const composition = createComposition({
      id: "comp-solo-fade",
      name: "SoloFade",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [{ id: "track-solo", clips: [soleClip] }],
    });
    const project = createProject({
      id: "p-solo-fade",
      name: "Project",
      compositions: [composition],
    });

    const atStart = resolveSceneAtFrame(project, "comp-solo-fade", 0);
    expect(atStart.layers).toHaveLength(1);
    expect(atStart.layers[0]?.opacity).toBe(0);

    const atMid = resolveSceneAtFrame(project, "comp-solo-fade", 5);
    expect(atMid.layers).toHaveLength(1);
    expect(atMid.layers[0]?.opacity).toBe(0.5);

    const afterTransition = resolveSceneAtFrame(project, "comp-solo-fade", 15);
    expect(afterTransition.layers).toHaveLength(1);
    expect(afterTransition.layers[0]?.opacity).toBe(1);
  });
});

describe("resolveSceneAtFrame: activeCameraNodeId resolution", () => {
  function buildCameraProject(): Project {
    const shape = Shape({ id: "camera-track-shape" });
    const composition = createComposition({
      id: "comp-camera-track",
      name: "CameraTrack",
      fps: 30,
      durationInFrames: 60,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 60, content: shape })],
        },
      ],
    });
    const withActiveCameraTrack: Composition = {
      ...composition,
      activeCameraTrack: [
        { startFrame: 0, durationInFrames: 30, cameraNodeId: "camera-a" },
        { startFrame: 30, durationInFrames: 30, cameraNodeId: "camera-b" },
      ],
    };
    return createProject({
      id: "p-camera-track",
      name: "Project",
      compositions: [withActiveCameraTrack],
    });
  }

  it("resolves to the first entry's cameraNodeId within its frame range", () => {
    const project = buildCameraProject();
    const state = resolveSceneAtFrame(project, "comp-camera-track", 10);
    expect(state.activeCameraNodeId).toBe("camera-a");
  });

  it("resolves to the second entry's cameraNodeId within its frame range", () => {
    const project = buildCameraProject();
    const state = resolveSceneAtFrame(project, "comp-camera-track", 45);
    expect(state.activeCameraNodeId).toBe("camera-b");
  });

  it("resolves at each entry's exact boundary frame (half-open window)", () => {
    const project = buildCameraProject();
    expect(resolveSceneAtFrame(project, "comp-camera-track", 0).activeCameraNodeId).toBe(
      "camera-a",
    );
    expect(resolveSceneAtFrame(project, "comp-camera-track", 29).activeCameraNodeId).toBe(
      "camera-a",
    );
    expect(resolveSceneAtFrame(project, "comp-camera-track", 30).activeCameraNodeId).toBe(
      "camera-b",
    );
  });

  it("resolves to undefined outside every entry's frame range", () => {
    const shape = Shape({ id: "camera-gap-shape" });
    const composition = createComposition({
      id: "comp-camera-gap",
      name: "CameraGap",
      fps: 30,
      durationInFrames: 60,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 60, content: shape })],
        },
      ],
    });
    const withGap: Composition = {
      ...composition,
      activeCameraTrack: [{ startFrame: 10, durationInFrames: 10, cameraNodeId: "camera-a" }],
    };
    const project = createProject({ id: "p-camera-gap", name: "Project", compositions: [withGap] });

    expect(resolveSceneAtFrame(project, "comp-camera-gap", 5).activeCameraNodeId).toBeUndefined();
    expect(resolveSceneAtFrame(project, "comp-camera-gap", 25).activeCameraNodeId).toBeUndefined();
  });

  it("resolves to undefined when the composition has no activeCameraTrack at all", () => {
    const shape = Shape({ id: "no-camera-track-shape" });
    const composition = createComposition({
      id: "comp-no-camera-track",
      name: "NoCameraTrack",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
    });
    const project = createProject({
      id: "p-no-camera-track",
      name: "Project",
      compositions: [composition],
    });

    const state = resolveSceneAtFrame(project, "comp-no-camera-track", 5);
    expect(state.activeCameraNodeId).toBeUndefined();
  });
});

describe("resolveSceneAtFrame: colorGrading passthrough", () => {
  it("carries the composition's own colorGrading through unchanged", () => {
    const shape = Shape({ id: "graded-shape" });
    const colorGrading = { exposureStops: 0.5, whiteBalanceTemperatureK: 5000, whiteBalanceTint: -0.2 };
    const composition = createComposition({
      id: "comp-graded",
      name: "Graded",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
      colorGrading,
    });
    const project = createProject({ id: "p-graded", name: "Project", compositions: [composition] });

    const state = resolveSceneAtFrame(project, "comp-graded", 5);
    expect(state.colorGrading).toEqual(colorGrading);
  });

  it("leaves colorGrading undefined when the composition has none", () => {
    const shape = Shape({ id: "ungraded-shape" });
    const composition = createComposition({
      id: "comp-ungraded",
      name: "Ungraded",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
    });
    const project = createProject({ id: "p-ungraded", name: "Project", compositions: [composition] });

    const state = resolveSceneAtFrame(project, "comp-ungraded", 5);
    expect(state.colorGrading).toBeUndefined();
  });
});

describe("resolveSceneAtFrame: environment passthrough", () => {
  it("carries the composition's own environment through unchanged", () => {
    const shape = Shape({ id: "lit-shape" });
    const environment = { envMapRef: "studio", rotation: 1.2, intensity: 0.8, showBackground: true };
    const composition = createComposition({
      id: "comp-environment",
      name: "Environment",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
      environment,
    });
    const project = createProject({ id: "p-environment", name: "Project", compositions: [composition] });

    const state = resolveSceneAtFrame(project, "comp-environment", 5);
    expect(state.environment).toEqual(environment);
  });

  it("leaves environment undefined when the composition has none", () => {
    const shape = Shape({ id: "unlit-shape" });
    const composition = createComposition({
      id: "comp-no-environment",
      name: "No Environment",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
    });
    const project = createProject({ id: "p-no-environment", name: "Project", compositions: [composition] });

    const state = resolveSceneAtFrame(project, "comp-no-environment", 5);
    expect(state.environment).toBeUndefined();
  });
});

describe("resolveSceneAtFrame: fog passthrough (Phase 68)", () => {
  it("carries the composition's own fog through unchanged", () => {
    const shape = Shape({ id: "foggy-shape" });
    const fog: CompositionFog = { type: "exponential", color: [0.7, 0.7, 0.75, 1], density: 0.02 };
    const composition = createComposition({
      id: "comp-fog",
      name: "Fog",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
      fog,
    });
    const project = createProject({ id: "p-fog", name: "Project", compositions: [composition] });

    const state = resolveSceneAtFrame(project, "comp-fog", 5);
    expect(state.fog).toEqual(fog);
  });

  it("leaves fog undefined when the composition has none", () => {
    const shape = Shape({ id: "unfogged-shape" });
    const composition = createComposition({
      id: "comp-no-fog",
      name: "No Fog",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
    });
    const project = createProject({ id: "p-no-fog", name: "Project", compositions: [composition] });

    const state = resolveSceneAtFrame(project, "comp-no-fog", 5);
    expect(state.fog).toBeUndefined();
  });
});

describe("resolveSceneAtFrame: shadowQuality passthrough", () => {
  it("carries the composition's own shadowQuality through unchanged", () => {
    const shape = Shape({ id: "shadowed-shape" });
    const shadowQuality = {
      tier: "final" as const,
      cascadedShadows: { cascades: 4, maxFar: 500 },
      ambientOcclusion: { radius: 1.5, intensity: 0.8 },
      contactShadows: { groundY: 0, opacity: 0.6 },
    };
    const composition = createComposition({
      id: "comp-shadow-quality",
      name: "Shadow Quality",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
      shadowQuality,
    });
    const project = createProject({ id: "p-shadow-quality", name: "Project", compositions: [composition] });

    const state = resolveSceneAtFrame(project, "comp-shadow-quality", 5);
    expect(state.shadowQuality).toEqual(shadowQuality);
  });

  it("leaves shadowQuality undefined when the composition has none", () => {
    const shape = Shape({ id: "unshadowed-shape" });
    const composition = createComposition({
      id: "comp-no-shadow-quality",
      name: "No Shadow Quality",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
    });
    const project = createProject({ id: "p-no-shadow-quality", name: "Project", compositions: [composition] });

    const state = resolveSceneAtFrame(project, "comp-no-shadow-quality", 5);
    expect(state.shadowQuality).toBeUndefined();
  });
});

describe("resolveSceneAtFrame: postProcessing passthrough", () => {
  it("carries the composition's own postProcessing through unchanged", () => {
    const shape = Shape({ id: "post-processed-shape" });
    const postProcessing = { tier: "preview" as const, effects: [{ type: "sharpen" as const, amount: 0.4 }] };
    const composition = createComposition({
      id: "comp-post-processing",
      name: "Post Processing",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
      postProcessing,
    });
    const project = createProject({ id: "p-post-processing", name: "Project", compositions: [composition] });

    const state = resolveSceneAtFrame(project, "comp-post-processing", 5);
    expect(state.postProcessing).toEqual(postProcessing);
  });

  it("leaves postProcessing undefined when the composition has none", () => {
    const shape = Shape({ id: "unprocessed-shape" });
    const composition = createComposition({
      id: "comp-no-post-processing",
      name: "No Post Processing",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
    });
    const project = createProject({ id: "p-no-post-processing", name: "Project", compositions: [composition] });

    const state = resolveSceneAtFrame(project, "comp-no-post-processing", 5);
    expect(state.postProcessing).toBeUndefined();
  });
});

describe("resolveSceneAtFrame: renderMode and pathTracing passthrough", () => {
  it("carries the composition's own renderMode and pathTracing through unchanged", () => {
    const shape = Shape({ id: "path-traced-shape" });
    const pathTracing = { tier: "final" as const, samples: 256, bounces: 6 };
    const composition = createComposition({
      id: "comp-path-traced",
      name: "Path Traced",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
      renderMode: "pathTraced",
      pathTracing,
    });
    const project = createProject({ id: "p-path-traced", name: "Project", compositions: [composition] });

    const state = resolveSceneAtFrame(project, "comp-path-traced", 5);
    expect(state.renderMode).toBe("pathTraced");
    expect(state.pathTracing).toEqual(pathTracing);
  });

  it("leaves renderMode and pathTracing undefined when the composition has neither", () => {
    const shape = Shape({ id: "raster-shape" });
    const composition = createComposition({
      id: "comp-raster",
      name: "Raster",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
    });
    const project = createProject({ id: "p-raster", name: "Project", compositions: [composition] });

    const state = resolveSceneAtFrame(project, "comp-raster", 5);
    expect(state.renderMode).toBeUndefined();
    expect(state.pathTracing).toBeUndefined();
  });
});

describe("resolveSceneAtFrame: physics and physicsConstraints passthrough", () => {
  it("carries the composition's own physics and physicsConstraints through unchanged", () => {
    const shape = Shape({ id: "physics-shape" });
    const physics: CompositionPhysics = { gravity: [0, -9.81, 0], substeps: 4 };
    const physicsConstraints: PhysicsConstraintConfig[] = [
      {
        id: "joint-1",
        type: "fixed",
        bodyA: "body-a",
        bodyB: "body-b",
        anchorA: [0, 0, 0],
        anchorB: [0, 0, 0],
      },
    ];
    const composition = createComposition({
      id: "comp-physics",
      name: "Physics",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
      physics,
      physicsConstraints,
    });
    const project = createProject({ id: "p-physics", name: "Project", compositions: [composition] });

    const state = resolveSceneAtFrame(project, "comp-physics", 5);
    expect(state.physics).toEqual(physics);
    expect(state.physicsConstraints).toEqual(physicsConstraints);
  });

  it("leaves physics and physicsConstraints undefined when the composition has neither", () => {
    const shape = Shape({ id: "no-physics-shape" });
    const composition = createComposition({
      id: "comp-no-physics",
      name: "No Physics",
      fps: 30,
      durationInFrames: 30,
      width: 100,
      height: 100,
      tracks: [
        {
          id: "track-content",
          clips: [Sequence({ id: "clip-content", from: 0, durationInFrames: 30, content: shape })],
        },
      ],
    });
    const project = createProject({ id: "p-no-physics", name: "Project", compositions: [composition] });

    const state = resolveSceneAtFrame(project, "comp-no-physics", 5);
    expect(state.physics).toBeUndefined();
    expect(state.physicsConstraints).toBeUndefined();
  });
});
