import type { SceneNode } from "./scene-node.js";

/** Thrown when a tree operation is given a node id that does not exist. */
export class SceneNodeNotFoundError extends Error {
  constructor(id: string, operation: string) {
    super(`${operation}: no scene node with id "${id}" was found in the tree.`);
    this.name = "SceneNodeNotFoundError";
  }
}

/**
 * Recursively searches `root` and its descendants for a node whose `id`
 * matches, returning the first match in depth-first, pre-order traversal.
 * Returns `undefined` if no node matches. Never mutates `root`.
 */
export function findNode(root: SceneNode, id: string): SceneNode | undefined {
  if (root.id === id) {
    return root;
  }
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Returns a new tree equal to `root` except that the node matching
 * `parentId` has `child` appended to its `children` array.
 *
 * Uses structural sharing: only `root` itself and the nodes on the path from
 * `root` down to the `parentId` node are newly allocated objects. Every
 * sibling subtree not on that path keeps the exact same object reference it
 * had in `root`. `root` and `child` are never mutated.
 *
 * @throws {SceneNodeNotFoundError} if no node in the tree has id `parentId`.
 */
export function addNode(root: SceneNode, parentId: string, child: SceneNode): SceneNode {
  const { result, matched } = copyPathToTarget(root, parentId, (target) => ({
    ...target,
    children: [...target.children, child],
  }));

  if (!matched) {
    throw new SceneNodeNotFoundError(parentId, "addNode");
  }

  return result;
}

/**
 * Returns a new tree equal to `root` except that the node matching `id` is
 * replaced by `updater(node)`. `updater` receives the original, unmodified
 * node and must return the replacement node (it may reuse or copy fields
 * from the original as it sees fit).
 *
 * Uses the same structural-sharing guarantee as `addNode`: only nodes on the
 * path from `root` to the matched node are new objects. `root` is never
 * mutated.
 *
 * @throws {SceneNodeNotFoundError} if no node in the tree has id `id`.
 */
export function updateNode(
  root: SceneNode,
  id: string,
  updater: (node: SceneNode) => SceneNode,
): SceneNode {
  const { result, matched } = copyPathToTarget(root, id, updater);

  if (!matched) {
    throw new SceneNodeNotFoundError(id, "updateNode");
  }

  return result;
}

/**
 * Returns a new tree equal to `root` with the node matching `id` removed
 * from its parent's `children` array.
 *
 * Uses the same structural-sharing guarantee as `addNode`: only the removed
 * node's ancestors are new objects; unrelated subtrees keep their original
 * object references. `root` is never mutated.
 *
 * @throws {SceneNodeNotFoundError} if no node in the tree has id `id`, or if
 *   `id` is the id of `root` itself (a tree must always have a root, so the
 *   root cannot be removed by this operation).
 */
export function removeNode(root: SceneNode, id: string): SceneNode {
  if (root.id === id) {
    throw new SceneNodeNotFoundError(id, "removeNode: cannot remove the root node");
  }

  let matched = false;

  function recurse(node: SceneNode): SceneNode {
    const hasMatchingChild = node.children.some((child) => child.id === id);
    if (hasMatchingChild) {
      matched = true;
      return {
        ...node,
        children: node.children.filter((child) => child.id !== id),
      };
    }

    let childrenChanged = false;
    const nextChildren = node.children.map((child) => {
      const nextChild = recurse(child);
      if (nextChild !== child) {
        childrenChanged = true;
      }
      return nextChild;
    });

    if (!childrenChanged) {
      return node;
    }

    return { ...node, children: nextChildren };
  }

  const result = recurse(root);

  if (!matched) {
    throw new SceneNodeNotFoundError(id, "removeNode");
  }

  return result;
}

/**
 * Shared traversal for `addNode` and `updateNode`: walks `node` looking for
 * the descendant (or `node` itself) whose id is `targetId`, and replaces it
 * with `transform(target)`, copying only the nodes on the path down to it.
 * Nodes off that path are returned by the exact same reference they were
 * passed in with.
 *
 * `matched` is `false` when no node with `targetId` was found anywhere in
 * `node`'s subtree, in which case `result` is `node` itself, unchanged.
 */
function copyPathToTarget(
  node: SceneNode,
  targetId: string,
  transform: (target: SceneNode) => SceneNode,
): { result: SceneNode; matched: boolean } {
  if (node.id === targetId) {
    return { result: transform(node), matched: true };
  }

  let matched = false;
  let childrenChanged = false;
  const nextChildren = node.children.map((child) => {
    if (matched) {
      // Already found and replaced the target in an earlier sibling; every
      // remaining child is untouched, so keep its original reference.
      return child;
    }
    const childResult = copyPathToTarget(child, targetId, transform);
    if (childResult.matched) {
      matched = true;
      childrenChanged = true;
    }
    return childResult.result;
  });

  if (!matched) {
    return { result: node, matched: false };
  }

  return {
    result: childrenChanged ? { ...node, children: nextChildren } : node,
    matched: true,
  };
}
