/**
 * The absolute filesystem path to this package's own compiled
 * `browser-render-entry.js`, for a Node-side caller to hand to
 * `@cadra/headless`'s `bundleBrowserEntry` (esbuild's `entryPoints`).
 *
 * Resolved via `import.meta.url` (this module's own compiled location
 * under `dist/`) rather than a hardcoded relative path, mirroring
 * `@cadra/encode`'s own `browser-headless-render-entry-path.ts`: this
 * makes the path correct whether this package is consumed from within this
 * workspace or as a real installed dependency, and points esbuild at the
 * same compiled `dist/` output every other workspace-to-workspace package
 * resolution in this repo already goes through.
 */
export const BROWSER_RENDER_ENTRY_PATH: string = new URL(
  "./browser-render-entry.js",
  import.meta.url,
).pathname;
