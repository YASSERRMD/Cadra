/**
 * The subset of a real Playwright `Page` this package drives: injecting the
 * bundled browser-side render script, exposing Node-side callback functions
 * the page can call, and forwarding `console` output. Narrow and structural
 * (not `import type { Page } from "playwright"` directly) so a fake page in
 * tests only has to implement the handful of methods actually used, matching
 * this codebase's `ReadPixelsFn`/`WebGpuDetector`-style seams: production
 * code is handed a real Playwright `Page` (which satisfies this structurally,
 * needing no adapter), tests supply a minimal fake with no real browser
 * anywhere underneath.
 */
export interface HeadlessPageLike {
  /**
   * Registers `fn` as `window[name]` inside the page, callable from
   * browser-side code, mirroring Playwright's real
   * `page.exposeFunction(name, fn)`. Used for the progress/log/write bridge
   * (see this package's server orchestrator).
   */
  exposeFunction(name: string, fn: (...args: never[]) => unknown): Promise<void>;
  /** Subscribes to the page's `console` events, mirroring Playwright's real `page.on("console", handler)`. */
  onConsoleMessage(handler: (message: HeadlessConsoleMessageLike) => void): void;
  /** Subscribes to the page's uncaught-exception ("pageerror") events, mirroring Playwright's real `page.on("pageerror", handler)`. */
  onPageError(handler: (error: Error) => void): void;
  /**
   * Runs `pageFunction` inside the page with `arg` as its sole argument,
   * mirroring Playwright's real `page.evaluate(pageFunction, arg)`. `arg`
   * and the return value both cross the structured-clone boundary, exactly
   * like a real `page.evaluate` call.
   */
  evaluate<Arg, Result>(
    pageFunction: (arg: Arg) => Result | Promise<Result>,
    arg: Arg,
  ): Promise<Result>;
  /** Injects `source` as a `<script>` tag's raw body, mirroring Playwright's real `page.addScriptTag({ content })`. */
  addScript(source: string): Promise<void>;
}

/** The subset of a real Playwright `ConsoleMessage` this package reads: enough to relay a log line and its severity onward. */
export interface HeadlessConsoleMessageLike {
  /** The console method used ("log", "warn", "error", "info", "debug", ...), mirroring `ConsoleMessage.type()`. */
  type(): string;
  /** The formatted message text, mirroring `ConsoleMessage.text()`. */
  text(): string;
}

/**
 * A launched browser this package can open pages in and must eventually
 * close. Deliberately narrower than Playwright's real `Browser`: only what
 * the server orchestrator actually drives.
 */
export interface HeadlessBrowserLike {
  /** Opens a fresh page/tab, mirroring Playwright's real `browser.newPage()`. */
  newPage(): Promise<HeadlessPageLike>;
  /** Subscribes to the browser's "disconnected" event (fires on an unexpected crash/close), mirroring `Browser.on("disconnected", handler)`. */
  onDisconnected(handler: () => void): void;
  /** Closes the browser and every page in it, mirroring Playwright's real `browser.close()`. Safe to call on an already-closed browser. */
  close(): Promise<void>;
}

/**
 * Launches a headless browser ready to render Cadra compositions, returning
 * a `HeadlessBrowserLike` handle. Production code is handed a real
 * Playwright `chromium.launch(...)` result (which structurally satisfies
 * `HeadlessBrowserLike` with no adapter needed: Playwright's real `Browser`/
 * `Page`/`ConsoleMessage` already have every method this interface
 * requires); tests inject a fake that never touches a real browser, matching
 * this codebase's `ReadPixelsFn`/`WebGpuDetector` pattern (see
 * `pixel-readable-three-renderer.ts`, `capability-detection.ts`): a real
 * browser launch is comparatively slow (hundreds of milliseconds to
 * seconds) and requires a cached Chromium binary that will not exist in
 * every environment this package's tests run in, so the fast, deterministic
 * default for tests is an injected fake, not the real thing.
 */
export type BrowserLauncher = (
  options: LaunchHeadlessBrowserOptions,
) => Promise<HeadlessBrowserLike>;

/** Options accepted by a `BrowserLauncher`. */
export interface LaunchHeadlessBrowserOptions {
  /**
   * Extra Chromium command-line flags, appended to this function's own
   * GPU-backend defaults (see `DEFAULT_GPU_LAUNCH_ARGS`'s doc). Lets a
   * caller force a specific ANGLE backend or add further diagnostic flags
   * without having to repeat the defaults themselves.
   */
  extraArgs?: readonly string[];
}

/**
 * Chromium launch flags this package defaults to, chosen for deterministic,
 * portable software rendering over raw speed:
 *
 * - `--headless=new`: Chromium's modern headless mode (as opposed to the
 *   legacy headless implementation, which historically lagged the real
 *   browser's GPU/WebGL code paths and produced subtly different rendering
 *   output from a headed run of the same version).
 * - `--use-angle=swiftshader` + `--use-gl=angle`: forces ANGLE's SwiftShader
 *   software rasterizer as the GL backend, rather than whatever GPU happens
 *   to be present (or absent) on the host. This is the deliberate tradeoff
 *   this phase's spec calls out: software rendering is slower than a real
 *   GPU backend, but its output does not depend on which physical GPU/driver
 *   version happened to run it, which matters for a server fleet where two
 *   render requests for the same deterministic seed must produce
 *   byte-identical output regardless of which machine in the fleet handled
 *   each one. A caller that has a consistent, known-good GPU across its
 *   whole fleet (and prioritizes throughput over that cross-machine
 *   guarantee) can override this via `extraArgs`, e.g. `--use-angle=metal`
 *   (macOS) / `--use-angle=vulkan` (Linux) / `--use-angle=d3d11` (Windows),
 *   trading the portability guarantee for real-GPU speed.
 * - `--enable-unsafe-swiftshader`: Chromium otherwise refuses to expose WebGL
 *   at all over SwiftShader outside of tests/CI (SwiftShader is unsupported
 *   for production GPU-accelerated rendering per Chromium's own policy, on
 *   the reasoning that shipping it to end users as if it were a real GPU
 *   would silently degrade performance); this server-side render path is
 *   exactly the sanctioned "explicitly opted into software rendering,
 *   knowingly" use case that flag exists for.
 * - `--ignore-gpu-blocklist`: some sandboxed/virtualized/CI environments
 *   report a GPU configuration Chromium's own blocklist otherwise refuses to
 *   drive at all; this flag proceeds anyway rather than silently disabling
 *   WebGL2/WebGPU (which would then, per `createRenderer`'s own contract,
 *   simply produce a renderer with `capabilities.isFallback: true` and no
 *   canvas at all, i.e. every render failing outright, exactly the
 *   uninformative failure mode this flag avoids).
 *
 * `createRenderer()` itself always tries WebGPU first (via
 * `navigator.gpu`) and falls back to WebGL2. Neither this phase nor these
 * flags force WebGPU specifically to be present: as of this Playwright/
 * Chromium build, `navigator.gpu` is not exposed in headless mode at all
 * (verified against the exact cached `chromium-1228` revision this
 * repository pins), so every headless server render in practice takes the
 * WebGL2-over-SwiftShader path today. That is an accepted, documented
 * outcome, not a bug: per this phase's spec, a WebGPU-unavailable
 * environment is not a hard failure, since `createRenderer`'s WebGL2
 * fallback still produces a correct, real (non-blank) render; only a
 * missing WebGL2 path too (which these flags are chosen specifically to
 * prevent) would be.
 */
export const DEFAULT_GPU_LAUNCH_ARGS: readonly string[] = [
  "--headless=new",
  "--use-angle=swiftshader",
  "--use-gl=angle",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
];

/** Adapts a real Playwright `ConsoleMessage` to `HeadlessConsoleMessageLike`. Both already match structurally; this exists only to name the boundary. */
function toConsoleMessageLike(message: {
  type(): string;
  text(): string;
}): HeadlessConsoleMessageLike {
  return message;
}

/**
 * Starts a minimal local HTTP server (via a dynamic `await
 * import("node:http")`, for the same reason `playwright`/`esbuild` are
 * imported dynamically elsewhere in this package: keeping this module
 * bundle-safe for a browser target, see `launchPlaywrightHeadlessBrowser`'s
 * own doc) serving a single trivial blank HTML page on an OS-assigned free
 * port on `127.0.0.1`, and returns that page's URL plus a `close()` to stop
 * the server. Exists purely so a page can `goto()` a real `http://` origin
 * before this package's browser-side render pipeline runs; see
 * `newPage()`'s own doc for why that navigation is required at all.
 */
async function startLocalSecureContextServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");

  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><html><head></head><body></body></html>");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  // `server.listen(0, ...)` (port 0, "pick any free port") always resolves
  // its listening address to the real `AddressInfo` object shape (never a
  // bare string, which only occurs for a Unix domain socket path, not a
  // TCP port 0 bind), so `address` is guaranteed non-null and
  // object-shaped once the "resolve" above has fired.
  const port = (address as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

/**
 * The real `BrowserLauncher`: launches actual headless Chromium via
 * Playwright, using `DEFAULT_GPU_LAUNCH_ARGS` plus any `extraArgs`.
 *
 * Kept as a named, separately-exported function (rather than inlined as
 * `render-composition-headless-server.ts`'s default) so a caller can import
 * and use it directly outside of `renderCompositionHeadlessServer` too, e.g.
 * to launch a long-lived browser once and reuse it across many renders
 * instead of paying Chromium's startup cost per render (a future
 * optimization outside this phase's scope, but this seam does not foreclose
 * it).
 *
 * Imports `playwright` via a dynamic `await import("playwright")` inside
 * this function's own body, deliberately not as a static top-level `import`
 * at this module's top: `@cadra/headless`'s package template (matching
 * every other package in this workspace) exposes only a single `"."`
 * `exports` subpath, so anything importing `renderComposition` from this
 * package's barrel (e.g. `@cadra/encode`'s browser-side
 * `browser-headless-render-entry.ts`, esbuild-bundled for a browser target;
 * see `bundle-browser-entry.ts`'s own doc) necessarily pulls in this whole
 * module too, transitively, through the same barrel. A static top-level
 * `import { chromium } from "playwright"` here would make Chromium's
 * genuinely Node-only real dependency (`playwright` itself, which reaches
 * into `node:fs`/`node:crypto`/`child_process`/... at module-evaluation
 * time, not lazily) execute unconditionally the instant that bundle loads
 * in a real browser page, throwing immediately, even though the browser-side
 * entry script never calls `launchPlaywrightHeadlessBrowser` at all. A
 * dynamic `import()` inside this function's body is, by contrast, an
 * ordinary function call from a bundler's perspective: it only executes if
 * this function is actually invoked, and (paired with marking `"playwright"`
 * external in `bundleBrowserEntry`'s esbuild options) is eliminated
 * entirely by tree-shaking from any bundle that never calls this function,
 * exactly the browser-side entry script's own case.
 *
 * Every page this returns is navigated (via `page.goto`) to a trivial blank
 * page served by a local HTTP server (`startLocalSecureContextServer`)
 * before being handed back, rather than left on Playwright's default blank
 * page. This is required, not cosmetic: WebCodecs' `VideoEncoder`/
 * `VideoDecoder` (unlike `VideoFrame`, a plain data container with no such
 * restriction) are only defined on `window` inside a secure context, and
 * Playwright's own default new-page state (`about:blank`, and likewise a
 * plain `page.addScriptTag`/`page.setContent` call with no prior
 * navigation) is not one (`window.isSecureContext` is `false`, `origin` is
 * `"null"`), verified directly against this exact Playwright/Chromium
 * build while building this phase: `runBrowserHeadlessRender`'s real
 * `encodeFrames` call failed with `WebCodecsUnavailableForEncodingError`
 * until this navigation was added. `http://127.0.0.1` (like
 * `http://localhost`) is one of the standard "potentially trustworthy
 * origins" the Secure Contexts spec carves out for exactly this kind of
 * local, loopback-only use, without needing a real TLS certificate.
 */
export const launchPlaywrightHeadlessBrowser: BrowserLauncher = async (options) => {
  const { chromium } = await import("playwright");
  const args = [...DEFAULT_GPU_LAUNCH_ARGS, ...(options.extraArgs ?? [])];
  const browser = await chromium.launch({ headless: true, args });
  const secureContextServer = await startLocalSecureContextServer();

  return {
    async newPage(): Promise<HeadlessPageLike> {
      const page = await browser.newPage();
      await page.goto(secureContextServer.url);
      return {
        exposeFunction: async (name, fn) => {
          // Playwright's own exposeFunction resolves with a `Disposable`
          // (lets a caller later un-expose the function); this package's
          // narrower `HeadlessPageLike.exposeFunction` never needs that
          // handle back, matching every other Playwright call this adapter
          // narrows down to just the return shape actually used elsewhere
          // in this file.
          await page.exposeFunction(name, fn);
        },
        onConsoleMessage: (handler) => {
          page.on("console", (message) => handler(toConsoleMessageLike(message)));
        },
        onPageError: (handler) => {
          page.on("pageerror", handler);
        },
        evaluate: <Arg, Result>(pageFunction: (arg: Arg) => Result | Promise<Result>, arg: Arg) =>
          // Playwright's own `page.evaluate` overloads type `pageFunction`'s
          // parameter as `Unboxed<Arg>` (its internal JSHandle-unwrapping
          // transform), which is stricter than the plain `(arg: Arg) =>
          // Result` shape `HeadlessPageLike.evaluate` declares. At runtime
          // `page.evaluate` simply structured-clones `arg` across the
          // page boundary and calls `pageFunction` with the clone, exactly
          // matching this interface's own documented contract, so this cast
          // only bridges an overly-specific upstream generic, not an actual
          // behavioral mismatch.
          page.evaluate(pageFunction as (arg: unknown) => Result | Promise<Result>, arg),
        addScript: async (source) => {
          await page.addScriptTag({ content: source });
        },
      };
    },
    onDisconnected: (handler) => {
      browser.on("disconnected", handler);
    },
    close: async () => {
      await browser.close();
      await secureContextServer.close();
    },
  };
};
