import type { Project, SceneNode } from "@cadra/core";
import { createIdentityTransform } from "@cadra/core";
import { describe, expect, it } from "vitest";

import {
  applyScenePatchOperation,
  applyScenePatchOperations,
  DuplicateNodeIdError,
  PatchNodeNotFoundError,
} from "./scene-patch.js";
import type { ScenePatchOperation } from "./scene-patch-schema.js";

function groupNode(id: string, children: SceneNode[] = []): SceneNode {
  return {
    id,
    kind: "group",
    transform: createIdentityTransform(),
    visible: true,
    children,
  };
}

function projectWithOneClip(rootNode: SceneNode): Project {
  return {
    id: "proj-1",
    name: "Project",
    compositions: [
      {
        id: "comp-1",
        name: "Main",
        fps: 30,
        durationInFrames: 60,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: "track-1",
            clips: [
              {
                id: "clip-1",
                startFrame: 0,
                durationInFrames: 60,
                node: rootNode,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("applyScenePatchOperation: addNode", () => {
  it("adds a new node as a child of the given parent, leaving unrelated nodes' object references untouched", () => {
    const untouchedSibling = groupNode("sibling");
    const root = groupNode("root", [groupNode("parent"), untouchedSibling]);
    const project = projectWithOneClip(root);

    const operation: ScenePatchOperation = {
      type: "addNode",
      parentId: "parent",
      node: groupNode("new-child"),
    };

    const result = applyScenePatchOperation(project, operation);
    const resultRoot = result.compositions[0]!.tracks[0]!.clips[0]!.node;

    expect(resultRoot.children.find((child) => child.id === "sibling")).toBe(untouchedSibling);

    const parent = resultRoot.children.find((child) => child.id === "parent");
    expect(parent?.children.map((child) => child.id)).toEqual(["new-child"]);
  });

  it("throws PatchNodeNotFoundError when the parent id does not exist", () => {
    const project = projectWithOneClip(groupNode("root"));
    const operation: ScenePatchOperation = {
      type: "addNode",
      parentId: "does-not-exist",
      node: groupNode("new-child"),
    };

    expect(() => applyScenePatchOperation(project, operation)).toThrow(PatchNodeNotFoundError);
  });

  it("throws DuplicateNodeIdError when the new node's id already exists in the project", () => {
    const project = projectWithOneClip(groupNode("root", [groupNode("existing")]));
    const operation: ScenePatchOperation = {
      type: "addNode",
      parentId: "root",
      node: groupNode("existing"),
    };

    expect(() => applyScenePatchOperation(project, operation)).toThrow(DuplicateNodeIdError);
  });
});

describe("applyScenePatchOperation: updateNode", () => {
  it("shallow-merges fields onto the existing node, preserving id, kind, and children", () => {
    const child = groupNode("child");
    const root = groupNode("root", [child]);
    const project = projectWithOneClip(root);

    const operation: ScenePatchOperation = {
      type: "updateNode",
      nodeId: "child",
      fields: { name: "Renamed Child", visible: false },
    };

    const result = applyScenePatchOperation(project, operation);
    const resultChild = result.compositions[0]!.tracks[0]!.clips[0]!.node.children[0]!;

    expect(resultChild.id).toBe("child");
    expect(resultChild.kind).toBe("group");
    expect(resultChild.children).toEqual([]);
    expect(resultChild.name).toBe("Renamed Child");
    expect(resultChild.visible).toBe(false);
  });

  it("leaves sibling subtrees at the exact same object reference", () => {
    const untouchedSibling = groupNode("sibling", [groupNode("nested")]);
    const root = groupNode("root", [groupNode("target"), untouchedSibling]);
    const project = projectWithOneClip(root);

    const operation: ScenePatchOperation = {
      type: "updateNode",
      nodeId: "target",
      fields: { name: "Updated" },
    };

    const result = applyScenePatchOperation(project, operation);
    const resultRoot = result.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(resultRoot.children.find((child) => child.id === "sibling")).toBe(untouchedSibling);
  });

  it("throws PatchNodeNotFoundError when the target node id does not exist", () => {
    const project = projectWithOneClip(groupNode("root"));
    const operation: ScenePatchOperation = {
      type: "updateNode",
      nodeId: "does-not-exist",
      fields: { name: "New Name" },
    };

    expect(() => applyScenePatchOperation(project, operation)).toThrow(PatchNodeNotFoundError);
  });
});

describe("applyScenePatchOperation: removeNode", () => {
  it("removes the target node and its subtree from its parent", () => {
    const toRemove = groupNode("to-remove", [groupNode("nested-under-removed")]);
    const keep = groupNode("keep");
    const root = groupNode("root", [toRemove, keep]);
    const project = projectWithOneClip(root);

    const operation: ScenePatchOperation = { type: "removeNode", nodeId: "to-remove" };
    const result = applyScenePatchOperation(project, operation);
    const resultRoot = result.compositions[0]!.tracks[0]!.clips[0]!.node;

    expect(resultRoot.children.map((child) => child.id)).toEqual(["keep"]);
  });

  it("throws PatchNodeNotFoundError when the target node id does not exist", () => {
    const project = projectWithOneClip(groupNode("root"));
    const operation: ScenePatchOperation = { type: "removeNode", nodeId: "does-not-exist" };

    expect(() => applyScenePatchOperation(project, operation)).toThrow(PatchNodeNotFoundError);
  });

  it("throws when asked to remove a clip's own root node", () => {
    const project = projectWithOneClip(groupNode("root"));
    const operation: ScenePatchOperation = { type: "removeNode", nodeId: "root" };

    expect(() => applyScenePatchOperation(project, operation)).toThrow();
  });
});

describe("applyScenePatchOperations", () => {
  it("applies multiple operations in order, each building on the previous result", () => {
    const project = projectWithOneClip(groupNode("root"));

    const operations: ScenePatchOperation[] = [
      { type: "addNode", parentId: "root", node: groupNode("first") },
      { type: "addNode", parentId: "first", node: groupNode("second") },
      { type: "updateNode", nodeId: "second", fields: { name: "Second Node" } },
    ];

    const result = applyScenePatchOperations(project, operations);
    const resultRoot = result.compositions[0]!.tracks[0]!.clips[0]!.node;
    const first = resultRoot.children.find((child) => child.id === "first");
    const second = first?.children.find((child) => child.id === "second");

    expect(second?.name).toBe("Second Node");
  });

  it("leaves the original project untouched (pure, non-mutating)", () => {
    const root = groupNode("root");
    const project = projectWithOneClip(root);
    const originalChildCount = root.children.length;

    applyScenePatchOperations(project, [{ type: "addNode", parentId: "root", node: groupNode("new") }]);

    expect(root.children.length).toBe(originalChildCount);
  });
});
