import { defineConfig } from "vitest/config";

/**
 * Shared Vitest base configuration extended by every package and app.
 * Keeps per-package vitest.config.ts files minimal.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
  },
});
