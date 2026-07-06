import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { BROWSER_ENTRY_GLOBAL_NAME, bundleBrowserEntry } from "./bundle-browser-entry.js";

/**
 * These tests exercise real `esbuild` (no fake/mock): esbuild is a fast,
 * fully local, deterministic bundler with no network or browser dependency,
 * unlike this package's `BrowserLauncher` seam (which does need a fake for
 * most tests; see `render-composition-headless-server.test.ts`), so there is
 * no reason to inject a fake bundler here too. `bundle-browser-entry-fixture.ts`
 * is a small real fixture (with a real cross-module import) built
 * specifically for this test file; see its own doc for why it exists
 * separately from `@cadra/encode`'s much larger real entry point.
 */
describe("bundleBrowserEntry", () => {
  it("bundles a real entry file (with a real cross-module import) into a single script string", async () => {
    const fixturePath = new URL("./bundle-browser-entry-fixture.ts", import.meta.url).pathname;

    const source = await bundleBrowserEntry({ entryFilePath: fixturePath });

    expect(typeof source).toBe("string");
    expect(source.length).toBeGreaterThan(0);
    // The fixture's own imported constant ("@cadra/headless") must appear
    // inlined somewhere in the bundle: proof bundle:true actually resolved
    // and inlined the cross-module import, not just passed the entry file
    // through unchanged with an unresolved import statement left in it.
    expect(source).toContain("@cadra/headless");
  });

  it("attaches the entry file's exports to window[BROWSER_ENTRY_GLOBAL_NAME] when the bundle runs", async () => {
    const fixturePath = new URL("./bundle-browser-entry-fixture.ts", import.meta.url).pathname;
    const source = await bundleBrowserEntry({ entryFilePath: fixturePath });

    // Executes the real bundled output via node:vm's createContext/
    // runInContext, not a plain `new Function("window", source)`: the
    // bundle's IIFE assigns its exports with a bare top-level `var
    // __cadraHeadlessEntry = ...` (esbuild's globalName output shape,
    // matching how a real `<script>` tag's top-level `var` becomes a
    // property of the page's real `window` object), which only attaches to
    // an arbitrary object passed as a same-named ordinary function
    // parameter if that parameter genuinely *is* the running scope's global
    // object. `vm.createContext` makes a plain object behave as a real
    // JavaScript global object for code run against it via
    // `runInContext`, which is what correctly reproduces that "top-level
    // var becomes a global property" semantic here; a bare `new Function`
    // call does not; this distinction was caught by this exact test failing
    // silently (an `undefined` read, not a thrown error) before switching
    // to `vm`.
    const context = createContext({});
    runInContext(source, context);

    const entryExports = (context as Record<string, unknown>)[BROWSER_ENTRY_GLOBAL_NAME] as
      | { fixtureGreeting?: () => string }
      | undefined;
    expect(entryExports?.fixtureGreeting?.()).toBe("hello from @cadra/headless");
  });

  it("rejects when the entry file does not exist", async () => {
    await expect(
      bundleBrowserEntry({ entryFilePath: "/definitely/does/not/exist.ts" }),
    ).rejects.toThrow();
  });
});
