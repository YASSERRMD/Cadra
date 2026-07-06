import { createComposition, createProject, type Project, Sequence, Shape } from "@cadra/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HeadlessBrowserLike,
  HeadlessConsoleMessageLike,
  HeadlessPageLike,
} from "./browser-launcher.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RENDER_TIMEOUT_MS,
  HeadlessServerBrowserCrashedError,
  type HeadlessServerFileWriteStreamLike,
  type HeadlessServerLogLine,
  HeadlessServerRenderFailedError,
  HeadlessServerRenderTimeoutError,
  renderCompositionHeadlessServer,
} from "./render-composition-headless-server.js";

/** A small project, mirroring `render-composition.test.ts`'s own `buildProject` helper. */
function buildProject(): Project {
  const shape = Shape({ id: "shape-1" });
  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: 30,
    durationInFrames: 5,
    width: 64,
    height: 36,
    tracks: [
      {
        id: "track-1",
        clips: [Sequence({ id: "clip-1", from: 0, durationInFrames: 5, content: shape })],
      },
    ],
  });
  return createProject({ id: "p1", name: "Project", compositions: [composition] });
}

/**
 * Records every byte `write` is called with (as one concatenated
 * `Uint8Array`) and whether `end` was ever called, standing in for a real
 * `fs.WriteStream` in every test below.
 */
function createFakeDestination(): HeadlessServerFileWriteStreamLike & {
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
      return undefined;
    },
  };
}

/**
 * A fake `HeadlessPageLike`: instead of a real Playwright page, `evaluate`
 * directly invokes `behavior.run`, simulating "the browser-side entry
 * function ran and did X" without any real browser/esbuild bundle anywhere
 * underneath. `exposeFunction`-registered callbacks are captured so
 * `behavior.run` can call them directly (mirroring how the real bundled
 * entry script would call `window.__cadraHeadlessWrite`/etc.).
 */
interface FakePageBehavior {
  /**
   * Simulates the page-side render: receives the exposed write/close/progress
   * functions, does whatever the test wants (write some bytes, report
   * progress, throw), and returns/rejects exactly like
   * `runBrowserHeadlessRender` would.
   */
  run: (bridge: {
    write: (chunkBytes: number[]) => Promise<void>;
    close: () => Promise<void>;
    progress: (frame: number, totalFrames: number) => Promise<void>;
  }) => Promise<void>;
  /** Console lines to relay via `onConsoleMessage`, simulating page-side console output. */
  consoleLines?: Array<{ type: string; text: string }>;
}

function createFakePage(behavior: FakePageBehavior): HeadlessPageLike & { addScriptCalls: number } {
  const exposed = new Map<string, (...args: never[]) => unknown>();
  const consoleHandlers: Array<(message: HeadlessConsoleMessageLike) => void> = [];
  const page = {
    addScriptCalls: 0,
    async exposeFunction(name: string, fn: (...args: never[]) => unknown): Promise<void> {
      exposed.set(name, fn);
    },
    onConsoleMessage(handler: (message: HeadlessConsoleMessageLike) => void): void {
      consoleHandlers.push(handler);
    },
    onPageError(_handler: (error: Error) => void): void {
      // Not exercised by these fake-page tests: a thrown render error is
      // simulated via behavior.run's own rejection instead, matching how
      // runBrowserHeadlessRender's page.evaluate call itself rejects (see
      // its own doc), not via a separate "pageerror" event.
    },
    async evaluate<Arg, Result>(
      _pageFunction: (arg: Arg) => Result | Promise<Result>,
    ): Promise<Result> {
      const write = exposed.get("__cadraHeadlessWrite") as
        ((chunkBytes: number[]) => Promise<void>) | undefined;
      const close = exposed.get("__cadraHeadlessClose") as (() => Promise<void>) | undefined;
      const progress = exposed.get("__cadraHeadlessProgress") as
        ((frame: number, totalFrames: number) => Promise<void>) | undefined;
      if (write === undefined || close === undefined || progress === undefined) {
        throw new Error("createFakePage: bridge functions were not exposed before evaluate() ran.");
      }

      for (const line of behavior.consoleLines ?? []) {
        for (const handler of consoleHandlers) {
          handler({ type: () => line.type, text: () => line.text });
        }
      }

      await behavior.run({ write, close, progress });
      return undefined as Result;
    },
    async addScript(_source: string): Promise<void> {
      page.addScriptCalls += 1;
    },
  };
  return page;
}

/** A fake `HeadlessBrowserLike` whose `newPage()` always returns `page`, and whose `close()` is tracked. */
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

/** Convenience: a `behavior.run` that writes `bytes` (one chunk), reports one progress call, then closes, exactly like a successful render would. */
function successfulRun(bytes: number[]): FakePageBehavior["run"] {
  return async ({ write, close, progress }) => {
    await progress(0, 5);
    await write(bytes);
    await progress(4, 5);
    await close();
  };
}

describe("renderCompositionHeadlessServer: successful render", () => {
  it("streams the encoded bytes to the destination and resolves", async () => {
    const project = buildProject();
    const destination = createFakeDestination();
    const page = createFakePage({ run: successfulRun([1, 2, 3, 4]) });
    const browser = createFakeBrowser(page);

    await renderCompositionHeadlessServer({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      browserLauncher: async () => browser,
      bundleEntry: async () => "/* fake bundle */",
    });

    expect(destination.chunks).toEqual([Uint8Array.from([1, 2, 3, 4])]);
    expect(destination.ended).toBe(true);
  });

  it("relays onProgress calls from the page bridge", async () => {
    const project = buildProject();
    const destination = createFakeDestination();
    const page = createFakePage({ run: successfulRun([9]) });
    const browser = createFakeBrowser(page);
    const progressCalls: Array<[number, number]> = [];

    await renderCompositionHeadlessServer({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      browserLauncher: async () => browser,
      bundleEntry: async () => "/* fake bundle */",
      onProgress: (frame, totalFrames) => progressCalls.push([frame, totalFrames]),
    });

    expect(progressCalls).toEqual([
      [0, 5],
      [4, 5],
    ]);
  });

  it("relays the page's console output via onLog", async () => {
    const project = buildProject();
    const destination = createFakeDestination();
    const page = createFakePage({
      run: successfulRun([1]),
      consoleLines: [{ type: "log", text: "hello from the page" }],
    });
    const browser = createFakeBrowser(page);
    const logLines: HeadlessServerLogLine[] = [];

    await renderCompositionHeadlessServer({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      browserLauncher: async () => browser,
      bundleEntry: async () => "/* fake bundle */",
      onLog: (line) => logLines.push(line),
    });

    expect(logLines).toContainEqual({ level: "log", message: "hello from the page" });
  });

  it("closes the browser exactly once after a successful render", async () => {
    const project = buildProject();
    const destination = createFakeDestination();
    const page = createFakePage({ run: successfulRun([1]) });
    const browser = createFakeBrowser(page);

    await renderCompositionHeadlessServer({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      browserLauncher: async () => browser,
      bundleEntry: async () => "/* fake bundle */",
    });

    expect(browser.closeCalls).toBe(1);
  });

  it("bundles the given entryFilePath and injects the returned source via addScript", async () => {
    const project = buildProject();
    const destination = createFakeDestination();
    const page = createFakePage({ run: successfulRun([1]) });
    const browser = createFakeBrowser(page);
    const bundleEntry = vi.fn(async () => "/* the bundle */");

    await renderCompositionHeadlessServer({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      browserLauncher: async () => browser,
      bundleEntry,
    });

    expect(bundleEntry).toHaveBeenCalledWith({ entryFilePath: "/fake/entry.js" });
    expect(page.addScriptCalls).toBe(1);
  });
});

describe("renderCompositionHeadlessServer: defaults", () => {
  it("exposes the documented default timeout and attempt count constants", () => {
    expect(DEFAULT_RENDER_TIMEOUT_MS).toBe(5 * 60 * 1000);
    expect(DEFAULT_MAX_ATTEMPTS).toBe(3);
  });
});

describe("renderCompositionHeadlessServer: crash handling", () => {
  it("retries after a browser crash (onDisconnected) and succeeds on a later attempt", async () => {
    const project = buildProject();
    const destination = createFakeDestination();

    let attempt = 0;
    const browserLauncher = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        // First attempt: the page never resolves on its own; the browser
        // "crashes" instead (onDisconnected fires shortly after newPage()).
        const page = createFakePage({ run: () => new Promise<void>(() => {}) });
        const browser = createFakeBrowser(page);
        setTimeout(() => {
          for (const handler of browser.disconnectedHandlers) {
            handler();
          }
        }, 5);
        return browser;
      }
      const page = createFakePage({ run: successfulRun([7, 7]) });
      return createFakeBrowser(page);
    });

    await renderCompositionHeadlessServer({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      browserLauncher,
      bundleEntry: async () => "/* fake bundle */",
      maxAttempts: 2,
    });

    expect(browserLauncher).toHaveBeenCalledTimes(2);
    expect(destination.chunks).toEqual([Uint8Array.from([7, 7])]);
  });

  it("throws HeadlessServerRenderFailedError wrapping a HeadlessServerBrowserCrashedError when every attempt crashes", async () => {
    const project = buildProject();
    const destination = createFakeDestination();

    const browserLauncher = vi.fn(async () => {
      const page = createFakePage({ run: () => new Promise<void>(() => {}) });
      const browser = createFakeBrowser(page);
      setTimeout(() => {
        for (const handler of browser.disconnectedHandlers) {
          handler();
        }
      }, 5);
      return browser;
    });

    await expect(
      renderCompositionHeadlessServer({
        project,
        compositionId: "comp-1",
        seed: "s",
        format: "mp4",
        bitrate: 1_000_000,
        destination,
        entryFilePath: "/fake/entry.js",
        browserLauncher,
        bundleEntry: async () => "/* fake bundle */",
        maxAttempts: 2,
      }),
    ).rejects.toThrow(HeadlessServerRenderFailedError);

    expect(browserLauncher).toHaveBeenCalledTimes(2);
  });

  it("HeadlessServerRenderFailedError.attempts lists one HeadlessServerBrowserCrashedError per failed attempt", async () => {
    const project = buildProject();
    const destination = createFakeDestination();

    const browserLauncher = vi.fn(async () => {
      const page = createFakePage({ run: () => new Promise<void>(() => {}) });
      const browser = createFakeBrowser(page);
      setTimeout(() => {
        for (const handler of browser.disconnectedHandlers) {
          handler();
        }
      }, 5);
      return browser;
    });

    try {
      await renderCompositionHeadlessServer({
        project,
        compositionId: "comp-1",
        seed: "s",
        format: "mp4",
        bitrate: 1_000_000,
        destination,
        entryFilePath: "/fake/entry.js",
        browserLauncher,
        bundleEntry: async () => "/* fake bundle */",
        maxAttempts: 2,
      });
      expect.fail("expected renderCompositionHeadlessServer to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(HeadlessServerRenderFailedError);
      const failed = error as HeadlessServerRenderFailedError;
      expect(failed.attempts).toHaveLength(2);
      expect(failed.attempts[0]).toBeInstanceOf(HeadlessServerBrowserCrashedError);
      expect(failed.attempts[1]).toBeInstanceOf(HeadlessServerBrowserCrashedError);
    }
  });

  it("closes the browser even when the attempt crashes", async () => {
    const project = buildProject();
    const destination = createFakeDestination();
    const page = createFakePage({ run: () => new Promise<void>(() => {}) });
    const browser = createFakeBrowser(page);
    setTimeout(() => {
      for (const handler of browser.disconnectedHandlers) {
        handler();
      }
    }, 5);

    await expect(
      renderCompositionHeadlessServer({
        project,
        compositionId: "comp-1",
        seed: "s",
        format: "mp4",
        bitrate: 1_000_000,
        destination,
        entryFilePath: "/fake/entry.js",
        browserLauncher: async () => browser,
        bundleEntry: async () => "/* fake bundle */",
        maxAttempts: 1,
      }),
    ).rejects.toThrow(HeadlessServerRenderFailedError);

    expect(browser.closeCalls).toBe(1);
  });
});

describe("renderCompositionHeadlessServer: page-thrown errors", () => {
  it("retries after the page-side render rejects, and succeeds on a later attempt", async () => {
    const project = buildProject();
    const destination = createFakeDestination();

    let attempt = 0;
    const browserLauncher = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        const page = createFakePage({
          run: async () => {
            throw { message: "simulated page-side render failure" };
          },
        });
        return createFakeBrowser(page);
      }
      const page = createFakePage({ run: successfulRun([3, 1, 4]) });
      return createFakeBrowser(page);
    });

    await renderCompositionHeadlessServer({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      browserLauncher,
      bundleEntry: async () => "/* fake bundle */",
      maxAttempts: 2,
    });

    expect(browserLauncher).toHaveBeenCalledTimes(2);
    expect(destination.chunks).toEqual([Uint8Array.from([3, 1, 4])]);
  });

  it("throws HeadlessServerRenderFailedError after maxAttempts consecutive page-side failures", async () => {
    const project = buildProject();
    const destination = createFakeDestination();
    const page = createFakePage({
      run: async () => {
        throw { message: "always fails" };
      },
    });
    const browserLauncher = vi.fn(async () => createFakeBrowser(page));

    await expect(
      renderCompositionHeadlessServer({
        project,
        compositionId: "comp-1",
        seed: "s",
        format: "mp4",
        bitrate: 1_000_000,
        destination,
        entryFilePath: "/fake/entry.js",
        browserLauncher,
        bundleEntry: async () => "/* fake bundle */",
        maxAttempts: 3,
      }),
    ).rejects.toThrow(HeadlessServerRenderFailedError);

    expect(browserLauncher).toHaveBeenCalledTimes(3);
  });

  it("logs an internal diagnostic line for each failed attempt via onLog", async () => {
    const project = buildProject();
    const destination = createFakeDestination();
    const page = createFakePage({
      run: async () => {
        throw { message: "boom" };
      },
    });
    const browserLauncher = vi.fn(async () => createFakeBrowser(page));
    const logLines: HeadlessServerLogLine[] = [];

    await expect(
      renderCompositionHeadlessServer({
        project,
        compositionId: "comp-1",
        seed: "s",
        format: "mp4",
        bitrate: 1_000_000,
        destination,
        entryFilePath: "/fake/entry.js",
        browserLauncher,
        bundleEntry: async () => "/* fake bundle */",
        maxAttempts: 2,
        onLog: (line) => logLines.push(line),
      }),
    ).rejects.toThrow(HeadlessServerRenderFailedError);

    const internalLines = logLines.filter((line) => line.level === "internal");
    expect(internalLines).toHaveLength(2);
    expect(internalLines[0]?.message).toContain("attempt 1/2 failed");
    expect(internalLines[1]?.message).toContain("attempt 2/2 failed");
  });
});

describe("renderCompositionHeadlessServer: timeout handling", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("times out and retries when an attempt never finishes within timeoutMs, then succeeds on a later attempt", async () => {
    const project = buildProject();
    const destination = createFakeDestination();

    let attempt = 0;
    const browserLauncher = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        // Never resolves, never crashes: only the timeout can end this attempt.
        const page = createFakePage({ run: () => new Promise<void>(() => {}) });
        return createFakeBrowser(page);
      }
      const page = createFakePage({ run: successfulRun([2, 2]) });
      return createFakeBrowser(page);
    });

    await renderCompositionHeadlessServer({
      project,
      compositionId: "comp-1",
      seed: "s",
      format: "mp4",
      bitrate: 1_000_000,
      destination,
      entryFilePath: "/fake/entry.js",
      browserLauncher,
      bundleEntry: async () => "/* fake bundle */",
      maxAttempts: 2,
      timeoutMs: 20,
    });

    expect(browserLauncher).toHaveBeenCalledTimes(2);
    expect(destination.chunks).toEqual([Uint8Array.from([2, 2])]);
  }, 10_000);

  it("HeadlessServerRenderFailedError.attempts contains a HeadlessServerRenderTimeoutError when every attempt times out", async () => {
    const project = buildProject();
    const destination = createFakeDestination();
    const page = createFakePage({ run: () => new Promise<void>(() => {}) });
    const browserLauncher = vi.fn(async () => createFakeBrowser(page));

    try {
      await renderCompositionHeadlessServer({
        project,
        compositionId: "comp-1",
        seed: "s",
        format: "mp4",
        bitrate: 1_000_000,
        destination,
        entryFilePath: "/fake/entry.js",
        browserLauncher,
        bundleEntry: async () => "/* fake bundle */",
        maxAttempts: 1,
        timeoutMs: 20,
      });
      expect.fail("expected renderCompositionHeadlessServer to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(HeadlessServerRenderFailedError);
      const failed = error as HeadlessServerRenderFailedError;
      expect(failed.attempts).toHaveLength(1);
      expect(failed.attempts[0]).toBeInstanceOf(HeadlessServerRenderTimeoutError);
    }
  }, 10_000);

  it("closes the browser even when the attempt times out", async () => {
    const project = buildProject();
    const destination = createFakeDestination();
    const page = createFakePage({ run: () => new Promise<void>(() => {}) });
    const browser = createFakeBrowser(page);

    await expect(
      renderCompositionHeadlessServer({
        project,
        compositionId: "comp-1",
        seed: "s",
        format: "mp4",
        bitrate: 1_000_000,
        destination,
        entryFilePath: "/fake/entry.js",
        browserLauncher: async () => browser,
        bundleEntry: async () => "/* fake bundle */",
        maxAttempts: 1,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(HeadlessServerRenderFailedError);

    expect(browser.closeCalls).toBe(1);
  }, 10_000);
});
