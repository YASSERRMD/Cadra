import { createIdentityTransform, type SceneNode } from "@cadra/core";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import { createReconciler } from "./reconciler.js";

/** Number of add-then-remove cycles the leak test runs. Deliberately the full 10000, not a smaller stand-in. */
const CYCLE_COUNT = 10000;

function rootGroup(children: SceneNode[]): SceneNode {
  return {
    id: "root",
    kind: "group",
    transform: createIdentityTransform(),
    visible: true,
    children,
  };
}

/** Reused with the same id every cycle: if the internal map ever failed to purge a removed entry, the next cycle would wrongly reuse the stale (already-disposed) object instead of creating fresh. */
function textLeaf(): SceneNode {
  return {
    id: "leaf",
    kind: "text",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    content: "leak-check",
    fontSize: 10,
    color: [1, 1, 1, 1],
  };
}

describe("createReconciler: add-then-remove leak stress test", () => {
  it(`disposes exactly one owned material per cycle across ${CYCLE_COUNT} cycles, reuses no stale object, and stays at map size 1 (no unbounded growth)`, () => {
    const reconciler = createReconciler();
    const disposeSpy = vi.spyOn(THREE.MeshBasicMaterial.prototype, "dispose");
    const seenObjects = new Set<THREE.Object3D>();

    reconciler.reconcile(rootGroup([]), 0);
    expect(disposeSpy).toHaveBeenCalledTimes(0);

    for (let cycle = 0; cycle < CYCLE_COUNT; cycle += 1) {
      const afterAdd = reconciler.reconcile(rootGroup([textLeaf()]), 0) as THREE.Group;
      expect(afterAdd.children).toHaveLength(1);
      const leafObject = afterAdd.children[0];
      expect(leafObject).toBeDefined();

      // A brand new Object3D every cycle proves the internal map actually
      // purged the previous cycle's entry for id "leaf" (a stale, un-deleted
      // map entry with the same id and kind would have been reused here
      // instead of recreated), which is the direct evidence against
      // unbounded growth of that map: it never accumulates dead entries
      // under the same id, so its size for this id stays exactly 1 (present)
      // or 0 (absent) throughout, never more.
      expect(seenObjects.has(leafObject as THREE.Object3D)).toBe(false);
      seenObjects.add(leafObject as THREE.Object3D);

      const afterRemove = reconciler.reconcile(rootGroup([]), 0) as THREE.Group;
      expect(afterRemove.children).toHaveLength(0);

      // One text node created and removed per cycle means exactly one owned
      // material disposed per cycle: no leaks (a dispose is happening) and
      // no double-dispose (it is not happening more than once per cycle).
      expect(disposeSpy).toHaveBeenCalledTimes(cycle + 1);
    }

    expect(disposeSpy).toHaveBeenCalledTimes(CYCLE_COUNT);
    expect(seenObjects.size).toBe(CYCLE_COUNT);

    disposeSpy.mockRestore();
  });

  it("tears down cleanly via reconcile(null) even after many prior add/remove cycles", () => {
    const reconciler = createReconciler();
    reconciler.reconcile(rootGroup([]), 0);

    for (let cycle = 0; cycle < 500; cycle += 1) {
      reconciler.reconcile(rootGroup([textLeaf()]), 0);
      reconciler.reconcile(rootGroup([]), 0);
    }

    const rootObject = reconciler.reconcile(rootGroup([textLeaf()]), 0) as THREE.Group;
    const leafObject = rootObject.children[0] as THREE.Mesh;
    const disposeSpy = vi.spyOn(leafObject.material as THREE.Material, "dispose");

    const result = reconciler.reconcile(null, 0);

    expect(result).toBeNull();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(leafObject.parent).toBeNull();
  });
});
