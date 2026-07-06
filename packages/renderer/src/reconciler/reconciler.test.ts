import {
  type CameraNode,
  createIdentityTransform,
  type KeyframeTrack,
  type SceneNode,
  type Transform,
} from "@cadra/core";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import { createReconciler } from "./reconciler.js";
import { createDefaultGeometryRegistry, createDefaultMaterialRegistry } from "./registries.js";

/** Builds a `Transform` at the identity, optionally overriding `position`. */
function transformAt(position: Transform["position"] = [0, 0, 0]): Transform {
  return { ...createIdentityTransform(), position };
}

function group(
  id: string,
  children: SceneNode[] = [],
  overrides: Partial<{ visible: boolean; transform: Transform }> = {},
): SceneNode {
  return {
    id,
    kind: "group",
    transform: transformAt(),
    visible: true,
    children,
    ...overrides,
  };
}

function mesh(
  id: string,
  geometryRef = "box",
  materialRef = "default",
  overrides: Partial<{ visible: boolean; transform: Transform; children: SceneNode[] }> = {},
): SceneNode {
  return {
    id,
    kind: "mesh",
    transform: transformAt(),
    visible: true,
    children: [],
    geometryRef,
    materialRef,
    ...overrides,
  };
}

function camera(
  id: string,
  overrides: Partial<{
    fov: number;
    near: number;
    far: number;
    target: Transform["position"];
  }> = {},
): SceneNode {
  return {
    id,
    kind: "camera",
    transform: transformAt(),
    visible: true,
    children: [],
    fov: 50,
    near: 0.1,
    far: 1000,
    target: [0, 0, 0],
    ...overrides,
  };
}

function light(
  id: string,
  lightType: "ambient" | "directional" | "point" | "spot" = "point",
  overrides: Partial<{ color: [number, number, number, number]; intensity: number }> = {},
): SceneNode {
  return {
    id,
    kind: "light",
    transform: transformAt(),
    visible: true,
    children: [],
    lightType,
    color: [1, 1, 1, 1],
    intensity: 1,
    ...overrides,
  };
}

function text(
  id: string,
  overrides: Partial<{
    content: string;
    color: [number, number, number, number];
    fontSize: number;
  }> = {},
): SceneNode {
  return {
    id,
    kind: "text",
    transform: transformAt(),
    visible: true,
    children: [],
    content: "hello",
    fontSize: 12,
    color: [1, 0, 0, 1],
    ...overrides,
  };
}

function image(id: string, assetRef = "asset-1"): SceneNode {
  return {
    id,
    kind: "image",
    transform: transformAt(),
    visible: true,
    children: [],
    assetRef,
  };
}

function compositionRef(id: string, compositionId = "comp-1"): SceneNode {
  return {
    id,
    kind: "compositionRef",
    transform: transformAt(),
    visible: true,
    children: [],
    compositionId,
  };
}

describe("createReconciler: kind-to-Three.js mapping", () => {
  it("maps group to THREE.Group", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(group("root"), 0);
    expect(result).toBeInstanceOf(THREE.Group);
  });

  it("maps compositionRef to an empty THREE.Group", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(compositionRef("root"), 0);
    expect(result).toBeInstanceOf(THREE.Group);
    expect(result?.children).toHaveLength(0);
  });

  it("maps mesh to THREE.Mesh with registry-resolved geometry and material", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(mesh("root", "sphere", "wireframe"), 0);
    expect(result).toBeInstanceOf(THREE.Mesh);
    const meshResult = result as THREE.Mesh;
    expect(meshResult.geometry).toBeInstanceOf(THREE.SphereGeometry);
    expect(meshResult.material).toBeInstanceOf(THREE.MeshBasicMaterial);
  });

  it("falls back to a default box geometry and neutral material when refs do not resolve", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(
      mesh("root", "does-not-exist", "also-missing"),
      0,
    ) as THREE.Mesh;
    expect(result.geometry).toBeInstanceOf(THREE.BoxGeometry);
    expect(result.material).toBeInstanceOf(THREE.Material);
  });

  it("maps camera to THREE.PerspectiveCamera built from fov/near/far, aspect defaulted to 1", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(camera("root", { fov: 60, near: 1, far: 500 }), 0);
    expect(result).toBeInstanceOf(THREE.PerspectiveCamera);
    const cam = result as THREE.PerspectiveCamera;
    expect(cam.fov).toBe(60);
    expect(cam.near).toBe(1);
    expect(cam.far).toBe(500);
    expect(cam.aspect).toBe(1);
  });

  it("calls lookAt with the camera node's target", () => {
    const lookAtSpy = vi.spyOn(THREE.Object3D.prototype, "lookAt");
    const reconciler = createReconciler();

    reconciler.reconcile(camera("root", { target: [1, 2, 3] }), 0);

    expect(lookAtSpy).toHaveBeenCalledWith(1, 2, 3);
    lookAtSpy.mockRestore();
  });

  it.each([
    ["ambient", THREE.AmbientLight],
    ["directional", THREE.DirectionalLight],
    ["point", THREE.PointLight],
    ["spot", THREE.SpotLight],
  ] as const)("maps light with lightType %s to %s", (lightType, ThreeLightClass) => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(light("root", lightType), 0);
    expect(result).toBeInstanceOf(ThreeLightClass);
  });

  it("applies light color and intensity", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(
      light("root", "point", { color: [0.5, 0.25, 0.75, 1], intensity: 3.5 }),
      0,
    ) as THREE.Light;
    expect(result.color.r).toBeCloseTo(0.5);
    expect(result.color.g).toBeCloseTo(0.25);
    expect(result.color.b).toBeCloseTo(0.75);
    expect(result.intensity).toBe(3.5);
  });

  it("maps text to a Mesh using the shared placeholder plane geometry and a per-node colored material", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(text("root", { color: [0, 1, 0, 1] }), 0) as THREE.Mesh;
    expect(result).toBeInstanceOf(THREE.Mesh);
    expect(result.geometry).toBeInstanceOf(THREE.PlaneGeometry);
    const material = result.material as THREE.MeshBasicMaterial;
    expect(material.color.g).toBeCloseTo(1);
  });

  it("maps image to a Mesh using the shared placeholder plane geometry and a fixed placeholder color", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(image("root"), 0) as THREE.Mesh;
    expect(result).toBeInstanceOf(THREE.Mesh);
    expect(result.geometry).toBeInstanceOf(THREE.PlaneGeometry);
    expect(result.material).toBeInstanceOf(THREE.MeshBasicMaterial);
  });

  it("text and image placeholders share the exact same plane geometry instance", () => {
    const textResult = createReconciler().reconcile(text("t1"), 0) as THREE.Mesh;
    const imageResult = createReconciler().reconcile(image("i1"), 0) as THREE.Mesh;
    expect(textResult.geometry).toBe(imageResult.geometry);
  });

  it("text and image placeholders each own a distinct per-node material", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(
      group("root", [text("t1"), image("i1")]),
      0,
    ) as THREE.Group;
    const textMaterial = (rootObject.children[0] as THREE.Mesh).material;
    const imageMaterial = (rootObject.children[1] as THREE.Mesh).material;
    expect(textMaterial).not.toBe(imageMaterial);
  });
});

describe("createReconciler: add, update, remove", () => {
  it("assigns a fresh Object3D on first sight of an id", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(group("root"), 0);
    expect(result).not.toBeNull();
  });

  it("reuses the exact same Object3D instance across reconcile calls for an unchanged id/kind", () => {
    const reconciler = createReconciler();
    const first = reconciler.reconcile(
      mesh("root", "box", "default", { transform: transformAt([0, 0, 0]) }),
      0,
    );
    const second = reconciler.reconcile(
      mesh("root", "box", "default", { transform: transformAt([1, 2, 3]) }),
      0,
    );
    expect(second).toBe(first);
  });

  it("updates transform (position/rotation/scale) in place on an unchanged id", () => {
    const reconciler = createReconciler();
    reconciler.reconcile(group("root"), 0);
    const updated = reconciler.reconcile(
      group("root", [], {
        transform: { position: [1, 2, 3], rotation: [0.1, 0.2, 0.3], scale: [2, 2, 2] },
      }),
      0,
    );
    expect(updated?.position.toArray()).toEqual([1, 2, 3]);
    expect(updated?.rotation.x).toBeCloseTo(0.1);
    expect(updated?.rotation.y).toBeCloseTo(0.2);
    expect(updated?.rotation.z).toBeCloseTo(0.3);
    expect(updated?.scale.toArray()).toEqual([2, 2, 2]);
  });

  it("updates visibility in place on an unchanged id", () => {
    const reconciler = createReconciler();
    reconciler.reconcile(group("root", [], { visible: true }), 0);
    const updated = reconciler.reconcile(group("root", [], { visible: false }), 0);
    expect(updated?.visible).toBe(false);
  });

  it("updates mesh geometry/material when refs change, on the same Object3D instance", () => {
    const reconciler = createReconciler();
    const first = reconciler.reconcile(mesh("root", "box", "default"), 0) as THREE.Mesh;
    const second = reconciler.reconcile(mesh("root", "sphere", "wireframe"), 0) as THREE.Mesh;
    expect(second).toBe(first);
    expect(second.geometry).toBeInstanceOf(THREE.SphereGeometry);
    expect(second.material).toBeInstanceOf(THREE.MeshBasicMaterial);
  });

  it("updates camera fov/near/far/target in place on the same Object3D instance", () => {
    const reconciler = createReconciler();
    const first = reconciler.reconcile(camera("root", { fov: 50 }), 0) as THREE.PerspectiveCamera;
    const second = reconciler.reconcile(
      camera("root", { fov: 75, target: [5, 0, 0] }),
      0,
    ) as THREE.PerspectiveCamera;
    expect(second).toBe(first);
    expect(second.fov).toBe(75);
  });

  it("updates light color/intensity in place on the same Object3D instance", () => {
    const reconciler = createReconciler();
    const first = reconciler.reconcile(light("root", "point", { intensity: 1 }), 0) as THREE.Light;
    const second = reconciler.reconcile(light("root", "point", { intensity: 9 }), 0) as THREE.Light;
    expect(second).toBe(first);
    expect(second.intensity).toBe(9);
  });

  it("removes an Object3D from the tree and detaches it from its parent when its node disappears", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(group("root", [group("child")]), 0);
    const childObject = rootObject?.children[0];
    expect(childObject).toBeDefined();

    reconciler.reconcile(group("root", []), 0);

    expect(rootObject?.children).toHaveLength(0);
    expect(childObject?.parent).toBeNull();
  });

  it("removes a deeply nested node (not just top-level) when it disappears from the next tree", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(group("root", [group("mid", [group("leaf")])]), 0);
    const midObject = rootObject?.children[0];
    const leafObject = midObject?.children[0];
    expect(leafObject).toBeDefined();

    reconciler.reconcile(group("root", [group("mid", [])]), 0);

    expect(midObject?.children).toHaveLength(0);
    expect(leafObject?.parent).toBeNull();
  });

  it("reconcile(null) tears down the entire tree and disposes owned resources", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(group("root", [text("t1")]), 0) as THREE.Group;
    const textMesh = rootObject.children[0] as THREE.Mesh;
    const material = textMesh.material as THREE.MeshBasicMaterial;
    const disposeSpy = vi.spyOn(material, "dispose");

    const result = reconciler.reconcile(null, 0);

    expect(result).toBeNull();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(textMesh.parent).toBeNull();
  });
});

describe("createReconciler: kind change on the same id", () => {
  it("disposes the old owned resources and creates a fresh Object3D when kind changes", () => {
    const reconciler = createReconciler();
    const first = reconciler.reconcile(text("root"), 0) as THREE.Mesh;
    const oldMaterial = first.material as THREE.MeshBasicMaterial;
    const disposeSpy = vi.spyOn(oldMaterial, "dispose");

    const second = reconciler.reconcile(group("root"), 0);

    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(THREE.Group);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not dispose registry-provided resources on a kind change away from mesh", () => {
    const geometryRegistry = createDefaultGeometryRegistry();
    const materialRegistry = createDefaultMaterialRegistry();
    const reconciler = createReconciler({ geometryRegistry, materialRegistry });
    const meshResult = reconciler.reconcile(mesh("root", "box", "default"), 0) as THREE.Mesh;
    const geometry = meshResult.geometry;
    const material = meshResult.material as THREE.Material;
    const geometryDisposeSpy = vi.spyOn(geometry, "dispose");
    const materialDisposeSpy = vi.spyOn(material, "dispose");

    reconciler.reconcile(group("root"), 0);

    expect(geometryDisposeSpy).not.toHaveBeenCalled();
    expect(materialDisposeSpy).not.toHaveBeenCalled();
    expect(geometryRegistry.resolve("box")).toBe(geometry);
  });

  it("attaches the freshly created replacement under the same parent the old one was under", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(group("root", [text("child")]), 0) as THREE.Group;
    const oldChildObject = rootObject.children[0];

    reconciler.reconcile(group("root", [group("child")]), 0);

    expect(rootObject.children).toHaveLength(1);
    expect(rootObject.children[0]).not.toBe(oldChildObject);
    expect(rootObject.children[0]).toBeInstanceOf(THREE.Group);
    expect(rootObject.children[0]?.parent).toBe(rootObject);
  });
});

describe("createReconciler: reordering", () => {
  it("reorders existing children to match new order without disposing or recreating them", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(
      group("root", [group("a"), group("b"), group("c")]),
      0,
    ) as THREE.Group;
    const [aObject, bObject, cObject] = rootObject.children;

    const reordered = reconciler.reconcile(
      group("root", [group("c"), group("a"), group("b")]),
      0,
    ) as THREE.Group;

    expect(reordered).toBe(rootObject);
    expect(reordered.children).toEqual([cObject, aObject, bObject]);
  });

  it("does not replace the children array when order already matches", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(
      group("root", [group("a"), group("b")]),
      0,
    ) as THREE.Group;
    const childrenArrayRef = rootObject.children;

    reconciler.reconcile(group("root", [group("a"), group("b")]), 0);

    expect(rootObject.children).toBe(childrenArrayRef);
  });
});

describe("createReconciler: reparenting", () => {
  it("moves an existing Object3D to a new parent rather than recreating it", () => {
    const reconciler = createReconciler();
    const tree = group("root", [group("parentA", [group("moving")]), group("parentB", [])]);
    const rootObject = reconciler.reconcile(tree, 0) as THREE.Group;
    const parentAObject = rootObject.children[0] as THREE.Group;
    const parentBObject = rootObject.children[1] as THREE.Group;
    const movingObject = parentAObject.children[0];
    expect(movingObject).toBeDefined();

    reconciler.reconcile(
      group("root", [group("parentA", []), group("parentB", [group("moving")])]),
      0,
    );

    expect(parentAObject.children).toHaveLength(0);
    expect(parentBObject.children).toHaveLength(1);
    expect(parentBObject.children[0]).toBe(movingObject);
    expect(movingObject?.parent).toBe(parentBObject);
  });

  it("preserves the moved node's own properties (kind, transform) across the reparent", () => {
    const reconciler = createReconciler();
    reconciler.reconcile(
      group("root", [
        group("parentA", [mesh("moving", "box", "default", { transform: transformAt([9, 9, 9]) })]),
        group("parentB", []),
      ]),
      0,
    );

    const rootObject = reconciler.reconcile(
      group("root", [
        group("parentA", []),
        group("parentB", [mesh("moving", "box", "default", { transform: transformAt([9, 9, 9]) })]),
      ]),
      0,
    ) as THREE.Group;

    const parentBObject = rootObject.children[1] as THREE.Group;
    const movedObject = parentBObject.children[0];
    expect(movedObject).toBeInstanceOf(THREE.Mesh);
    expect(movedObject?.position.toArray()).toEqual([9, 9, 9]);
  });
});

describe("createReconciler: shared registry resources are never disposed", () => {
  it("leaves a registry geometry/material intact after the one node referencing it is removed", () => {
    const geometryRegistry = createDefaultGeometryRegistry();
    const materialRegistry = createDefaultMaterialRegistry();
    const reconciler = createReconciler({ geometryRegistry, materialRegistry });
    const rootObject = reconciler.reconcile(
      group("root", [mesh("m1", "sphere", "wireframe")]),
      0,
    ) as THREE.Group;
    const meshObject = rootObject.children[0] as THREE.Mesh;
    const geometryDisposeSpy = vi.spyOn(meshObject.geometry, "dispose");
    const materialDisposeSpy = vi.spyOn(meshObject.material as THREE.Material, "dispose");

    reconciler.reconcile(group("root", []), 0);

    expect(geometryDisposeSpy).not.toHaveBeenCalled();
    expect(materialDisposeSpy).not.toHaveBeenCalled();
    expect(geometryRegistry.resolve("sphere")).toBeInstanceOf(THREE.SphereGeometry);
    expect(materialRegistry.resolve("wireframe")).toBeInstanceOf(THREE.MeshBasicMaterial);
  });

  it("leaves a shared registry resource intact when one of two referencing nodes is removed", () => {
    const geometryRegistry = createDefaultGeometryRegistry();
    const materialRegistry = createDefaultMaterialRegistry();
    const reconciler = createReconciler({ geometryRegistry, materialRegistry });
    const rootObject = reconciler.reconcile(
      group("root", [mesh("m1", "box", "default"), mesh("m2", "box", "default")]),
      0,
    ) as THREE.Group;
    const sharedGeometry = (rootObject.children[0] as THREE.Mesh).geometry;
    const disposeSpy = vi.spyOn(sharedGeometry, "dispose");

    const afterRemoval = reconciler.reconcile(
      group("root", [mesh("m2", "box", "default")]),
      0,
    ) as THREE.Group;

    expect(disposeSpy).not.toHaveBeenCalled();
    const remainingMesh = afterRemoval.children[0] as THREE.Mesh;
    expect(remainingMesh.geometry).toBe(sharedGeometry);
  });
});

describe("createReconciler: frame-resolved camera Property<T> fields", () => {
  const fovTrack: KeyframeTrack<number> = {
    type: "keyframeTrack",
    keyframes: [
      { frame: 0, value: 40 },
      { frame: 100, value: 100 },
    ],
  };
  const targetTrack: KeyframeTrack<[number, number, number]> = {
    type: "keyframeTrack",
    keyframes: [
      { frame: 0, value: [0, 0, 0] },
      { frame: 100, value: [10, 0, 0] },
    ],
  };

  function animatedCamera(id: string): SceneNode {
    const node: CameraNode = {
      id,
      kind: "camera",
      transform: transformAt(),
      visible: true,
      children: [],
      fov: fovTrack,
      near: 0.1,
      far: 1000,
      target: targetTrack,
    };
    return node;
  }

  it("resolves a keyframed fov to the track's start value at frame 0", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(animatedCamera("root"), 0) as THREE.PerspectiveCamera;
    expect(result.fov).toBe(40);
  });

  it("resolves a keyframed fov to the linearly interpolated midpoint value at frame 50", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(animatedCamera("root"), 50) as THREE.PerspectiveCamera;
    expect(result.fov).toBe(70);
  });

  it("resolves a keyframed fov to the track's end value at frame 100", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(animatedCamera("root"), 100) as THREE.PerspectiveCamera;
    expect(result.fov).toBe(100);
  });

  it("resolves a keyframed target (a second animated field) via lookAt at each frame", () => {
    const lookAtSpy = vi.spyOn(THREE.Object3D.prototype, "lookAt");
    const reconciler = createReconciler();

    reconciler.reconcile(animatedCamera("root"), 0);
    expect(lookAtSpy).toHaveBeenLastCalledWith(0, 0, 0);

    reconciler.reconcile(animatedCamera("root"), 50);
    expect(lookAtSpy).toHaveBeenLastCalledWith(5, 0, 0);

    reconciler.reconcile(animatedCamera("root"), 100);
    expect(lookAtSpy).toHaveBeenLastCalledWith(10, 0, 0);

    lookAtSpy.mockRestore();
  });

  it("re-resolves the same live Object3D in place across frames, rather than creating a new one", () => {
    const reconciler = createReconciler();
    const first = reconciler.reconcile(animatedCamera("root"), 0) as THREE.PerspectiveCamera;
    const second = reconciler.reconcile(animatedCamera("root"), 50) as THREE.PerspectiveCamera;
    expect(second).toBe(first);
    expect(second.fov).toBe(70);
  });

  it("still applies a plain, non-keyframed near/far unaffected by frame", () => {
    const reconciler = createReconciler();
    const atFrame0 = reconciler.reconcile(animatedCamera("root"), 0) as THREE.PerspectiveCamera;
    const atFrame50 = reconciler.reconcile(animatedCamera("root"), 50) as THREE.PerspectiveCamera;
    expect(atFrame0.near).toBe(0.1);
    expect(atFrame0.far).toBe(1000);
    expect(atFrame50.near).toBe(0.1);
    expect(atFrame50.far).toBe(1000);
  });
});

describe("createReconciler: object3D.name is tagged with the originating SceneNode.id", () => {
  it("tags every reconciled object3D's .name with its SceneNode.id, at every depth", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(
      group("root", [mesh("m1"), camera("cam-1")]),
      0,
    ) as THREE.Group;

    expect(rootObject.name).toBe("root");
    expect(rootObject.children[0]?.name).toBe("m1");
    expect(rootObject.children[1]?.name).toBe("cam-1");
  });

  it("keeps the .name tag stable across reconcile calls that update the same node in place", () => {
    const reconciler = createReconciler();
    reconciler.reconcile(camera("cam-1", { fov: 50 }), 0);
    const updated = reconciler.reconcile(camera("cam-1", { fov: 75 }), 0);

    expect(updated?.name).toBe("cam-1");
  });

  it("lets a camera be found by id via .traverse(), matching on .name", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(
      group("root", [mesh("m1"), camera("the-camera")]),
      0,
    ) as THREE.Group;

    let found: THREE.Object3D | undefined;
    rootObject.traverse((object3D) => {
      if (object3D.name === "the-camera") {
        found = object3D;
      }
    });

    expect(found).toBeInstanceOf(THREE.PerspectiveCamera);
  });
});

describe("createReconciler: incremental build matches a single fresh build structurally", () => {
  it("produces a structurally identical tree via incremental steps vs. a single reconcile from null", () => {
    const incremental = createReconciler();
    incremental.reconcile(group("root", [group("a")]), 0);
    incremental.reconcile(group("root", [group("a"), mesh("b", "sphere", "wireframe")]), 0);
    const finalTree = group("root", [
      mesh("b", "sphere", "wireframe", { transform: transformAt([1, 1, 1]) }),
      light("c", "directional", { intensity: 2 }),
      camera("d", { fov: 70, target: [0, 1, 0] }),
    ]);
    const incrementalResult = incremental.reconcile(finalTree, 0) as THREE.Group;

    const freshResult = createReconciler().reconcile(finalTree, 0) as THREE.Group;

    expect(structuralSnapshot(incrementalResult)).toEqual(structuralSnapshot(freshResult));
  });
});

/** A plain-data snapshot of an Object3D subtree's shape, for structural (not identity) comparison. */
function structuralSnapshot(object3D: THREE.Object3D): unknown {
  return {
    type: object3D.type,
    position: object3D.position.toArray(),
    rotation: [object3D.rotation.x, object3D.rotation.y, object3D.rotation.z],
    scale: object3D.scale.toArray(),
    visible: object3D.visible,
    children: object3D.children.map(structuralSnapshot),
  };
}
