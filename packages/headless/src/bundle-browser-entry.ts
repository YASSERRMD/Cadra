/**
 * `window` global name the bundled entry script's exports are attached
 * under (esbuild's `globalName` option), e.g.
 * `window.__cadraHeadlessEntry.runBrowserHeadlessRender(config)`. Fixed
 * (not configurable) since the server orchestrator (this package's own
 * `render-composition-headless-server.ts`) is the only caller that ever
 * reads this name back, so nothing is gained by making it a knob and a
 * fixed name keeps every render's injected bundle callable the same way.
 */
export const BROWSER_ENTRY_GLOBAL_NAME = "__cadraHeadlessEntry";

/**
 * Bundles a single browser-side entry file (e.g. one that constructs a real
 * `createRenderer()`/`readPixels`, drives `renderComposition`, and pipes
 * frames through `@cadra/encode`'s capture/encode/mux pipeline) into one
 * self-contained script, suitable for injecting into a page via
 * `HeadlessPageLike.addScript`/Playwright's `page.addScriptTag`, with its
 * exports reachable at `window[BROWSER_ENTRY_GLOBAL_NAME]`.
 *
 * This package (`@cadra/headless`) deliberately does not itself depend on
 * `@cadra/encode`: `@cadra/encode` already depends on `@cadra/headless` (for
 * `RenderedFrame`/`renderComposition`'s types), so the reverse edge would be
 * a circular workspace dependency. Instead, the actual entry file that
 * imports `@cadra/encode`'s `captureFrames`/`encodeFrames`/`muxToMp4Stream`/
 * `muxToWebmStream` lives inside `@cadra/encode` itself (see its own
 * `browser-headless-render-entry.ts`, exported from its barrel as a plain
 * file-path string, `BROWSER_HEADLESS_RENDER_ENTRY_PATH`), and this function
 * only ever needs a path on disk to point esbuild at, not a compile-time
 * import of whatever that file imports. This mirrors the rest of this
 * package's other injectable seams (`BrowserLauncher`, `ReadPixelsFn`
 * elsewhere in the workspace): the capability is provided by the caller
 * assembling the full pipeline, not hardcoded as this package's own default.
 *
 * `platform: "browser"` and `format: "iife"` (with `globalName` set): the
 * bundle runs directly inside a page via a `<script>` tag (not `import`-ed
 * as an ES module), so every workspace package it pulls in (`@cadra/core`,
 * `@cadra/renderer`, `@cadra/headless`, `@cadra/encode`, `mp4-muxer`,
 * `webm-muxer`, ...) is inlined into one flat script with no runtime
 * `import`/`require` calls left over, Node-only conditions in any
 * dependency's `package.json#exports` are not selected, and the entry
 * file's own exports (e.g. `runBrowserHeadlessRender`) become reachable as
 * `window[BROWSER_ENTRY_GLOBAL_NAME].runBrowserHeadlessRender` rather than
 * being trapped inside the IIFE's closure with no way to call them.
 *
 * `bundle: true` pulls in every workspace/npm dependency the entry file
 * imports (this repo's packages already build to plain ESM `dist/` per this
 * codebase's package template, which esbuild resolves like any other npm
 * package); `minify: false` keeps output readable for debugging a failed
 * render (a real trade against payload size, but this bundle never leaves
 * the local machine over a network, so the usual "smaller is better for a
 * page load" motivation for minifying does not apply here).
 *
 * `logOverride: { "empty-import-meta": "silent" }` suppresses one specific,
 * verified-benign esbuild warning: `@cadra/renderer`'s optional Web Worker
 * rendering path (`worker/worker-renderer.js`) references `import.meta.url`
 * to locate its worker script, which is meaningless in an IIFE bundle (no
 * ES module context) and would otherwise print a warning on every single
 * bundle build. That code path is never invoked by this phase's entry
 * script (`browser-headless-render-entry.ts` calls the direct
 * `createRenderer()`/`createPixelReadableRenderer()` path, never
 * `createWorkerRenderer`/`createBestAvailableRenderer`), so the resulting
 * empty `import.meta` value is simply unreachable dead code, not a real
 * defect; the warning is pulled in only because `bundle: true` traverses
 * `@cadra/renderer`'s whole barrel, not just the specific exports this
 * entry file actually calls.
 *
 * `external: ["playwright", "esbuild", "node:http"]`, combined with each of
 * those being imported dynamically (`await import(...)` inside a function
 * body, not a static top-level `import`) at their own real call sites
 * (`browser-launcher.ts`'s `launchPlaywrightHeadlessBrowser`/
 * `startLocalSecureContextServer`, and this very function below), is what
 * keeps this package's single-barrel `exports` shape (see `package.json`,
 * matching every other package in this workspace: only a `"."` subpath, no
 * way to import `render-composition.js` directly while bypassing
 * `browser-launcher.ts`/`render-composition-headless-server.ts`) from
 * forcing genuinely Node-only code into a browser bundle. A caller like
 * `@cadra/encode`'s `browser-headless-render-entry.ts` imports
 * `renderComposition`/`CompositionNotFoundForRenderError`/`OnProgressFn`
 * from this package's barrel, which (through that same barrel) also
 * transitively reaches `browser-launcher.ts` and this module. Marking
 * `external` alone is not sufficient on its own: it only stops esbuild
 * from erroring while bundling, but a *static* top-level `import` would
 * still compile down to an unconditional `require("playwright")`/
 * `require("esbuild")`/`require("node:http")` call that executes the
 * instant the bundle loads in a real page, throwing immediately (verified
 * against a real headless Chromium page while building this phase), even
 * though the browser-side entry script never calls
 * `launchPlaywrightHeadlessBrowser`/`bundleBrowserEntry`/
 * `startLocalSecureContextServer` itself. A *dynamic* `import()` inside a
 * function body, by contrast, is just an ordinary function call from a
 * bundler's perspective: paired with `external`, it is dropped entirely by
 * tree-shaking from any bundle whose reachable code never actually calls
 * that function, which is exactly the browser-side entry script's case (it
 * only ever reaches `renderComposition`, never this package's own Node-side
 * launcher/bundler/local-server functions).
 */
export interface BundleBrowserEntryOptions {
  /**
   * Absolute path to the entry `.ts`/`.js` file to bundle. Must resolve
   * every import it makes (workspace packages included) via normal Node
   * module resolution from its own location, exactly as `esbuild`'s
   * `entryPoints` option requires.
   */
  entryFilePath: string;
}

/**
 * Runs `esbuild`'s `build` API against `options.entryFilePath`, returning the
 * bundled script's source as a single string (`write: false`, so nothing is
 * written to disk; the caller injects the returned string directly into a
 * page). The entry file's exports are reachable at
 * `window[BROWSER_ENTRY_GLOBAL_NAME]` once the returned source runs inside a
 * page.
 *
 * Imports `esbuild` via a dynamic `await import("esbuild")` inside this
 * function's own body, not a static top-level `import`, for the same
 * reason `browser-launcher.ts`'s `launchPlaywrightHeadlessBrowser` does the
 * same for `playwright`; see this module's own doc above and that
 * function's doc for the full rationale.
 *
 * @throws whatever `esbuild.build` itself throws on a bundling failure (a
 *   syntax error, an unresolvable import, ...): this function adds no
 *   additional error wrapping, since esbuild's own error messages already
 *   name the offending file/line directly.
 */
export async function bundleBrowserEntry(options: BundleBrowserEntryOptions): Promise<string> {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [options.entryFilePath],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    minify: false,
    globalName: BROWSER_ENTRY_GLOBAL_NAME,
    logOverride: { "empty-import-meta": "silent" },
    external: ["playwright", "esbuild", "node:http"],
  });

  const outputFile = result.outputFiles[0];
  if (outputFile === undefined) {
    // Cannot happen with a single entryPoints/write:false/no code-splitting
    // configuration: esbuild always produces exactly one in-memory output
    // file for exactly one entry point in this shape. Guarded rather than
    // asserted so a future esbuild upgrade that changes this invariant fails
    // with a clear message here instead of a confusing "undefined" crash at
    // the call site.
    throw new Error(
      "bundleBrowserEntry: esbuild produced no output file for the given entry point.",
    );
  }

  return outputFile.text;
}
