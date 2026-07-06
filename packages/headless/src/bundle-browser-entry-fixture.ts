import { PACKAGE_NAME } from "./index.js";

/**
 * A tiny, real fixture entry point for `bundle-browser-entry.test.ts`: not
 * itself part of this package's public surface (not re-exported from
 * `index.ts`), it exists purely so that test can bundle *something* real
 * (with a real cross-module import, proving `bundle: true` actually
 * resolves and inlines it, not just passes a trivial single-file
 * script through unchanged) without depending on `@cadra/encode`'s much
 * larger real entry point (which would make this package's own fast unit
 * test suite pay `@cadra/renderer`/Three.js's full bundle cost on every
 * test run).
 */
export function fixtureGreeting(): string {
  return `hello from ${PACKAGE_NAME}`;
}
