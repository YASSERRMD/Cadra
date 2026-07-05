import { describe, expect, it, vi } from "vitest";

import type { GltfAsset, LoadGltfDependencies, ParseGltf } from "./gltf-loader.js";
import { loadGltf } from "./gltf-loader.js";

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
