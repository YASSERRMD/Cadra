import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite configuration for the studio app. Unlike every other package/app in
 * this workspace (which build via a plain `tsc -p tsconfig.json`, producing
 * a `dist/` of compiled `.js`/`.d.ts` for other workspace packages to
 * import), studio is a real browser application with a dev server, not a
 * library another package depends on, so it needs a bundler instead.
 * `@vitejs/plugin-react` provides the JSX transform (and Fast Refresh in
 * dev); type checking itself still runs separately via `tsc --noEmit -p
 * tsconfig.typecheck.json` (the `typecheck` script), matching this
 * codebase's existing separation of "does it build" from "does it type
 * check" for every other package.
 */
export default defineConfig({
  plugins: [react()],
});
