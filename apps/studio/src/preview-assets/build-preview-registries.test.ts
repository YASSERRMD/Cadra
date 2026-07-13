import type { Composition } from "@cadra/core";
import { Camera, createComposition, createProject, Image, Model, Sequence, Video } from "@cadra/core";
import { describe, expect, it, vi } from "vitest";

import { buildPreviewRegistries } from "./build-preview-registries.js";

const FPS = 30;

/** Checks `value` is a real `THREE.DataTexture`/`Data3DTexture`-shaped object without importing `three` directly - `apps/studio` depends on it only transitively (via `@cadra/renderer`), matching `Viewport.test.tsx`'s own restraint. `isDataTexture`/`isData3DTexture` are three.js's own standard instance-marker booleans. */
function isThreeTexture(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as { isDataTexture?: boolean }).isDataTexture === true ||
      (value as { isData3DTexture?: boolean }).isData3DTexture === true)
  );
}

function buildComposition(overrides: Partial<Composition> & { id: string }): Composition {
  return {
    ...createComposition({ id: overrides.id, name: overrides.id, fps: FPS, durationInFrames: 10, width: 64, height: 64 }),
    ...overrides,
  };
}

/** Mirrors `packages/renderer/src/environment/hdr-environment-loader.test.ts`'s own minimal fixture exactly: a real, hand-built, minimal Radiance HDR file. */
function buildMinimalHdrBytes(): Uint8Array {
  const header = "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 2\n";
  const headerBytes = new TextEncoder().encode(header);
  const pixelBytes = new Uint8Array([128, 0, 0, 128, 0, 128, 0, 128, 0, 0, 128, 128, 0, 0, 0, 0]);
  const bytes = new Uint8Array(headerBytes.length + pixelBytes.length);
  bytes.set(headerBytes, 0);
  bytes.set(pixelBytes, headerBytes.length);
  return bytes;
}

/** Mirrors `packages/renderer/src/lut/lut-file-loader.test.ts`'s own minimal fixture exactly: a real, hand-written, minimal 2x2x2 identity `.cube` file, UTF-8 encoded (this module decodes LUT bytes via `TextDecoder` before parsing). */
function buildMinimalCubeBytes(): Uint8Array {
  const text = [
    "TITLE \"Identity\"",
    "LUT_3D_SIZE 2",
    "0.0 0.0 0.0",
    "1.0 0.0 0.0",
    "0.0 1.0 0.0",
    "1.0 1.0 0.0",
    "0.0 0.0 1.0",
    "1.0 0.0 1.0",
    "0.0 1.0 1.0",
    "1.0 1.0 1.0",
    "",
  ].join("\n");
  return new TextEncoder().encode(text);
}

describe("buildPreviewRegistries", () => {
  it("resolves synchronously and never calls fetchBytes for a project with no asset-referencing nodes at all", () => {
    const composition = buildComposition({
      id: "comp-1",
      tracks: [{ id: "t1", clips: [Sequence({ id: "c1", from: 0, durationInFrames: 10, content: Camera({ id: "camera-1" }) })] }],
    });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });
    const fetchBytes = vi.fn();
    const onAssetReady = vi.fn();

    const registries = buildPreviewRegistries(project, FPS, onAssetReady, fetchBytes);

    expect(fetchBytes).not.toHaveBeenCalled();
    expect(registries.createRendererOptions.textureRegistry).toBeDefined();
    expect(registries.createRendererOptions.modelRegistry).toBeDefined();
    expect(registries.createRendererOptions.videoFrameRegistry).toBeUndefined();
    expect(registries.resolveAudioBuffer).toBeUndefined();
    expect(registries.decodeVideoFrame).toBeUndefined();
    expect(() => registries.dispose()).not.toThrow();
  });

  it("resolves a real environment asset in the background and calls onAssetReady once it does, without ever disturbing the built-in refs", async () => {
    const composition = buildComposition({ id: "comp-1", tracks: [], environment: { envMapRef: "cadra-asset://env-hash" } });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });
    const fetchBytes = vi.fn(async (ref: string) => {
      expect(ref).toBe("cadra-asset://env-hash");
      return buildMinimalHdrBytes();
    });
    const onAssetReady = vi.fn();

    const registries = buildPreviewRegistries(project, FPS, onAssetReady, fetchBytes);
    const environmentRegistry = registries.createRendererOptions.environmentRegistry!;

    // Not yet resolved synchronously: this module's whole point is that it
    // returns before any fetch has actually completed.
    expect(environmentRegistry.resolve("cadra-asset://env-hash")).toBeUndefined();
    // The two built-ins remain resolvable throughout, with no fetch of their own.
    expect(isThreeTexture(environmentRegistry.resolve("studio"))).toBe(true);

    await vi.waitFor(() => expect(onAssetReady).toHaveBeenCalledTimes(1));

    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(isThreeTexture(environmentRegistry.resolve("cadra-asset://env-hash"))).toBe(true);
  });

  it("never fetches a built-in environment/LUT ref (e.g. \"studio\"), since it already resolves via the default registry", async () => {
    const composition = buildComposition({
      id: "comp-1",
      tracks: [],
      environment: { envMapRef: "studio" },
      postProcessing: { effects: [{ type: "lut", lutRef: "warm", intensity: 1 }] },
    });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });
    const fetchBytes = vi.fn();
    const onAssetReady = vi.fn();

    buildPreviewRegistries(project, FPS, onAssetReady, fetchBytes);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchBytes).not.toHaveBeenCalled();
    expect(onAssetReady).not.toHaveBeenCalled();
  });

  it("resolves a real LUT asset in the background and calls onAssetReady once it does", async () => {
    const composition = buildComposition({
      id: "comp-1",
      tracks: [],
      postProcessing: { effects: [{ type: "lut", lutRef: "cadra-asset://lut-hash", intensity: 1 }] },
    });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });
    const fetchBytes = vi.fn(async () => buildMinimalCubeBytes());
    const onAssetReady = vi.fn();

    const registries = buildPreviewRegistries(project, FPS, onAssetReady, fetchBytes);
    const lutRegistry = registries.createRendererOptions.lutRegistry!;

    expect(lutRegistry.resolve("cadra-asset://lut-hash")).toBeUndefined();
    await vi.waitFor(() => expect(onAssetReady).toHaveBeenCalledTimes(1));
    expect(isThreeTexture(lutRegistry.resolve("cadra-asset://lut-hash"))).toBe(true);
  });

  it("catches a failed image fetch, logs it, and never calls onAssetReady for that asset", async () => {
    const composition = buildComposition({
      id: "comp-1",
      tracks: [
        {
          id: "t1",
          clips: [Sequence({ id: "c1", from: 0, durationInFrames: 10, content: Image({ id: "image-1", assetRef: "cadra-asset://broken-image" }) })],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });
    const fetchBytes = vi.fn(async () => {
      throw new Error("simulated network failure");
    });
    const onAssetReady = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const registries = buildPreviewRegistries(project, FPS, onAssetReady, fetchBytes);
    await vi.waitFor(() => expect(fetchBytes).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onAssetReady).not.toHaveBeenCalled();
    expect(registries.createRendererOptions.textureRegistry!.resolve("cadra-asset://broken-image")).toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("image"), expect.any(Error));

    consoleError.mockRestore();
  });

  it("catches a failed model fetch without throwing out of the background task", async () => {
    const composition = buildComposition({
      id: "comp-1",
      tracks: [
        {
          id: "t1",
          clips: [Sequence({ id: "c1", from: 0, durationInFrames: 10, content: Model({ id: "model-1", assetRef: "cadra-asset://broken-model" }) })],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });
    const fetchBytes = vi.fn(async () => {
      throw new Error("simulated network failure");
    });
    const onAssetReady = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const registries = buildPreviewRegistries(project, FPS, onAssetReady, fetchBytes);
    await vi.waitFor(() => expect(fetchBytes).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onAssetReady).not.toHaveBeenCalled();
    expect(registries.createRendererOptions.modelRegistry!.resolve("cadra-asset://broken-model")).toBeUndefined();

    consoleError.mockRestore();
  });

  it("supplies a videoFrameRegistry and decodeVideoFrame only when the project actually references a VideoNode", () => {
    const withVideo = buildComposition({
      id: "comp-1",
      tracks: [
        {
          id: "t1",
          clips: [Sequence({ id: "c1", from: 0, durationInFrames: 10, content: Video({ id: "video-1", assetRef: "cadra-asset://v" }) })],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "P", compositions: [withVideo] });

    const registries = buildPreviewRegistries(project, FPS, vi.fn(), vi.fn());

    expect(registries.createRendererOptions.videoFrameRegistry).toBeDefined();
    expect(registries.decodeVideoFrame).toBeDefined();
    expect(() => registries.dispose()).not.toThrow();
  });

  it("dispose() is safe to call immediately, before any background fetch has settled", () => {
    const composition = buildComposition({
      id: "comp-1",
      tracks: [
        {
          id: "t1",
          clips: [Sequence({ id: "c1", from: 0, durationInFrames: 10, content: Video({ id: "video-1", assetRef: "cadra-asset://v" }) })],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });
    const fetchBytes = vi.fn(() => new Promise<Uint8Array>(() => {
      // Never resolves: exercises dispose() racing an in-flight fetch.
    }));

    const registries = buildPreviewRegistries(project, FPS, vi.fn(), fetchBytes);

    expect(() => registries.dispose()).not.toThrow();
  });

  it("calls onAssetReady once per successful asset, not coalesced into a single call", async () => {
    const composition = buildComposition({
      id: "comp-1",
      tracks: [],
      environment: { envMapRef: "cadra-asset://env-hash" },
      postProcessing: { effects: [{ type: "lut", lutRef: "cadra-asset://lut-hash", intensity: 1 }] },
    });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });
    const fetchBytes = vi.fn(async (ref: string) =>
      ref === "cadra-asset://env-hash" ? buildMinimalHdrBytes() : buildMinimalCubeBytes(),
    );
    const onAssetReady = vi.fn();

    const registries = buildPreviewRegistries(project, FPS, onAssetReady, fetchBytes);

    await vi.waitFor(() => expect(onAssetReady).toHaveBeenCalledTimes(2));

    expect(isThreeTexture(registries.createRendererOptions.environmentRegistry!.resolve("cadra-asset://env-hash"))).toBe(
      true,
    );
    expect(isThreeTexture(registries.createRendererOptions.lutRegistry!.resolve("cadra-asset://lut-hash"))).toBe(true);
  });

  it("never calls onAssetReady for any asset that failed to load", async () => {
    const composition = buildComposition({
      id: "comp-1",
      tracks: [],
      environment: { envMapRef: "cadra-asset://env-hash" },
      postProcessing: { effects: [{ type: "lut", lutRef: "cadra-asset://lut-hash", intensity: 1 }] },
    });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });
    const fetchBytes = vi.fn(async () => {
      throw new Error("simulated network failure");
    });
    const onAssetReady = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    buildPreviewRegistries(project, FPS, onAssetReady, fetchBytes);
    await vi.waitFor(() => expect(fetchBytes).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onAssetReady).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("re-fetches fresh on a second, independent call for the same ref - each call builds its own independent registries", async () => {
    const composition = buildComposition({ id: "comp-1", tracks: [], environment: { envMapRef: "cadra-asset://env-hash" } });
    const project = createProject({ id: "p1", name: "P", compositions: [composition] });
    const fetchBytes = vi.fn(async () => buildMinimalHdrBytes());

    const firstOnAssetReady = vi.fn();
    buildPreviewRegistries(project, FPS, firstOnAssetReady, fetchBytes);
    await vi.waitFor(() => expect(firstOnAssetReady).toHaveBeenCalledTimes(1));

    // A second, entirely fresh call for the exact same ref (mirroring a
    // `Viewport.tsx` remount, e.g. a document/composition switch): this
    // module keeps no memory of past calls, so it fetches and notifies
    // again, exactly as any other fresh call would.
    const secondOnAssetReady = vi.fn();
    const registries = buildPreviewRegistries(project, FPS, secondOnAssetReady, fetchBytes);
    await vi.waitFor(() => expect(secondOnAssetReady).toHaveBeenCalledTimes(1));

    expect(fetchBytes).toHaveBeenCalledTimes(2);
    expect(isThreeTexture(registries.createRendererOptions.environmentRegistry!.resolve("cadra-asset://env-hash"))).toBe(
      true,
    );
  });
});
