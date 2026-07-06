import type { Project } from "@cadra/core";

import {
  type BrowserLauncher,
  type HeadlessBrowserLike,
  launchPlaywrightHeadlessBrowser,
} from "./browser-launcher.js";
import { BROWSER_ENTRY_GLOBAL_NAME, bundleBrowserEntry } from "./bundle-browser-entry.js";
import type { OnProgressFn } from "./render-composition.js";

/**
 * The subset of Node's `fs.WriteStream` (or anything shaped like one) this
 * module needs to stream an encoded render's bytes to a file: `write` and
 * `end`. A narrow structural type, not `import type { WriteStream } from
 * "node:fs"`, mirroring `@cadra/encode`'s own `mux-stream-target.ts`
 * `NodeWritableLike` rationale (this package's `tsconfig.base.json` `lib` is
 * `["ES2022", "DOM", "DOM.Iterable"]` with no `@types/node`, and a real
 * `fs.WriteStream` type is not otherwise resolvable here without adding an
 * `@types/node` dependency this package otherwise has no need for). A real
 * `fs.createWriteStream(path)` result already satisfies this structurally,
 * and a caller on a Node host is expected to construct one and pass it as
 * `options.destination`.
 */
export interface HeadlessServerFileWriteStreamLike {
  /** Appends `chunk` to the destination. Mirrors `fs.WriteStream.write`. */
  write(chunk: Uint8Array): unknown;
  /** Signals no further writes are coming and the destination should finalize/close, invoking `callback` once done. Mirrors `fs.WriteStream.end`. */
  end(callback: () => void): unknown;
}

/** Reports a log line the page's `console` emitted, or a diagnostic this orchestrator itself produced (see `onLog`'s own doc). */
export interface HeadlessServerLogLine {
  /** Severity, mirroring the page's own `console` method ("log", "warn", "error", "info", "debug"), or "internal" for a diagnostic this orchestrator produced itself (not relayed from the page). */
  level: string;
  /** The message text. */
  message: string;
}

/** Invoked for every log line the render produces; mirrors this codebase's existing callback-option style (e.g. `AttachAudioOptions`/`OnProgressFn`). */
export type OnLogFn = (line: HeadlessServerLogLine) => void;

/** Options accepted by `renderCompositionHeadlessServer`. */
export interface RenderCompositionHeadlessServerOptions {
  /** The project to render, i.e. `renderComposition`'s own `options.project`. */
  project: Project;
  /** Which of `project`'s compositions to render. */
  compositionId: string;
  /** Base seed for every frame's `FrameContext`; required, matching `renderComposition`'s own `options.seed` (see its doc for why this has no default). */
  seed: string | number;
  /** Output container. */
  format: "mp4" | "webm";
  /** Target bitrate in bits per second for the video encoder. */
  bitrate: number;
  /**
   * Where the encoded output is written. A real
   * `fs.createWriteStream(outputPath)` (or anything shaped like
   * `HeadlessServerFileWriteStreamLike`) is the common case for "render to a
   * file on this server"; nothing about this function is Node-`fs`-specific
   * beyond this one structural shape, so an equally-shaped in-memory
   * destination (e.g. for a test) works identically.
   */
  destination: HeadlessServerFileWriteStreamLike;
  /**
   * Absolute path to the browser-side entry script to bundle and run inside
   * the page, e.g. `@cadra/encode`'s own exported
   * `BROWSER_HEADLESS_RENDER_ENTRY_PATH`. Required, not defaulted: see
   * `bundle-browser-entry.ts`'s own doc for why `@cadra/headless` cannot
   * hardcode a default pointing into `@cadra/encode` without introducing a
   * circular workspace dependency.
   */
  entryFilePath: string;
  /** Reports per-frame progress, matching `renderComposition`'s own `OnProgressFn` shape. */
  onProgress?: OnProgressFn;
  /** Reports every log line the render produces (the page's own `console` output, plus this orchestrator's own retry/timeout diagnostics). */
  onLog?: OnLogFn;
  /**
   * Launches the headless browser this function drives. Defaults to
   * `launchPlaywrightHeadlessBrowser` (real Playwright/Chromium). Injectable
   * so tests can supply a fake `HeadlessBrowserLike`/`HeadlessPageLike` with
   * no real browser anywhere underneath, matching this codebase's
   * `ReadPixelsFn`/`WebGpuDetector` pattern.
   */
  browserLauncher?: BrowserLauncher;
  /**
   * Bundles `entryFilePath` into injectable script source. Defaults to
   * `bundleBrowserEntry` (real esbuild). Injectable for the same reason as
   * `browserLauncher`: a fast unit test should not have to pay esbuild's
   * bundling cost (or resolve a real `@cadra/encode` entry file on disk) just
   * to exercise this function's retry/timeout/progress-relay logic.
   */
  bundleEntry?: (options: { entryFilePath: string }) => Promise<string>;
  /**
   * Milliseconds allowed for one full render attempt (browser launch through
   * every byte written and the destination closed) before it is treated as
   * timed out and retried (see `maxAttempts`). Defaults to
   * `DEFAULT_RENDER_TIMEOUT_MS`.
   */
  timeoutMs?: number;
  /**
   * Total attempts (the first try plus retries) before giving up and
   * rejecting. Defaults to `DEFAULT_MAX_ATTEMPTS`. Every attempt renders
   * from scratch (a fresh browser launch, a fresh page, the full
   * `durationInFrames` walked again): `renderComposition`'s own determinism
   * guarantee (fixed `seed`, no wall clock, no unseeded randomness) is
   * exactly what makes a from-scratch retry correct and simple, with no
   * partial-progress resume needed (that is a later phase's job, per this
   * phase's own spec).
   */
  maxAttempts?: number;
}

/** Milliseconds allowed for one full render attempt by default: 5 minutes, generous enough for a real (non-trivial) composition on software-rendered SwiftShader while still failing fast rather than hanging a caller indefinitely on a genuinely stuck browser. */
export const DEFAULT_RENDER_TIMEOUT_MS = 5 * 60 * 1000;

/** Total attempts (first try plus retries) by default: 3, enough to ride out a transient crash/timeout without masking a persistently broken render behind a very long retry loop. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Thrown when every attempt (`options.maxAttempts`) fails. `attempts` lists
 * every individual attempt's own failure, in order, so a caller can inspect
 * exactly why each one failed (a mix of timeouts and crashes is
 * distinguishable from, say, the same deterministic error repeating every
 * time, which usually means the composition itself is the problem, not
 * transient browser flakiness).
 */
export class HeadlessServerRenderFailedError extends Error {
  readonly attempts: readonly Error[];

  constructor(attempts: readonly Error[]) {
    const summary = attempts
      .map((error, index) => `  attempt ${index + 1}: ${error.message}`)
      .join("\n");
    super(
      `renderCompositionHeadlessServer: every attempt (${attempts.length}) failed.\n${summary}`,
    );
    this.name = "HeadlessServerRenderFailedError";
    this.attempts = attempts;
  }
}

/** Thrown internally (and surfaced as one attempt's failure) when an attempt does not finish within `timeoutMs`. */
export class HeadlessServerRenderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`renderCompositionHeadlessServer: render attempt did not finish within ${timeoutMs}ms.`);
    this.name = "HeadlessServerRenderTimeoutError";
  }
}

/** Thrown internally (and surfaced as one attempt's failure) when the browser disconnects/crashes before the render completes. */
export class HeadlessServerBrowserCrashedError extends Error {
  constructor() {
    super(
      "renderCompositionHeadlessServer: the headless browser disconnected/crashed before the render completed.",
    );
    this.name = "HeadlessServerBrowserCrashedError";
  }
}

/** Names for the `window`-exposed bridge functions the browser-side entry script calls; kept as constants so the Node-side registration and the browser-side call site (see `@cadra/encode`'s `browser-headless-render-entry.ts`) cannot drift apart silently. */
const WRITE_FN_NAME = "__cadraHeadlessWrite";
const CLOSE_FN_NAME = "__cadraHeadlessClose";
const PROGRESS_FN_NAME = "__cadraHeadlessProgress";

/** Config passed into the page via `evaluate`'s structured-cloned `arg`, matching `@cadra/encode`'s `BrowserHeadlessRenderConfig` shape exactly (duplicated here rather than imported, per this module's own doc on why `@cadra/headless` does not depend on `@cadra/encode`). */
interface BrowserRenderConfigArg {
  project: Project;
  compositionId: string;
  seed: string | number;
  format: "mp4" | "webm";
  bitrate: number;
}

/**
 * Registers the write/close/progress bridge functions on `page`, wiring
 * them to `destination`/`onProgress`. Returns a promise that resolves once
 * `__cadraHeadlessClose` has been called (i.e. the browser-side pipeline
 * signaled every byte was written), after `destination.end()` has itself
 * finished.
 */
function wireBridgeFunctions(
  page: { exposeFunction(name: string, fn: (...args: never[]) => unknown): Promise<void> },
  destination: HeadlessServerFileWriteStreamLike,
  onProgress: OnProgressFn | undefined,
): { closed: Promise<void>; registered: Promise<void> } {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const registered = (async () => {
    await page.exposeFunction(WRITE_FN_NAME, ((chunkNumbers: number[]) => {
      destination.write(Uint8Array.from(chunkNumbers));
    }) as (...args: never[]) => unknown);

    await page.exposeFunction(CLOSE_FN_NAME, (() => {
      return new Promise<void>((resolve) => {
        destination.end(() => {
          resolve();
          resolveClosed();
        });
      });
    }) as (...args: never[]) => unknown);

    await page.exposeFunction(PROGRESS_FN_NAME, ((frame: number, totalFrames: number) => {
      onProgress?.(frame, totalFrames);
    }) as (...args: never[]) => unknown);
  })();

  return { closed, registered };
}

/**
 * Runs exactly one render attempt: launches a browser (via `launcher`),
 * opens a page, wires the write/close/progress bridge, relays `console`
 * output through `onLog`, bundles and injects `entrySource`, calls the
 * entry function with `config`, and awaits the destination closing, all
 * bounded by `timeoutMs`.
 *
 * The returned promise rejects with `HeadlessServerBrowserCrashedError` if
 * the browser disconnects before the render completes,
 * `HeadlessServerRenderTimeoutError` if `timeoutMs` elapses first, or an
 * `Error` (Playwright's own `page.evaluate` rejection, wrapping whatever
 * real `Error` the page-side render itself threw; see `@cadra/encode`'s
 * `runBrowserHeadlessRender`'s own doc for why it specifically rethrows a
 * genuine `Error` rather than a plain object across that boundary).
 *
 * The timeout race deliberately lives inside this function (racing the
 * render itself), not wrapped around a call to this function from outside:
 * `browser.close()` runs in this function's own `finally`, so racing
 * externally would let the caller's `await` return/throw as soon as the
 * timeout promise wins, while this function's still-in-flight `finally`
 * continues running detached in the background with no guarantee the
 * caller ever sees it finish before moving on to the next attempt (or
 * returning control to whatever called `renderCompositionHeadlessServer`
 * itself). Keeping the race (and therefore the timeout's rejection) inside
 * this function's own `try` means the `finally` below always runs, and is
 * always awaited, before this function's returned promise ever settles,
 * whichever of success/crash/timeout ends the attempt.
 */
async function runOneAttempt(
  launcher: BrowserLauncher,
  entrySource: string,
  config: BrowserRenderConfigArg,
  destination: HeadlessServerFileWriteStreamLike,
  onProgress: OnProgressFn | undefined,
  onLog: OnLogFn | undefined,
  timeoutMs: number,
): Promise<void> {
  let browser: HeadlessBrowserLike | undefined;
  const timeout = createTimeout(timeoutMs);

  try {
    browser = await launcher({});

    const crashed = new Promise<never>((_resolve, reject) => {
      browser?.onDisconnected(() => {
        reject(new HeadlessServerBrowserCrashedError());
      });
    });
    // A promise that never settles unless the browser disconnects must not
    // raise an unhandled-rejection warning while the race below is still
    // pending on a *different* branch settling first.
    crashed.catch(() => {});

    const page = await browser.newPage();

    page.onConsoleMessage((message) => {
      onLog?.({ level: message.type(), message: message.text() });
    });
    page.onPageError((error) => {
      onLog?.({ level: "error", message: error.message });
    });

    const { closed, registered } = wireBridgeFunctions(page, destination, onProgress);
    await registered;

    await page.addScript(entrySource);

    // `globalName` (a plain string, not `BROWSER_ENTRY_GLOBAL_NAME` read via
    // closure) is folded into the structured-cloned `arg` itself, not
    // referenced as a free variable inside `pageFunction`'s body: Playwright's
    // real `page.evaluate` serializes `pageFunction` to a source string and
    // re-executes it *inside the page*, with no access to this module's own
    // enclosing scope, so any outer `const`/import binding `pageFunction`
    // closes over resolves to whatever bare identifier that binding happens
    // to compile down to (e.g. a bundler-renamed variable, or in one verified
    // failure mode while building this phase, Vitest's own SSR transform's
    // internal `__vite_ssr_import_1__` wrapper), which does not exist inside
    // the page's global scope at all and throws a ReferenceError. Only
    // values reachable through `arg` (the actual structured-clone boundary
    // `page.evaluate` documents) are guaranteed to survive intact.
    const renderDone = page.evaluate(
      (arg: { config: BrowserRenderConfigArg; globalName: string }) => {
        const entry = (
          window as unknown as Record<
            string,
            { runBrowserHeadlessRender: (config: BrowserRenderConfigArg) => Promise<void> } | undefined
          >
        )[arg.globalName];
        if (entry === undefined) {
          throw new Error(
            `renderCompositionHeadlessServer: window["${arg.globalName}"] was not defined; the bundled entry script did not load correctly before evaluate() ran.`,
          );
        }
        return entry.runBrowserHeadlessRender(arg.config);
      },
      { config, globalName: BROWSER_ENTRY_GLOBAL_NAME },
    );

    await Promise.race([Promise.all([renderDone, closed]), crashed, timeout.promise]);
  } finally {
    timeout.cancel();
    await browser?.close();
  }
}

/** Rejects with `HeadlessServerRenderTimeoutError` after `timeoutMs`, otherwise never settles. `unref`-ed where available so a pending timeout never keeps a Node process alive on its own. */
function createTimeout(timeoutMs: number): { promise: Promise<never>; cancel: () => void } {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new HeadlessServerRenderTimeoutError(timeoutMs));
    }, timeoutMs);
    // `unref` exists on Node's Timeout object but not the spec `number`
    // handle `setTimeout` returns in a DOM-only typing context (this
    // package's `lib` is DOM-only, no `@types/node`); guarded rather than
    // assumed present so this still works correctly (just without the
    // unref behavior) in an environment where it is genuinely absent.
    (timeoutHandle as unknown as { unref?: () => void }).unref?.();
  });
  promise.catch(() => {});
  return {
    promise,
    cancel: () => clearTimeout(timeoutHandle),
  };
}

/**
 * Renders `options.project`'s composition `options.compositionId` to an
 * encoded video file, entirely inside a headless browser page: launches a
 * browser (real Playwright/Chromium by default), bundles and injects
 * `options.entryFilePath`'s browser-side render pipeline (see
 * `@cadra/encode`'s `runBrowserHeadlessRender`/
 * `BROWSER_HEADLESS_RENDER_ENTRY_PATH`), and streams the encoded output to
 * `options.destination` as it is produced.
 *
 * Retries the entire render from scratch, up to `options.maxAttempts` times
 * total, on any failure (a page/browser crash, an attempt exceeding
 * `options.timeoutMs`, or the page-side pipeline itself throwing): since
 * `renderComposition` is fully deterministic given the same
 * `project`/`compositionId`/`seed`, a clean from-scratch retry always
 * reproduces the exact same intended output, with no partial-progress
 * resume logic needed. If every attempt fails, rejects with
 * `HeadlessServerRenderFailedError`, which lists every individual attempt's
 * own error.
 *
 * `options.onProgress`/`options.onLog` are invoked from whichever attempt is
 * currently running; a failed attempt's progress/log calls are not
 * distinguished from a later, ultimately-successful attempt's own calls
 * (i.e. a caller watching progress across a retried render sees progress
 * "restart" from frame 0 when a new attempt begins, exactly reflecting that
 * a fresh, independent render is underway).
 */
export async function renderCompositionHeadlessServer(
  options: RenderCompositionHeadlessServerOptions,
): Promise<void> {
  const launcher = options.browserLauncher ?? launchPlaywrightHeadlessBrowser;
  const bundleEntry = options.bundleEntry ?? bundleBrowserEntry;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const entrySource = await bundleEntry({ entryFilePath: options.entryFilePath });

  const config: BrowserRenderConfigArg = {
    project: options.project,
    compositionId: options.compositionId,
    seed: options.seed,
    format: options.format,
    bitrate: options.bitrate,
  };

  const attemptErrors: Error[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // No external Promise.race against a timeout here: runOneAttempt
      // already races its own internal timeout (see its own doc for why
      // the timeout must live inside that function's try/finally, not
      // wrapped around it from out here, so browser.close() is always
      // awaited before this call ever resolves/rejects).
      await runOneAttempt(
        launcher,
        entrySource,
        config,
        options.destination,
        options.onProgress,
        options.onLog,
        timeoutMs,
      );
      return;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      attemptErrors.push(normalized);
      options.onLog?.({
        level: "internal",
        message: `renderCompositionHeadlessServer: attempt ${attempt}/${maxAttempts} failed: ${normalized.message}`,
      });
    }
  }

  throw new HeadlessServerRenderFailedError(attemptErrors);
}
