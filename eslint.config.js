// @ts-check
import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Wall-clock and unseeded-random APIs that break frame determinism: reading
 * any of them from scene/frame-evaluation source would make a frame's
 * output depend on when or how fast it happened to run, rather than being a
 * pure function of a `FrameContext`. Shared as a list (rather than inlined
 * into a single rule config) so a later phase can reuse it verbatim in a
 * second `no-restricted-properties` block scoped to a different `files`
 * glob, once other packages (renderer, player, headless) grow their own
 * scene-evaluation code.
 *
 * @type {Array<{ object: string, property: string, message: string }>}
 */
const NON_DETERMINISTIC_PROPERTY_RESTRICTIONS = [
  {
    object: "Date",
    property: "now",
    message:
      "Date.now() is wall-clock time and non-deterministic. Derive time from a FrameContext (frame / fps) instead.",
  },
  {
    object: "performance",
    property: "now",
    message:
      "performance.now() is wall-clock time and non-deterministic. Derive time from a FrameContext (frame / fps) instead.",
  },
  {
    object: "Math",
    property: "random",
    message:
      "Math.random() is unseeded and non-deterministic. Use FrameContext.random() (or createFrameRandom) for reproducible per-frame randomness instead.",
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "temp/**",
      "pnpm-lock.yaml",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    plugins: {
      import: importPlugin,
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      "import/first": "error",
      "import/newline-after-import": "error",
      "import/no-duplicates": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: [
      "scripts/**/*.mjs",
      "packages/*/scripts/**/*.mjs",
      "*.config.js",
      "*.config.mjs",
      "*.config.ts",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Scoped to Phase 2/3's scene-graph and frame-evaluation source, plus
    // Phase 5's renderer (its renderFrame path is scene-evaluation code
    // too: it must be a pure function of sceneState/frameContext), Phase
    // 18's headless render loop (it walks every frame with no
    // requestAnimationFrame and no live playhead, so unlike
    // packages/player's Transport, which legitimately reads
    // performance.now() to anchor its wall-clock-paced tick loop, nothing in
    // headless's own frame walk has a legitimate reason to touch a wall
    // clock or unseeded randomness at all), and Phase 19's frame capture
    // (its VideoFrame timestamps are derived purely from frame index and
    // fps; a wall clock or unseeded randomness leaking in would break the
    // same byte-for-byte reproducibility headless rendering guarantees).
    // Extend this `files` list with further `packages/<name>/src/**/*.ts`
    // globs as later phases grow their own scene-evaluation code; the
    // restriction list above needs no changes.
    files: [
      "packages/core/src/**/*.ts",
      "packages/renderer/src/**/*.ts",
      "packages/headless/src/**/*.ts",
      "packages/encode/src/**/*.ts",
      "packages/text/src/**/*.ts",
    ],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-properties": ["error", ...NON_DETERMINISTIC_PROPERTY_RESTRICTIONS],
    },
  },
  prettierConfig,
);
