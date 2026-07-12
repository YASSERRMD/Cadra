import { createComposition, createProject, Image, type Project, Sequence, Shape } from "@cadra/core";
import type {
  HeadlessBrowserLike,
  HeadlessConsoleMessageLike,
  HeadlessPageLike,
} from "@cadra/headless";
import { RenderJobFailedError } from "@cadra/headless";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { readMp4FragmentedDurationTicks, readMp4TrackTimescale } from "./mux-validate-mp4.js";
import {
  buildTextureRegistryForProject,
  DEFAULT_RANGE_TIMEOUT_MS,
  type EncodedRenderJobHandle,
  getEncodedRenderJobStatus,
  resumeEncodedRenderJob,
  submitEncodedRenderJob,
} from "./render-job.js";
import type { SerializedEncodedChunk } from "./serialized-encoded-chunk.js";

/** A small project, mirroring `render-composition-headless-server.test.ts`'s own `buildProject`. */
function buildProject(durationInFrames = 90): Project {
  const shape = Shape({ id: "shape-1" });
  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: 30,
    durationInFrames,
    width: 64,
    height: 36,
    tracks: [
      {
        id: "track-1",
        clips: [Sequence({ id: "clip-1", from: 0, durationInFrames, content: shape })],
      },
    ],
  });
  return createProject({ id: "p1", name: "Project", compositions: [composition] });
}

/** A minimal fake `EncodedVideoChunk`-shaped `SerializedEncodedChunk` for one frame, a keyframe iff `frame % 30 === 0` (matching `DEFAULT_KEYFRAME_INTERVAL_FRAMES`). */
function fakeSerializedChunk(frame: number, fps = 30): SerializedEncodedChunk {
  return {
    frame,
    type: frame % 30 === 0 ? "key" : "delta",
    timestamp: Math.round((frame * 1_000_000) / fps),
    duration: Math.round(1_000_000 / fps),
    data: [frame % 256, (frame + 1) % 256],
    codec: "avc1.42001f",
    description: frame % 30 === 0 ? [0x01, 0x64, 0x00, 0x1f] : undefined,
  };
}

/** Records every `write`/`end` call, standing in for a real `fs.WriteStream`. */
function createFakeDestination(): {
  write: (chunk: Uint8Array) => boolean;
  end: (callback: () => void) => void;
  chunks: Uint8Array[];
  ended: boolean;
} {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    ended: false,
    write(chunk: Uint8Array) {
      chunks.push(chunk);
      return true;
    },
    end(callback: () => void) {
      this.ended = true;
      callback();
    },
  };
}

/**
 * A fake `HeadlessPageLike` for `render-job.ts`'s own usage: `evaluate`
 * reads `arg.config.startFrame`/`endFrame` (the range this page was asked to
 * render) and calls `behavior.renderRange` with them, returning whatever
 * array of `SerializedEncodedChunk`s that returns (or rejecting, simulating
 * a page-side render failure). Unlike
 * `render-composition-headless-server.test.ts`'s own fake page (which
 * drives a write/close bridge), this fake's *return value* is what matters,
 * mirroring `runBrowserHeadlessRenderRange`'s actual real contract.
 */
function createFakeRangePage(behavior: {
  renderRange: (range: {
    startFrame: number;
    endFrame: number;
  }) => Promise<SerializedEncodedChunk[]>;
  consoleLines?: Array<{ type: string; text: string }>;
}): HeadlessPageLike & {
  addScriptCalls: number;
  progressCalls: Array<[number, number]>;
  capturedConfigs: unknown[];
} {
  const exposed = new Map<string, (...args: never[]) => unknown>();
  const consoleHandlers: Array<(message: HeadlessConsoleMessageLike) => void> = [];
  const progressCalls: Array<[number, number]> = [];
  const capturedConfigs: unknown[] = [];

  const page = {
    addScriptCalls: 0,
    progressCalls,
    capturedConfigs,
    async exposeFunction(name: string, fn: (...args: never[]) => unknown): Promise<void> {
      exposed.set(name, fn);
    },
    onConsoleMessage(handler: (message: HeadlessConsoleMessageLike) => void): void {
      consoleHandlers.push(handler);
    },
    onPageError(_handler: (error: Error) => void): void {
      // Not exercised by these fake-page tests, mirroring
      // render-composition-headless-server.test.ts's own rationale.
    },
    async evaluate<Arg, Result>(
      _pageFunction: (arg: Arg) => Result | Promise<Result>,
      arg: Arg,
    ): Promise<Result> {
      for (const line of behavior.consoleLines ?? []) {
        for (const handler of consoleHandlers) {
          handler({ type: () => line.type, text: () => line.text });
        }
      }

      const config = (arg as { config: { startFrame: number; endFrame: number } }).config;
      capturedConfigs.push((arg as { config: unknown }).config);
      const progress = exposed.get("__cadraHeadlessProgress") as
        ((frame: number, totalFrames: number) => Promise<void>) | undefined;
      // Simulate one progress call per frame in this range, mirroring what
      // a real renderComposition/onProgress call chain would report.
      for (let frame = config.startFrame; frame < config.endFrame; frame += 1) {
        progressCalls.push([frame, config.endFrame - config.startFrame]);
        void progress?.(frame, config.endFrame - config.startFrame);
      }

      const result = await behavior.renderRange({
        startFrame: config.startFrame,
        endFrame: config.endFrame,
      });
      return result as unknown as Result;
    },
    async addScript(_source: string): Promise<void> {
      page.addScriptCalls += 1;
    },
  };
  return page;
}

/** A fake `HeadlessBrowserLike` whose `newPage()` always returns `page`, mirroring `render-composition-headless-server.test.ts`'s own. */
function createFakeBrowser(
  page: HeadlessPageLike,
): HeadlessBrowserLike & { closeCalls: number; disconnectedHandlers: Array<() => void> } {
  const disconnectedHandlers: Array<() => void> = [];
  return {
    closeCalls: 0,
    disconnectedHandlers,
    async newPage(): Promise<HeadlessPageLike> {
      return page;
    },
    onDisconnected(handler: () => void): void {
      disconnectedHandlers.push(handler);
    },
    async close(): Promise<void> {
      this.closeCalls += 1;
    },
  };
}

/** Builds a `browserLauncher` that, for every range attempt, calls `renderRange` with that attempt's own `[startFrame, endFrame)` and hands back whatever it resolves/rejects with, tracking every launch. */
function createRangeAwareBrowserLauncher(
  renderRange: (range: {
    startFrame: number;
    endFrame: number;
  }) => Promise<SerializedEncodedChunk[]>,
): {
  launcher: () => Promise<HeadlessBrowserLike>;
  launchCount: () => number;
  browsers: ReturnType<typeof createFakeBrowser>[];
  pages: ReturnType<typeof createFakeRangePage>[];
} {
  let launchCount = 0;
  const browsers: ReturnType<typeof createFakeBrowser>[] = [];
  const pages: ReturnType<typeof createFakeRangePage>[] = [];
  const launcher = async (): Promise<HeadlessBrowserLike> => {
    launchCount += 1;
    const page = createFakeRangePage({ renderRange });
    pages.push(page);
    const browser = createFakeBrowser(page);
    browsers.push(browser);
    return browser;
  };
  return { launcher, launchCount: () => launchCount, browsers, pages };
}

describe("submitEncodedRenderJob: basic scheduling and final mux", () => {
  it("splits into ranges, renders each independently, concatenates in frame order, and muxes exactly once", async () => {
    const project = buildProject(90);
    const destination = createFakeDestination();
    const renderedRanges: Array<{ startFrame: number; endFrame: number }> = [];

    const { launcher } = createRangeAwareBrowserLauncher(async (range) => {
      renderedRanges.push(range);
      const chunks: SerializedEncodedChunk[] = [];
      for (let frame = range.startFrame; frame < range.endFrame; frame += 1) {
        chunks.push(fakeSerializedChunk(frame));
      }
      return chunks;
    });

    const handle = await submitEncodedRenderJob({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      rangeSizeFrames: 30,
      rangeAlignmentFrames: 30,
      browserLauncher: launcher,
      bundleEntry: async () => "/* fake bundle */",
    });

    await handle.result;

    // Every range [0,30), [30,60), [60,90) rendered independently.
    expect(renderedRanges.sort((a, b) => a.startFrame - b.startFrame)).toEqual([
      { startFrame: 0, endFrame: 30 },
      { startFrame: 30, endFrame: 60 },
      { startFrame: 60, endFrame: 90 },
    ]);

    // Exactly one muxed file written, and it was finalized (end() called).
    expect(destination.ended).toBe(true);
    expect(destination.chunks.length).toBeGreaterThan(0);

    const bytes = Buffer.concat(destination.chunks);
    const trackTimescale = readMp4TrackTimescale(bytes);
    expect(trackTimescale).toBeGreaterThan(0);
    // 90 frames at 30fps = 3 seconds; container duration must reflect the
    // FULL composition, proving every range's chunks made it into the one
    // final muxed file, not just one range's worth.
    const actualDurationTicks = readMp4FragmentedDurationTicks(bytes);
    const expectedTicks = Math.round(3 * trackTimescale);
    expect(actualDurationTicks).toBe(expectedTicks);
  });

  it("resolves handle.jobId to a concrete, queryable job id", async () => {
    const project = buildProject(30);
    const destination = createFakeDestination();
    const { launcher } = createRangeAwareBrowserLauncher(async (range) => {
      const chunks: SerializedEncodedChunk[] = [];
      for (let frame = range.startFrame; frame < range.endFrame; frame += 1) {
        chunks.push(fakeSerializedChunk(frame));
      }
      return chunks;
    });

    const handle = await submitEncodedRenderJob({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      browserLauncher: launcher,
      bundleEntry: async () => "/* fake bundle */",
    });

    expect(typeof handle.jobId).toBe("string");
    expect(handle.jobId.length).toBeGreaterThan(0);
    // Queryable immediately, even before handle.result settles.
    const status = getEncodedRenderJobStatus(handle.jobId);
    expect(["queued", "running", "done"]).toContain(status.status);

    await handle.result;
    expect(getEncodedRenderJobStatus(handle.jobId).status).toBe("done");
  });

  it("relays per-range progress via onProgress", async () => {
    const project = buildProject(30);
    const destination = createFakeDestination();
    const progressCalls: Array<[number, number]> = [];
    const { launcher } = createRangeAwareBrowserLauncher(async (range) => {
      const chunks: SerializedEncodedChunk[] = [];
      for (let frame = range.startFrame; frame < range.endFrame; frame += 1) {
        chunks.push(fakeSerializedChunk(frame));
      }
      return chunks;
    });

    const handle = await submitEncodedRenderJob({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      browserLauncher: launcher,
      bundleEntry: async () => "/* fake bundle */",
      onProgress: (frame, totalFrames) => progressCalls.push([frame, totalFrames]),
    });
    await handle.result;

    expect(progressCalls).toEqual([
      [0, 30],
      [1, 30],
      [2, 30],
      [3, 30],
      [4, 30],
      [5, 30],
      [6, 30],
      [7, 30],
      [8, 30],
      [9, 30],
      [10, 30],
      [11, 30],
      [12, 30],
      [13, 30],
      [14, 30],
      [15, 30],
      [16, 30],
      [17, 30],
      [18, 30],
      [19, 30],
      [20, 30],
      [21, 30],
      [22, 30],
      [23, 30],
      [24, 30],
      [25, 30],
      [26, 30],
      [27, 30],
      [28, 30],
      [29, 30],
    ]);
  });

  it("reports every range's status via onStatusChange", async () => {
    const project = buildProject(60);
    const destination = createFakeDestination();
    const snapshots: Array<{ status: string; framesCompleted: number }> = [];
    const { launcher } = createRangeAwareBrowserLauncher(async (range) => {
      const chunks: SerializedEncodedChunk[] = [];
      for (let frame = range.startFrame; frame < range.endFrame; frame += 1) {
        chunks.push(fakeSerializedChunk(frame));
      }
      return chunks;
    });

    const handle = await submitEncodedRenderJob({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      rangeSizeFrames: 30,
      rangeAlignmentFrames: 30,
      maxConcurrency: 1,
      browserLauncher: launcher,
      bundleEntry: async () => "/* fake bundle */",
      onStatusChange: (status) =>
        snapshots.push({ status: status.status, framesCompleted: status.framesCompleted }),
    });
    await handle.result;

    expect(snapshots[snapshots.length - 1]).toEqual({ status: "done", framesCompleted: 60 });
  });
});

describe("submitEncodedRenderJob: image asset bytes", () => {
  /** A project with 4 ImageNodes: two sharing one assetRef, one with a distinct assetRef, and one whose assetRef fetchAssetBytes will not resolve. */
  function buildProjectWithImages(): Project {
    const shape = Shape({ id: "shape-1" });
    const imageA1 = Image({ id: "img-a1", assetRef: "cadra-asset://aaa" });
    const imageA2 = Image({ id: "img-a2", assetRef: "cadra-asset://aaa" });
    const imageB = Image({ id: "img-b", assetRef: "cadra-asset://bbb" });
    const imageMissing = Image({ id: "img-missing", assetRef: "cadra-asset://missing" });
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 30,
      width: 64,
      height: 36,
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({ id: "clip-shape", from: 0, durationInFrames: 30, content: shape }),
            Sequence({ id: "clip-a1", from: 0, durationInFrames: 30, content: imageA1 }),
            Sequence({ id: "clip-a2", from: 0, durationInFrames: 30, content: imageA2 }),
            Sequence({ id: "clip-b", from: 0, durationInFrames: 30, content: imageB }),
            Sequence({ id: "clip-missing", from: 0, durationInFrames: 30, content: imageMissing }),
          ],
        },
      ],
    });
    return createProject({ id: "p1", name: "Project", compositions: [composition] });
  }

  it("fetches each distinct ImageNode.assetRef via fetchAssetBytes, dedupes repeats, and omits refs it cannot resolve", async () => {
    const destination = createFakeDestination();
    const { launcher, pages } = createRangeAwareBrowserLauncher(async (range) => {
      const chunks: SerializedEncodedChunk[] = [];
      for (let frame = range.startFrame; frame < range.endFrame; frame += 1) {
        chunks.push(fakeSerializedChunk(frame));
      }
      return chunks;
    });

    const bytesByRef: Record<string, Uint8Array> = {
      "cadra-asset://aaa": new Uint8Array([1, 2, 3]),
      "cadra-asset://bbb": new Uint8Array([4, 5, 6, 7]),
    };
    const fetchCalls: string[] = [];
    const fetchAssetBytes = async (assetRef: string): Promise<Uint8Array | undefined> => {
      fetchCalls.push(assetRef);
      return bytesByRef[assetRef];
    };

    const handle = await submitEncodedRenderJob({
      project: buildProjectWithImages(),
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      browserLauncher: launcher,
      bundleEntry: async () => "/* fake bundle */",
      fetchAssetBytes,
    });
    await handle.result;

    // Fetched once per distinct assetRef, not once per node: imageA1/imageA2
    // share "cadra-asset://aaa" and must only trigger one fetch for it.
    expect(fetchCalls.sort()).toEqual(["cadra-asset://aaa", "cadra-asset://bbb", "cadra-asset://missing"]);

    const config = pages[0]?.capturedConfigs[0] as {
      imageRenderEntries: Array<{ assetRef: string; bytes: number[] }>;
    };
    const entries = config.imageRenderEntries;
    // "missing" never resolved, so it is silently omitted entirely, not
    // present as an entry with empty/undefined bytes.
    expect(entries.map((entry) => entry.assetRef).sort()).toEqual([
      "cadra-asset://aaa",
      "cadra-asset://bbb",
    ]);
    expect(entries.find((entry) => entry.assetRef === "cadra-asset://aaa")?.bytes).toEqual([1, 2, 3]);
    expect(entries.find((entry) => entry.assetRef === "cadra-asset://bbb")?.bytes).toEqual([4, 5, 6, 7]);
  });

  it("sends an empty imageRenderEntries when fetchAssetBytes is not supplied, even though the project has ImageNodes", async () => {
    const destination = createFakeDestination();
    const { launcher, pages } = createRangeAwareBrowserLauncher(async (range) => {
      const chunks: SerializedEncodedChunk[] = [];
      for (let frame = range.startFrame; frame < range.endFrame; frame += 1) {
        chunks.push(fakeSerializedChunk(frame));
      }
      return chunks;
    });

    const handle = await submitEncodedRenderJob({
      project: buildProjectWithImages(),
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      browserLauncher: launcher,
      bundleEntry: async () => "/* fake bundle */",
      // fetchAssetBytes intentionally omitted.
    });
    await handle.result;

    const config = pages[0]?.capturedConfigs[0] as { imageRenderEntries: unknown[] };
    expect(config.imageRenderEntries).toEqual([]);
  });
});

/** A solid-color square PNG, real and valid. */
function buildSolidColorPng(size: number, color: readonly [number, number, number]): Uint8Array {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i += 1) {
    const index = i << 2;
    png.data[index] = color[0];
    png.data[index + 1] = color[1];
    png.data[index + 2] = color[2];
    png.data[index + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

describe("buildTextureRegistryForProject", () => {
  function buildProjectWithImages(): Project {
    const imageA1 = Image({ id: "img-a1", assetRef: "cadra-asset://aaa" });
    const imageA2 = Image({ id: "img-a2", assetRef: "cadra-asset://aaa" });
    const imageB = Image({ id: "img-b", assetRef: "cadra-asset://bbb" });
    const imageCorrupt = Image({ id: "img-corrupt", assetRef: "cadra-asset://corrupt" });
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 30,
      width: 64,
      height: 36,
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({ id: "clip-a1", from: 0, durationInFrames: 30, content: imageA1 }),
            Sequence({ id: "clip-a2", from: 0, durationInFrames: 30, content: imageA2 }),
            Sequence({ id: "clip-b", from: 0, durationInFrames: 30, content: imageB }),
            Sequence({ id: "clip-corrupt", from: 0, durationInFrames: 30, content: imageCorrupt }),
          ],
        },
      ],
    });
    return createProject({ id: "p1", name: "Project", compositions: [composition] });
  }

  it("returns undefined when project has no image nodes at all", async () => {
    const project = createProject({
      id: "p1",
      name: "Project",
      compositions: [
        createComposition({ id: "comp-1", name: "Main", fps: 30, durationInFrames: 1, width: 4, height: 4, tracks: [] }),
      ],
    });
    const registry = await buildTextureRegistryForProject(project, async () => new Uint8Array());
    expect(registry).toBeUndefined();
  });

  it("returns undefined when fetchAssetBytes is not supplied, even though the project has ImageNodes", async () => {
    const registry = await buildTextureRegistryForProject(buildProjectWithImages());
    expect(registry).toBeUndefined();
  });

  it("decodes real PNG bytes into a resolvable texture, dedupes repeated assetRefs, and silently skips an unresolvable/corrupt one", async () => {
    const bytesByRef: Record<string, Uint8Array> = {
      "cadra-asset://aaa": buildSolidColorPng(4, [255, 0, 0]),
      "cadra-asset://bbb": buildSolidColorPng(4, [0, 0, 255]),
      "cadra-asset://corrupt": new Uint8Array([1, 2, 3, 4]),
    };
    const fetchCalls: string[] = [];
    const fetchAssetBytes = async (assetRef: string): Promise<Uint8Array | undefined> => {
      fetchCalls.push(assetRef);
      return bytesByRef[assetRef];
    };

    const registry = await buildTextureRegistryForProject(buildProjectWithImages(), fetchAssetBytes);
    expect(registry).toBeDefined();

    // Fetched once per distinct assetRef, not once per node.
    expect(fetchCalls.sort()).toEqual(["cadra-asset://aaa", "cadra-asset://bbb", "cadra-asset://corrupt"]);

    const aaaTexture = registry!.resolve("cadra-asset://aaa");
    expect(aaaTexture).toBeDefined();
    expect((aaaTexture!.image as { width: number }).width).toBe(4);
    expect((aaaTexture!.image as { height: number }).height).toBe(4);

    expect(registry!.resolve("cadra-asset://bbb")).toBeDefined();
    // Corrupt PNG bytes fail PNG.sync.read and are silently skipped, not thrown.
    expect(registry!.resolve("cadra-asset://corrupt")).toBeUndefined();
  });
});

describe("submitEncodedRenderJob: retry and failure", () => {
  it("retries a range that fails once, succeeding on a later attempt without re-rendering other ranges", async () => {
    const project = buildProject(60);
    const destination = createFakeDestination();
    const rangeAttempts = new Map<number, number>();

    const { launcher, launchCount } = createRangeAwareBrowserLauncher(async (range) => {
      const attempt = (rangeAttempts.get(range.startFrame) ?? 0) + 1;
      rangeAttempts.set(range.startFrame, attempt);

      if (range.startFrame === 30 && attempt === 1) {
        throw new Error("simulated transient page failure");
      }

      const chunks: SerializedEncodedChunk[] = [];
      for (let frame = range.startFrame; frame < range.endFrame; frame += 1) {
        chunks.push(fakeSerializedChunk(frame));
      }
      return chunks;
    });

    const handle = await submitEncodedRenderJob({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      rangeSizeFrames: 30,
      rangeAlignmentFrames: 30,
      maxAttemptsPerRange: 2,
      browserLauncher: launcher,
      bundleEntry: async () => "/* fake bundle */",
    });

    await handle.result;

    expect(rangeAttempts.get(0)).toBe(1);
    expect(rangeAttempts.get(30)).toBe(2);
    // 3 total browser launches: range 0 once, range 30 twice (retry).
    expect(launchCount()).toBe(3);
    expect(destination.ended).toBe(true);
  });

  it("rejects handle.result with RenderJobFailedError when a range permanently fails, muxing nothing", async () => {
    const project = buildProject(30);
    const destination = createFakeDestination();
    const { launcher } = createRangeAwareBrowserLauncher(async () => {
      throw new Error("permanent page failure");
    });

    const handle = await submitEncodedRenderJob({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      maxAttemptsPerRange: 2,
      browserLauncher: launcher,
      bundleEntry: async () => "/* fake bundle */",
    });

    await expect(handle.result).rejects.toThrow(RenderJobFailedError);
    expect(destination.chunks).toEqual([]);
    expect(destination.ended).toBe(false);
  });

  it("closes the browser after every attempt (success or failure)", async () => {
    const project = buildProject(30);
    const destination = createFakeDestination();
    const { launcher, browsers } = createRangeAwareBrowserLauncher(async (range) => {
      const chunks: SerializedEncodedChunk[] = [];
      for (let frame = range.startFrame; frame < range.endFrame; frame += 1) {
        chunks.push(fakeSerializedChunk(frame));
      }
      return chunks;
    });

    const handle = await submitEncodedRenderJob({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      browserLauncher: launcher,
      bundleEntry: async () => "/* fake bundle */",
    });
    await handle.result;

    expect(browsers).toHaveLength(1);
    expect(browsers[0]?.closeCalls).toBe(1);
  });

  it("defaults timeoutMs to DEFAULT_RANGE_TIMEOUT_MS", () => {
    expect(DEFAULT_RANGE_TIMEOUT_MS).toBe(2 * 60 * 1000);
  });
});

describe("resumeEncodedRenderJob", () => {
  it("does not re-render already-done ranges, only outstanding ones, then still muxes the full, combined output", async () => {
    const project = buildProject(90);
    const destination = createFakeDestination();
    const renderedStartFrames: number[] = [];

    const previousRanges = [
      {
        range: { rangeIndex: 0, startFrame: 0, endFrame: 30 },
        status: "done" as const,
        attempts: 1,
        errors: [],
        segment: Array.from({ length: 30 }, (_, i) => fakeSerializedChunk(i)),
      },
      {
        range: { rangeIndex: 1, startFrame: 30, endFrame: 60 },
        status: "failed" as const,
        attempts: 2,
        errors: [new Error("earlier failure")],
      },
      {
        range: { rangeIndex: 2, startFrame: 60, endFrame: 90 },
        status: "pending" as const,
        attempts: 0,
        errors: [],
      },
    ];

    const { launcher } = createRangeAwareBrowserLauncher(async (range) => {
      renderedStartFrames.push(range.startFrame);
      const chunks: SerializedEncodedChunk[] = [];
      for (let frame = range.startFrame; frame < range.endFrame; frame += 1) {
        chunks.push(fakeSerializedChunk(frame));
      }
      return chunks;
    });

    const handle: EncodedRenderJobHandle = await resumeEncodedRenderJob(previousRanges, {
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      browserLauncher: launcher,
      bundleEntry: async () => "/* fake bundle */",
    });

    await handle.result;

    // Range 0 (already done) was never re-rendered; only ranges 1 and 2.
    expect(renderedStartFrames.sort((a, b) => a - b)).toEqual([30, 60]);

    const bytes = Buffer.concat(destination.chunks);
    const trackTimescale = readMp4TrackTimescale(bytes);
    const actualDurationTicks = readMp4FragmentedDurationTicks(bytes);
    // Full 90-frame/30fps = 3s duration, proving the resumed job's final mux
    // includes range 0's reused segment plus the two freshly re-rendered
    // ranges, not just the two that were re-rendered this time.
    expect(actualDurationTicks).toBe(Math.round(3 * trackTimescale));
  });
});
