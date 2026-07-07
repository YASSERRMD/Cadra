import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.base";

/**
 * Overrides the shared base's `environment: "node"` with `"jsdom"`: unlike
 * every other package in this workspace (whose test suites are almost
 * entirely pure logic, opting a handful of individual DOM-touching files
 * into jsdom via a per-file `// @vitest-environment jsdom` docblock, see
 * `@cadra/player`'s `mount-preview.test.ts`), studio is a React application
 * whose test suite is overwhelmingly component/DOM tests, so jsdom is set
 * globally here rather than repeating the per-file opt-in comment across
 * nearly every test file in this package.
 *
 * Also widens the shared base's `include` (`src/**\/*.test.ts`) to also
 * match `.test.tsx`: studio is the first package/app in this workspace with
 * JSX test files (component tests), which the base glob does not cover.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "studio",
      environment: "jsdom",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      setupFiles: ["./src/test-setup.ts"],
    },
  }),
);
