/**
 * The absolute filesystem path to this package's own compiled
 * `browser-headless-render-entry.js`, for a Node-side caller to hand to
 * `@cadra/headless`'s `bundleBrowserEntry` (esbuild's `entryPoints`).
 *
 * Resolved via `import.meta.url` (this module's own compiled location under
 * `dist/`) rather than a hardcoded relative path from some assumed monorepo
 * layout: this makes the path correct whether `@cadra/encode` is consumed
 * from within this workspace (`workspace:*`) or as a real installed
 * dependency from a registry, exactly mirroring how every other
 * workspace-to-workspace package resolution in this repo already goes
 * through each package's own `dist/` output (see this package's own
 * `package.json#main`/`#exports`), not raw `src/` TypeScript.
 *
 * `new URL(...).pathname` (not `node:url`'s `fileURLToPath`) deliberately:
 * this file is a plain ESM module with no Node-specific import, consistent
 * with this package's `tsconfig.base.json` `lib` (`DOM`, no `@types/node`),
 * even though in practice only a Node-side orchestrator ever imports this
 * particular export (never the browser bundle itself, which has no reason
 * to know its own entry file's path).
 */
export const BROWSER_HEADLESS_RENDER_ENTRY_PATH: string = new URL(
  "./browser-headless-render-entry.js",
  import.meta.url,
).pathname;
