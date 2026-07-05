import { describe, expect, it, vi } from "vitest";

import type { DecodeImage, LoadImageDependencies } from "./image-loader.js";
import { loadImage } from "./image-loader.js";

/** A fake decoded image resource, standing in for a real `ImageBitmap`. */
function createFakeImageBitmap(label: string): ImageBitmap {
  return { label } as unknown as ImageBitmap;
}

function createFakeDeps(bytes: Uint8Array, decoded: ImageBitmap): LoadImageDependencies {
  return {
    fetchBytes: vi.fn().mockResolvedValue(bytes),
    decodeImage: vi.fn().mockResolvedValue(decoded) as unknown as DecodeImage,
  };
}

describe("loadImage", () => {
  it("fetches bytes, then decodes them, in that order", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const decoded = createFakeImageBitmap("decoded");
    const callOrder: string[] = [];
    const deps: LoadImageDependencies = {
      fetchBytes: vi.fn(async () => {
        callOrder.push("fetchBytes");
        return bytes;
      }),
      decodeImage: vi.fn(async () => {
        callOrder.push("decodeImage");
        return decoded;
      }) as unknown as DecodeImage,
    };

    await loadImage("https://example.test/a.png", deps);

    expect(callOrder).toEqual(["fetchBytes", "decodeImage"]);
  });

  it("passes the fetched bytes through to decodeImage unchanged", async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const deps = createFakeDeps(bytes, createFakeImageBitmap("decoded"));

    await loadImage("https://example.test/a.png", deps);

    expect(deps.decodeImage).toHaveBeenCalledWith(bytes);
  });

  it("calls fetchBytes with the given url", async () => {
    const deps = createFakeDeps(new Uint8Array([1]), createFakeImageBitmap("decoded"));

    await loadImage("https://example.test/specific-url.png", deps);

    expect(deps.fetchBytes).toHaveBeenCalledWith("https://example.test/specific-url.png");
  });

  it("returns the decoded image alongside a content hash of the fetched bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const decoded = createFakeImageBitmap("decoded");
    const deps = createFakeDeps(bytes, decoded);

    const result = await loadImage("https://example.test/a.png", deps);

    expect(result.image).toBe(decoded);
    expect(typeof result.hash).toBe("string");
    expect(result.hash.length).toBeGreaterThan(0);
  });

  it("produces the same hash for two loads of byte-identical content", async () => {
    const bytesA = new Uint8Array([5, 5, 5]);
    const bytesB = new Uint8Array([5, 5, 5]);
    const depsA = createFakeDeps(bytesA, createFakeImageBitmap("a"));
    const depsB = createFakeDeps(bytesB, createFakeImageBitmap("b"));

    const resultA = await loadImage("https://example.test/a.png", depsA);
    const resultB = await loadImage("https://example.test/b.png", depsB);

    expect(resultA.hash).toBe(resultB.hash);
  });

  it("propagates a fetchBytes rejection without calling decodeImage", async () => {
    const failure = new Error("network error");
    const decodeImage = vi.fn() as unknown as DecodeImage;
    const deps: LoadImageDependencies = {
      fetchBytes: vi.fn().mockRejectedValue(failure),
      decodeImage,
    };

    await expect(loadImage("https://example.test/a.png", deps)).rejects.toThrow(failure);
    expect(decodeImage).not.toHaveBeenCalled();
  });

  it("propagates a decodeImage rejection", async () => {
    const failure = new Error("corrupt image data");
    const deps: LoadImageDependencies = {
      fetchBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
      decodeImage: vi.fn().mockRejectedValue(failure) as unknown as DecodeImage,
    };

    await expect(loadImage("https://example.test/a.png", deps)).rejects.toThrow(failure);
  });
});
