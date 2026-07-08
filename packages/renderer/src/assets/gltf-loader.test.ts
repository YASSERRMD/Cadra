import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GltfAsset, LoadGltfDependencies, ParseGltf } from "./gltf-loader.js";
import { createDefaultParseGltf, loadGltf } from "./gltf-loader.js";
import type { LoadedModel } from "./model-registry.js";

function createFakeGltfAsset(label: string): GltfAsset {
  return { label };
}

describe("loadGltf", () => {
  it("fetches bytes, then parses them into a model resource", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const model = createFakeGltfAsset("parsed-model");
    const callOrder: string[] = [];
    const deps: LoadGltfDependencies = {
      fetchBytes: vi.fn(async () => {
        callOrder.push("fetchBytes");
        return bytes;
      }),
      parseGltf: vi.fn(async () => {
        callOrder.push("parseGltf");
        return model;
      }) as unknown as ParseGltf,
    };

    const result = await loadGltf("https://example.test/model.glb", deps);

    expect(callOrder).toEqual(["fetchBytes", "parseGltf"]);
    expect(result.model).toBe(model);
    expect(typeof result.hash).toBe("string");
  });

  it("produces the same hash for byte-identical GLTF content", async () => {
    const bytes = new Uint8Array([3, 1, 4, 1, 5]);
    const depsA: LoadGltfDependencies = {
      fetchBytes: vi.fn().mockResolvedValue(bytes),
      parseGltf: vi.fn().mockResolvedValue(createFakeGltfAsset("a")) as unknown as ParseGltf,
    };
    const depsB: LoadGltfDependencies = {
      fetchBytes: vi.fn().mockResolvedValue(bytes),
      parseGltf: vi.fn().mockResolvedValue(createFakeGltfAsset("b")) as unknown as ParseGltf,
    };

    const resultA = await loadGltf("https://example.test/a.glb", depsA);
    const resultB = await loadGltf("https://example.test/b.glb", depsB);

    expect(resultA.hash).toBe(resultB.hash);
  });

  it("propagates a parseGltf rejection", async () => {
    const failure = new Error("malformed glb container");
    const deps: LoadGltfDependencies = {
      fetchBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
      parseGltf: vi.fn().mockRejectedValue(failure) as unknown as ParseGltf,
    };

    await expect(loadGltf("https://example.test/model.glb", deps)).rejects.toThrow(failure);
  });
});

/**
 * A minimal `FileReader` standing in for the real DOM one: `GLTFExporter`'s
 * own writer (`GLTFWriter.writeAsync`, this project's installed
 * `three@0.185.1` source) unconditionally reaches for a real `FileReader` to
 * turn its own merged `Blob` into either an `ArrayBuffer` (`.glb`, binary) or
 * a base64 data URL (`.gltf`, embedding a buffer inline) - a genuine DOM API
 * this headless Vitest/Node environment does not provide on its own. Node's
 * own `Blob` (global since Node 18) already has a real, working
 * `.arrayBuffer()`, so this just bridges that to the two `read*` methods/
 * `onloadend` callback shape `GLTFWriter` actually calls.
 */
class NodeFileReaderPolyfill {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;

  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      this.onloadend?.();
    });
  }

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      const base64 = Buffer.from(buffer).toString("base64");
      this.result = `data:${blob.type};base64,${base64}`;
      this.onloadend?.();
    });
  }
}

/**
 * Real, non-mocked coverage for `createDefaultParseGltf` (Phase 69): builds
 * a real `THREE.Mesh` via the plain `three` API, round-trips it through
 * `GLTFExporter`'s own `binary: true` mode (via `NodeFileReaderPolyfill`,
 * above) to get a genuine, self-contained `.glb` `ArrayBuffer` (no external
 * image/`.bin` references, so parsing it back needs no DOM `Image`/`fetch`/
 * `URL.createObjectURL`), then feeds those exact bytes through
 * `createDefaultParseGltf()`'s real `GLTFLoader`. This exercises the genuine
 * round trip end to end without needing an external `.glb` fixture file or a
 * real GLTF-authoring tool.
 */
describe("createDefaultParseGltf", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a real GLB (round-tripped through GLTFExporter) back into a usable mesh", async () => {
    vi.stubGlobal("FileReader", NodeFileReaderPolyfill);

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "TestBox";
    const scene = new THREE.Scene();
    scene.add(mesh);

    const glb = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
    const bytes = new Uint8Array(glb);

    const asset = (await createDefaultParseGltf()(bytes)) as LoadedModel;

    expect(asset.animations).toEqual([]);
    const parsedMesh = asset.scene.getObjectByName("TestBox");
    expect(parsedMesh).toBeInstanceOf(THREE.Mesh);
    expect((parsedMesh as THREE.Mesh).geometry.attributes.position?.count).toBe(
      geometry.attributes.position?.count,
    );
  });
});
