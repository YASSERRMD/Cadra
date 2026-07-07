/**
 * Vitest setup file for this package, loaded once before every test file
 * (wired via `vitest.config.ts`'s `test.setupFiles`).
 *
 * Sets the global flag React itself checks to decide whether it is running
 * inside a test environment that knows how to flush effects/updates
 * synchronously within `act(...)` (see `react`'s own `act` implementation):
 * without it, every `act(...)` call in this package's component tests (see
 * `App.test.tsx`, `Viewport.test.tsx`, `Toolbar.test.tsx`,
 * `stub-panels.test.tsx`) logs a spurious "not configured to support act"
 * warning, even though the tests themselves already pass correctly. This is
 * the one global flag React's own act() implementation looks for; it is not
 * specific to any particular testing library (React Testing Library sets
 * this same flag internally, but this package deliberately has no
 * dependency on RTL, see this package's own persistence/store tests for why
 * a plain `react-dom/client` + `act` setup is sufficient here).
 */
declare global {
  // `var` (not `let`/`const`) is required here: this is the standard
  // TypeScript idiom for declaring an ambient property on `globalThis`.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
