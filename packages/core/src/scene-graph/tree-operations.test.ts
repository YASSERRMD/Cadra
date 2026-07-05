import { describe, expect, it } from "vitest";

import { createIdentityTransform } from "./primitives.js";
import type { GroupNode, SceneNode } from "./scene-node.js";
import {
  addNode,
  findNode,
  removeNode,
  SceneNodeNotFoundError,
  updateNode,
} from "./tree-operations.js";

function makeGroup(id: string, children: SceneNode[] = []): GroupNode {
  return {
    id,
    kind: "group",
    transform: createIdentityTransform(),
    visible: true,
    children,
  };
}

/**
 * A 4-level tree with siblings at multiple levels:
 *
 * root
 * |- branch-a
 * |  |- leaf-a1
 * |  `- leaf-a2
 * |     `- leaf-a2-deep
 * `- branch-b
 *    `- leaf-b1
 */
function makeMultiLevelTree(): GroupNode {
  return makeGroup("root", [
    makeGroup("branch-a", [
      makeGroup("leaf-a1"),
      makeGroup("leaf-a2", [makeGroup("leaf-a2-deep")]),
    ]),
    makeGroup("branch-b", [makeGroup("leaf-b1")]),
  ]);
}

describe("findNode", () => {
  it("finds the root node itself", () => {
    const tree = makeMultiLevelTree();
    expect(findNode(tree, "root")).toBe(tree);
  });

  it("finds a deeply nested node", () => {
    const tree = makeMultiLevelTree();
    const found = findNode(tree, "leaf-a2-deep");
    expect(found).toBeDefined();
    expect(found?.id).toBe("leaf-a2-deep");
  });

  it("finds a node among siblings", () => {
    const tree = makeMultiLevelTree();
    expect(findNode(tree, "leaf-b1")?.id).toBe("leaf-b1");
  });

  it("returns undefined for an id that does not exist", () => {
    const tree = makeMultiLevelTree();
    expect(findNode(tree, "does-not-exist")).toBeUndefined();
  });

  it("does not mutate the tree it searches", () => {
    const tree = makeMultiLevelTree();
    const before = structuredClone(tree);
    findNode(tree, "leaf-a2-deep");
    expect(tree).toEqual(before);
  });
});

describe("addNode", () => {
  it("appends the child to the matching parent's children array", () => {
    const tree = makeMultiLevelTree();
    const newChild = makeGroup("new-leaf");

    const result = addNode(tree, "branch-a", newChild);

    const parent = findNode(result, "branch-a");
    expect(parent?.children.map((c) => c.id)).toEqual(["leaf-a1", "leaf-a2", "new-leaf"]);
  });

  it("adds a child under the root", () => {
    const tree = makeMultiLevelTree();
    const newChild = makeGroup("root-child");

    const result = addNode(tree, "root", newChild);

    expect(result.children.at(-1)?.id).toBe("root-child");
  });

  it("throws SceneNodeNotFoundError when parentId does not exist", () => {
    const tree = makeMultiLevelTree();
    expect(() => addNode(tree, "missing-parent", makeGroup("x"))).toThrow(
      SceneNodeNotFoundError,
    );
  });

  it("does not mutate the original tree", () => {
    const tree = makeMultiLevelTree();
    const before = structuredClone(tree);

    addNode(tree, "branch-a", makeGroup("new-leaf"));

    expect(tree).toEqual(before);
  });

  it("keeps unaffected sibling subtrees reference-identical", () => {
    const tree = makeMultiLevelTree();
    const branchB = findNode(tree, "branch-b");
    const leafA1 = findNode(tree, "leaf-a1");

    const result = addNode(tree, "branch-a", makeGroup("new-leaf"));

    // branch-b is not on the path to branch-a, so it must be the same object.
    expect(findNode(result, "branch-b")).toBe(branchB);
    // leaf-a1 is a sibling of the insertion point within branch-a, not an
    // ancestor of it, so it too must be unchanged.
    expect(findNode(result, "leaf-a1")).toBe(leafA1);
  });

  it("creates new objects only along the path from root to the parent", () => {
    const tree = makeMultiLevelTree();

    const result = addNode(tree, "leaf-a2", makeGroup("new-leaf"));

    // Path root -> branch-a -> leaf-a2 must all be new objects.
    expect(result).not.toBe(tree);
    expect(findNode(result, "branch-a")).not.toBe(findNode(tree, "branch-a"));
    expect(findNode(result, "leaf-a2")).not.toBe(findNode(tree, "leaf-a2"));
    // The deep child of leaf-a2 was not touched, so it keeps its reference.
    expect(findNode(result, "leaf-a2-deep")).toBe(findNode(tree, "leaf-a2-deep"));
  });
});

describe("updateNode", () => {
  it("replaces the matching node with the updater's return value", () => {
    const tree = makeMultiLevelTree();

    const result = updateNode(tree, "leaf-b1", (node) => ({ ...node, visible: false }));

    expect(findNode(result, "leaf-b1")?.visible).toBe(false);
  });

  it("passes the original node to the updater", () => {
    const tree = makeMultiLevelTree();
    const original = findNode(tree, "leaf-a1");

    updateNode(tree, "leaf-a1", (node) => {
      expect(node).toBe(original);
      return node;
    });
  });

  it("can update the root node", () => {
    const tree = makeMultiLevelTree();

    const result = updateNode(tree, "root", (node) => ({ ...node, name: "renamed" }));

    expect(result.name).toBe("renamed");
  });

  it("throws SceneNodeNotFoundError when id does not exist", () => {
    const tree = makeMultiLevelTree();
    expect(() => updateNode(tree, "missing", (node) => node)).toThrow(SceneNodeNotFoundError);
  });

  it("does not mutate the original tree", () => {
    const tree = makeMultiLevelTree();
    const before = structuredClone(tree);

    updateNode(tree, "leaf-a2-deep", (node) => ({ ...node, name: "changed" }));

    expect(tree).toEqual(before);
  });

  it("keeps unaffected sibling subtrees reference-identical", () => {
    const tree = makeMultiLevelTree();
    const branchB = findNode(tree, "branch-b");
    const leafA2 = findNode(tree, "leaf-a2");

    const result = updateNode(tree, "leaf-a1", (node) => ({ ...node, visible: false }));

    expect(findNode(result, "branch-b")).toBe(branchB);
    expect(findNode(result, "leaf-a2")).toBe(leafA2);
  });
});

describe("removeNode", () => {
  it("removes the matching node from its parent's children", () => {
    const tree = makeMultiLevelTree();

    const result = addNode(tree, "root", makeGroup("throwaway"));
    const removed = removeNode(result, "throwaway");

    expect(findNode(removed, "throwaway")).toBeUndefined();
  });

  it("removes a deeply nested leaf", () => {
    const tree = makeMultiLevelTree();

    const result = removeNode(tree, "leaf-a2-deep");

    expect(findNode(result, "leaf-a2-deep")).toBeUndefined();
    expect(findNode(result, "leaf-a2")).toBeDefined();
  });

  it("removes a whole subtree, taking descendants with it", () => {
    const tree = makeMultiLevelTree();

    const result = removeNode(tree, "leaf-a2");

    expect(findNode(result, "leaf-a2")).toBeUndefined();
    expect(findNode(result, "leaf-a2-deep")).toBeUndefined();
  });

  it("throws SceneNodeNotFoundError when id does not exist", () => {
    const tree = makeMultiLevelTree();
    expect(() => removeNode(tree, "missing")).toThrow(SceneNodeNotFoundError);
  });

  it("throws when asked to remove the root node", () => {
    const tree = makeMultiLevelTree();
    expect(() => removeNode(tree, "root")).toThrow(SceneNodeNotFoundError);
  });

  it("does not mutate the original tree", () => {
    const tree = makeMultiLevelTree();
    const before = structuredClone(tree);

    removeNode(tree, "leaf-b1");

    expect(tree).toEqual(before);
  });

  it("keeps unaffected sibling subtrees reference-identical", () => {
    const tree = makeMultiLevelTree();
    const branchB = findNode(tree, "branch-b");
    const leafA1 = findNode(tree, "leaf-a1");

    const result = removeNode(tree, "leaf-a2-deep");

    expect(findNode(result, "branch-b")).toBe(branchB);
    expect(findNode(result, "leaf-a1")).toBe(leafA1);
  });
});
