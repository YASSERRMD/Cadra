import { readFileSync } from "node:fs";

import { BROWSER_ENTRY_GLOBAL_NAME, bundleBrowserEntry, launchPlaywrightHeadlessBrowser } from "@cadra/headless";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import { BROWSER_HEADLESS_RENDER_ENTRY_PATH } from "./browser-headless-render-entry-path.js";

/**
 * This test lives in `@cadra/encode` for the same reason
 * `render-composition-headless-server.e2e.test.ts` does: see that file's
 * own doc for the full rationale (in short, `BROWSER_HEADLESS_RENDER_ENTRY_PATH`
 * is only resolvable from inside `@cadra/encode` itself).
 *
 * Whether real Chromium is available in this environment, mirroring
 * `render-composition-headless-server.e2e.test.ts`'s own
 * `isRealChromiumAvailable` exactly (see that file's doc for the full
 * rationale for this guard shape).
 */
function isRealChromiumAvailable(): boolean {
  try {
    const executablePath = chromium.executablePath();
    readFileSync(executablePath);
    return true;
  } catch {
    return false;
  }
}

const chromiumAvailable = isRealChromiumAvailable();

/** Small and comfortably interior: axis-aligned fillRect at integer coordinates has no anti-aliased edge pixels to worry about. */
const SIZE = { width: 24, height: 24 };
const BOX_A = { x: 2, y: 2, w: 6, h: 6, color: [255, 0, 0] as const };
const BOX_B = { x: 16, y: 16, w: 6, h: 6, color: [0, 0, 255] as const };
/** Sample points well inside each box, far from its edges and from the other box. */
const POINT_A = { x: 5, y: 5 };
const POINT_B = { x: 19, y: 19 };
const TRANSPARENT = [0, 0, 0, 0];

/** Reads one RGBA pixel out of a flat, top-left-origin RGBA8 buffer, mirroring `PixelBuffer`'s own documented layout. */
function pixelAt(data: readonly number[], width: number, x: number, y: number): readonly number[] {
  const index = (y * width + x) * 4;
  return data.slice(index, index + 4);
}

/**
 * Regression coverage for the real, non-mocked `createRealReadPixels`
 * (the browser-side snapshot-canvas `readPixels` every real headless render
 * uses): a render's snapshot canvas is created once and only resized (never
 * recreated) across an entire render's worth of frames, and a resize to the
 * *same* size (every frame after the first, for any render at a constant
 * resolution) does not implicitly clear it. Without a `clearRect` before
 * each frame's `drawImage`, a render target that clears to transparent
 * between frames (the common case: only actual geometry is opaque) leaves
 * every earlier frame's opaque pixels composited into the readback forever,
 * silently corrupting every real multi-frame render's output.
 *
 * Exercises the real exported `createRealReadPixels` inside a real
 * Chromium page (via the same `bundleBrowserEntry`/
 * `launchPlaywrightHeadlessBrowser` real-browser plumbing every other e2e
 * test in this file's sibling suite uses), fed synthetic frames directly
 * rather than a full render/encode/mux pass: this isolates the assertion to
 * exactly the function the bug lives in, with no WebGL/WebGPU renderer,
 * WebCodecs encoder, or muxer in the loop to obscure a failure or make the
 * test flaky/slow.
 */
describe("createRealReadPixels: cross-frame contamination regression", () => {
  it(
    "does not composite a previous frame's opaque pixels into a region the current frame leaves transparent",
    async () => {
      if (!chromiumAvailable) {
        console.log(
          "createRealReadPixels e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
        );
        return;
      }

      const entrySource = await bundleBrowserEntry({
        entryFilePath: BROWSER_HEADLESS_RENDER_ENTRY_PATH,
      });
      const browser = await launchPlaywrightHeadlessBrowser({});
      try {
        const page = await browser.newPage();
        await page.addScript(entrySource);

        const frames = await page.evaluate(
          async (arg: {
            globalName: string;
            size: { width: number; height: number };
            boxes: Array<{ x: number; y: number; w: number; h: number; color: readonly number[] }>;
          }) => {
            const entry = (
              window as unknown as Record<
                string,
                | {
                    createRealReadPixels: () => (
                      target: HTMLCanvasElement,
                      size: { width: number; height: number },
                    ) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
                  }
                | undefined
              >
            )[arg.globalName];
            if (entry === undefined) {
              throw new Error(`window["${arg.globalName}"] was not defined.`);
            }

            // The real function under test, called exactly as
            // `buildEncodedChunksForRange` itself calls it: once, up front,
            // reusing the one closure (and its one snapshot canvas) across
            // every frame below.
            const readPixels = entry.createRealReadPixels();

            // One real target canvas, reused and redrawn every "frame",
            // exactly like the real render loop's single persistent render
            // canvas: only its content changes between calls, never its
            // identity or size.
            const targetCanvas = document.createElement("canvas");
            targetCanvas.width = arg.size.width;
            targetCanvas.height = arg.size.height;
            const targetContext = targetCanvas.getContext("2d");
            if (targetContext === null) {
              throw new Error("Failed to acquire a 2D context for the synthetic target canvas.");
            }

            // Sequential, not Promise.all/map: a real render always drives
            // frames one at a time, and this loop's own correctness
            // (mutating the shared targetCanvas between reads) depends on
            // each readPixels call fully finishing before the next frame is
            // drawn.
            const capturedFrames: number[][] = [];
            for (const box of arg.boxes) {
              // Transparent background, exactly like a WebGL/WebGPU render
              // target cleared to (0,0,0,0) with only actual geometry drawn
              // opaque: this is what makes the missing-`clearRect` bug
              // observable at all (a source that is opaque everywhere would
              // fully overwrite the snapshot regardless of whether it was
              // cleared first).
              targetContext.clearRect(0, 0, arg.size.width, arg.size.height);
              targetContext.fillStyle = `rgb(${box.color[0]}, ${box.color[1]}, ${box.color[2]})`;
              targetContext.fillRect(box.x, box.y, box.w, box.h);

              const pixels = await readPixels(targetCanvas, arg.size);
              capturedFrames.push(Array.from(pixels.data));
            }

            return capturedFrames;
          },
          {
            globalName: BROWSER_ENTRY_GLOBAL_NAME,
            size: SIZE,
            // Box A, then box B (A moves fully out of frame), then box A
            // again: three frames is enough to prove both "a vacated region
            // clears" and "it stays clear/correct across more than one
            // subsequent frame," not just a single before/after pair.
            boxes: [BOX_A, BOX_B, BOX_A],
          },
        );

        expect(frames).toHaveLength(3);
        for (const frame of frames) {
          expect(frame).toHaveLength(SIZE.width * SIZE.height * 4);
        }

        const [frame0, frame1, frame2] = frames as [number[], number[], number[]];

        // Frame 0: only box A has ever been drawn. Box B's region has
        // never had anything drawn there, so it must read back transparent.
        expect(pixelAt(frame0, SIZE.width, POINT_A.x, POINT_A.y)).toEqual([...BOX_A.color, 255]);
        expect(pixelAt(frame0, SIZE.width, POINT_B.x, POINT_B.y)).toEqual(TRANSPARENT);

        // Frame 1: box A has moved fully away to box B's position. This is
        // the critical regression assertion: box A's now-vacated region
        // must read back transparent (background), not still show box A's
        // opaque color left over from frame 0's snapshot.
        expect(pixelAt(frame1, SIZE.width, POINT_B.x, POINT_B.y)).toEqual([...BOX_B.color, 255]);
        expect(pixelAt(frame1, SIZE.width, POINT_A.x, POINT_A.y)).toEqual(TRANSPARENT);

        // Frame 2: box A returns; box B's region (vacated this time) must
        // likewise read back transparent, proving the fix holds across
        // more than one frame transition, not just the first.
        expect(pixelAt(frame2, SIZE.width, POINT_A.x, POINT_A.y)).toEqual([...BOX_A.color, 255]);
        expect(pixelAt(frame2, SIZE.width, POINT_B.x, POINT_B.y)).toEqual(TRANSPARENT);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});
