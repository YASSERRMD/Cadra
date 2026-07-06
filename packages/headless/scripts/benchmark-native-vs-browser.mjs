#!/usr/bin/env node
/**
 * Benchmarks Phase 24's experimental native GPU headless render path
 * (`createNativeGpuHeadlessRenderer`, no browser process) against Phase 23's
 * existing Playwright/headless-Chromium path, rendering the same small
 * scene both ways and reporting wall-clock render time plus process memory
 * for each.
 *
 * This is a standalone diagnostic script, not part of this package's
 * `build`/`typecheck`/`lint`/`test` scripts: a real browser launch plus a
 * real native GPU device acquisition is legitimately slow and platform-
 * dependent (see `render-frame-native-gpu.e2e.test.ts`'s own doc for why
 * that test itself skips cleanly rather than failing when the native
 * binding cannot initialize), so this script is kept out of `pnpm -w test`'s
 * critical path entirely, the same way Phase 23 already keeps its own real-
 * browser coverage to a small, explicitly-guarded e2e test rather than
 * running a full browser launch in every unit test.
 *
 * Usage (from this package's own directory, after `pnpm -w build`):
 *   node scripts/benchmark-native-vs-browser.mjs
 *
 * The numbers this script produced on the one machine (Darwin/arm64) this
 * phase was built and verified on are recorded in
 * `docs/adr/0001-native-gpu-headless-render-path.md`'s own "Benchmark"
 * section; re-running this script on a different machine/GPU/driver will
 * produce different absolute numbers (that is expected; only the general
 * shape, native avoids a second heavyweight process while paying a smaller
 * fixed per-process cost, should generalize).
 */

import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import {
  createComposition,
  createFrameContext,
  createProject,
  resolveSceneAtFrame,
  Sequence,
  Shape,
} from "@cadra/core";
import { createNativeGpuHeadlessRenderer } from "@cadra/headless";
import { chromium } from "playwright";

const WIDTH = 640;
const HEIGHT = 360;
const FRAME_COUNT = 30;
const FPS = 30;

const DEFAULT_GPU_LAUNCH_ARGS = [
  "--headless=new",
  "--use-angle=swiftshader",
  "--use-gl=angle",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
];

function fmtMs(value) {
  return `${value.toFixed(2)} ms`;
}
function fmtMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Builds the same small project every render path below draws: one seeded box mesh, no lights (see this script's own README note on why the render is still non-blank via its alpha channel). */
function buildBenchProject() {
  const shape = Shape({ id: "cube-1" });
  const composition = createComposition({
    id: "bench-comp",
    name: "Bench",
    fps: FPS,
    durationInFrames: FRAME_COUNT,
    width: WIDTH,
    height: HEIGHT,
    tracks: [
      {
        id: "track-1",
        clips: [Sequence({ id: "clip-1", from: 0, durationInFrames: FRAME_COUNT, content: shape })],
      },
    ],
  });
  return createProject({ id: "bench-project", name: "Bench", compositions: [composition] });
}

async function benchmarkNative() {
  const memBefore = process.memoryUsage().rss;
  const tStart = performance.now();

  const project = buildBenchProject();
  const renderer = createNativeGpuHeadlessRenderer();

  const tInitStart = performance.now();
  await renderer.init({}, { width: WIDTH, height: HEIGHT });
  const tInitEnd = performance.now();

  const frameTimes = [];
  let firstFrameAlphaVariety = 0;
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const tFrameStart = performance.now();
    const sceneState = resolveSceneAtFrame(project, "bench-comp", frame);
    const frameContext = createFrameContext({ frame, fps: FPS, durationInFrames: FRAME_COUNT, seed: "bench" });
    renderer.renderFrame(sceneState, frameContext);
    const pixels = await renderer.readPixels();
    frameTimes.push(performance.now() - tFrameStart);

    if (frame === 0) {
      const alphaValues = new Set();
      for (let i = 3; i < pixels.data.length; i += 4) alphaValues.add(pixels.data[i]);
      firstFrameAlphaVariety = alphaValues.size;
    }
  }

  renderer.dispose();

  const tEnd = performance.now();
  const memAfter = process.memoryUsage().rss;

  return {
    label: "native (webgpu package, no browser)",
    initMs: tInitEnd - tInitStart,
    totalFrameLoopMs: frameTimes.reduce((a, b) => a + b, 0),
    avgFrameMs: frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length,
    totalWallMs: tEnd - tStart,
    rssBeforeBytes: memBefore,
    rssAfterBytes: memAfter,
    rssDeltaBytes: memAfter - memBefore,
    nonBlankCheck: firstFrameAlphaVariety > 1,
  };
}

async function startLocalSecureContextServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><html><head></head><body></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** Sums RSS (KB) for every currently-running process whose command line matches `pattern`. */
function sumMatchingProcessRssKb(pattern) {
  let pids = [];
  try {
    pids = execSync(`pgrep -f "${pattern}"`, { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return { totalKb: 0, count: 0 };
  }
  let totalKb = 0;
  let count = 0;
  for (const pid of pids) {
    try {
      const rssKb = Number(execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8" }).trim());
      if (Number.isFinite(rssKb)) {
        totalKb += rssKb;
        count += 1;
      }
    } catch {
      // Process may have exited between listing and sampling; skip it.
    }
  }
  return { totalKb, count };
}

async function benchmarkBrowser() {
  const memBefore = process.memoryUsage().rss;
  const tStart = performance.now();

  // Bundles this very script's own browser-render logic on the fly, via a
  // small inline entry module, mirroring bundleBrowserEntry's own approach
  // (esbuild, IIFE, globalName) without needing a separate committed entry
  // file just for this benchmark.
  const { build } = await import("esbuild");
  const entryPath = fileURLToPath(new URL("./benchmark-browser-entry.mjs", import.meta.url));

  const tBundleStart = performance.now();
  const bundleResult = await build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    minify: false,
    globalName: "__cadraBenchEntry",
    logOverride: { "empty-import-meta": "silent" },
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  });
  const entrySource = bundleResult.outputFiles[0].text;
  const tBundleEnd = performance.now();

  const pidsBeforeLaunch = new Set(
    (() => {
      try {
        return execSync('pgrep -f "chrome-headless-shell"', { encoding: "utf8" })
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .map(Number);
      } catch {
        return [];
      }
    })(),
  );

  const tLaunchStart = performance.now();
  const browser = await chromium.launch({ headless: true, args: DEFAULT_GPU_LAUNCH_ARGS });
  const secureContextServer = await startLocalSecureContextServer();
  const page = await browser.newPage();
  await page.goto(secureContextServer.url);
  const tLaunchEnd = performance.now();

  await page.addScriptTag({ content: entrySource });

  const tRenderStart = performance.now();
  const pageResult = await page.evaluate(
    (arg) => window.__cadraBench.runBrowserBenchmark(arg.config),
    { config: { width: WIDTH, height: HEIGHT, frameCount: FRAME_COUNT, fps: FPS } },
  );
  const tRenderEnd = performance.now();

  const chromiumMem = sumMatchingProcessRssKb("chrome-headless-shell");
  const newChromiumPidCount = (() => {
    try {
      const after = execSync('pgrep -f "chrome-headless-shell"', { encoding: "utf8" })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number);
      return after.filter((pid) => !pidsBeforeLaunch.has(pid)).length;
    } catch {
      return 0;
    }
  })();

  await browser.close();
  await secureContextServer.close();

  const tEnd = performance.now();
  const memAfter = process.memoryUsage().rss;

  return {
    label: "browser (Playwright/headless-Chromium, Phase 23 path)",
    bundleMs: tBundleEnd - tBundleStart,
    launchMs: tLaunchEnd - tLaunchStart,
    initMs: pageResult.rendererInitMs,
    totalFrameLoopMs: pageResult.totalFrameLoopMs,
    avgFrameMs: pageResult.avgFrameMs,
    pageEvaluateRoundTripMs: tRenderEnd - tRenderStart,
    totalWallMs: tEnd - tStart,
    rssBeforeBytes: memBefore,
    rssAfterBytes: memAfter,
    rssDeltaBytes: memAfter - memBefore,
    chromiumProcessTreeRssKb: chromiumMem.totalKb,
    chromiumProcessCount: newChromiumPidCount,
    backend: pageResult.backend,
    nonBlankCheck: pageResult.nonBlankCheckPassed,
  };
}

async function main() {
  console.log(`Benchmarking a ${WIDTH}x${HEIGHT}, ${FRAME_COUNT}-frame render, both paths...\n`);

  console.log("Running native GPU path...");
  const native = await benchmarkNative();
  console.log("Running browser (Playwright/Chromium) path...");
  const browser = await benchmarkBrowser();

  console.log("\n=== NATIVE (webgpu package, no browser) ===");
  console.log("  Non-blank render check:", native.nonBlankCheck ? "PASS" : "FAIL");
  console.log("  Renderer init time:", fmtMs(native.initMs));
  console.log("  Total frame-loop time (" + FRAME_COUNT + " frames):", fmtMs(native.totalFrameLoopMs));
  console.log("  Average per-frame time:", fmtMs(native.avgFrameMs));
  console.log("  Total wall time:", fmtMs(native.totalWallMs));
  console.log("  Orchestrating process RSS delta:", fmtMB(native.rssDeltaBytes));
  console.log("  Orchestrating process RSS after:", fmtMB(native.rssAfterBytes));

  console.log("\n=== BROWSER (Playwright/headless-Chromium, Phase 23 path) ===");
  console.log("  Non-blank render check:", browser.nonBlankCheck ? "PASS" : "FAIL");
  console.log("  Resolved backend:", browser.backend);
  console.log("  esbuild bundle time:", fmtMs(browser.bundleMs));
  console.log("  Browser launch + navigation time:", fmtMs(browser.launchMs));
  console.log("  In-page renderer init time:", fmtMs(browser.initMs));
  console.log("  In-page total frame-loop time (" + FRAME_COUNT + " frames):", fmtMs(browser.totalFrameLoopMs));
  console.log("  In-page average per-frame time:", fmtMs(browser.avgFrameMs));
  console.log("  Total wall time:", fmtMs(browser.totalWallMs));
  console.log("  Orchestrating process RSS delta:", fmtMB(browser.rssDeltaBytes));
  console.log(
    "  Chromium process tree RSS (separate from orchestrating process, " +
      browser.chromiumProcessCount +
      " processes):",
    fmtMB(browser.chromiumProcessTreeRssKb * 1024),
  );

  console.log("\n=== SUMMARY ===");
  console.log(
    "  Total wall time: native is",
    (browser.totalWallMs / native.totalWallMs).toFixed(2) + "x faster than browser " +
      `(${fmtMs(native.totalWallMs)} vs ${fmtMs(browser.totalWallMs)}).`,
  );
  console.log(
    "  Memory: native avoids the separate Chromium process tree entirely (" +
      fmtMB(browser.chromiumProcessTreeRssKb * 1024) +
      " across " +
      browser.chromiumProcessCount +
      " processes on the browser path), at the cost of a somewhat larger orchestrating-process RSS delta " +
      `(native ${fmtMB(native.rssDeltaBytes)} vs browser ${fmtMB(browser.rssDeltaBytes)}).`,
  );

  process.exit(0);
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
