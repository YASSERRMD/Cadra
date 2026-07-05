import { describe, expect, it } from "vitest";

import { createInMemoryAssetRegistry } from "./asset-registry.js";

describe("createInMemoryAssetRegistry", () => {
  it("reports has() false and resolve() undefined for a hash never registered", () => {
    const registry = createInMemoryAssetRegistry<string>();

    expect(registry.has("unknown-hash")).toBe(false);
    expect(registry.resolve("unknown-hash")).toBeUndefined();
  });

  it("resolves a registered resource by its exact hash", () => {
    const registry = createInMemoryAssetRegistry<{ label: string }>();
    const resource = { label: "loaded-image" };

    registry.register("hash-a", resource);

    expect(registry.has("hash-a")).toBe(true);
    expect(registry.resolve("hash-a")).toBe(resource);
  });

  it("keeps distinct entries for distinct hashes", () => {
    const registry = createInMemoryAssetRegistry<number>();

    registry.register("hash-a", 1);
    registry.register("hash-b", 2);

    expect(registry.resolve("hash-a")).toBe(1);
    expect(registry.resolve("hash-b")).toBe(2);
  });

  it("replaces the previous entry when registering again under the same hash", () => {
    const registry = createInMemoryAssetRegistry<string>();

    registry.register("hash-a", "first");
    registry.register("hash-a", "second");

    expect(registry.resolve("hash-a")).toBe("second");
  });

  it("does not share state between two separately-constructed registries", () => {
    const registryA = createInMemoryAssetRegistry<string>();
    const registryB = createInMemoryAssetRegistry<string>();

    registryA.register("hash-a", "only-in-a");

    expect(registryA.has("hash-a")).toBe(true);
    expect(registryB.has("hash-a")).toBe(false);
  });
});
