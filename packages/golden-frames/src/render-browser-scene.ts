import {
  BROWSER_ENTRY_GLOBAL_NAME,
  type BrowserLauncher,
  bundleBrowserEntry,
  launchPlaywrightHeadlessBrowser,
} from "@cadra/headless";
import type { PixelBuffer } from "@cadra/renderer";

import type { BrowserGoldenFrameConfig, SerializedPixelBuffer } from "./browser-render-entry.js";
import { BROWSER_RENDER_ENTRY_PATH } from "./browser-render-entry-path.js";
import type { GoldenScene } from "./scenes/golden-scene.js";

/**
 * Renders one `driver: "browser"` `GoldenScene` to a `PixelBuffer`, via a
 * real headless-Chromium page (`launchPlaywrightHeadlessBrowser` by
 * default): bundles `browser-render-entry.ts` (esbuild, via
 * `@cadra/headless`'s `bundleBrowserEntry`), injects it into a fresh page,
 * and calls its exported `renderGoldenFrameInBrowser` through
 * `page.evaluate`, which does the actual rendering entirely inside the
 * page and returns the target frame's pixels directly - no
 * `exposeFunction`/streaming bridge needed, unlike
 * `renderCompositionHeadlessServer`'s full MP4-muxing pipeline, since a
 * single frame's pixels comfortably cross `page.evaluate`'s own
 * structured-clone return-value boundary in one call.
 *
 * `launcher` is injectable (defaults to real Playwright/Chromium) purely so
 * a future test of this driver itself can supply a fake `HeadlessBrowserLike`,
 * matching every other real-browser seam in this codebase
 * (`renderCompositionHeadlessServer`'s own `options.launcher`).
 */
export async function renderBrowserGoldenScene(
  scene: GoldenScene,
  launcher: BrowserLauncher = launchPlaywrightHeadlessBrowser,
): Promise<PixelBuffer> {
  const entrySource = await bundleBrowserEntry({ entryFilePath: BROWSER_RENDER_ENTRY_PATH });
  const browser = await launcher({});

  try {
    const page = await browser.newPage();
    await page.addScript(entrySource);

    const config: BrowserGoldenFrameConfig = {
      project: scene.buildProject(),
      compositionId: scene.compositionId,
      frame: scene.frame,
      width: scene.width,
      height: scene.height,
      seed: scene.seed,
    };

    // `globalName` travels inside the structured-cloned `arg`, not as a
    // free variable `pageFunction` closes over: see
    // `render-composition-headless-server.ts`'s own identical comment for
    // why a closed-over outer binding does not survive Playwright's real
    // `page.evaluate` (it re-executes `pageFunction`'s source *inside* the
    // page, with no access to this module's enclosing scope).
    const serialized = await page.evaluate(
      (arg: { config: BrowserGoldenFrameConfig; globalName: string }) => {
        const entry = (
          window as unknown as Record<
            string,
            { renderGoldenFrameInBrowser: (config: BrowserGoldenFrameConfig) => Promise<SerializedPixelBuffer> } | undefined
          >
        )[arg.globalName];
        if (entry === undefined) {
          throw new Error(
            `renderBrowserGoldenScene: window["${arg.globalName}"] was not defined; the bundled entry script did not load correctly before evaluate() ran.`,
          );
        }
        return entry.renderGoldenFrameInBrowser(arg.config);
      },
      { config, globalName: BROWSER_ENTRY_GLOBAL_NAME },
    );

    return {
      width: serialized.width,
      height: serialized.height,
      data: Uint8ClampedArray.from(serialized.data),
    };
  } finally {
    await browser.close();
  }
}
