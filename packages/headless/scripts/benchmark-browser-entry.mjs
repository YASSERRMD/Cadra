// Browser-side half of benchmark-native-vs-browser.mjs: renders the same
// scene (one seeded box mesh, no lights) using this workspace's real
// @cadra/core scene graph + @cadra/renderer's createPixelReadableRenderer
// (Phase 23's actual production render path, WebGPU-with-WebGL2-fallback),
// with a canvas-snapshot readPixels identical to
// @cadra/encode's browser-headless-render-entry.ts own createRealReadPixels.
// Bundled by benchmark-native-vs-browser.mjs via esbuild and injected into a
// real headless Chromium page via Playwright; never imported by any other
// TypeScript/JavaScript source in this workspace.
import {
  createComposition,
  createFrameContext,
  createProject,
  resolveSceneAtFrame,
  Sequence,
  Shape,
} from "@cadra/core";
import { createPixelReadableRenderer } from "@cadra/renderer";

function createRealReadPixels() {
  let snapshotCanvas;
  let snapshotContext;

  return async (target, size) => {
    if (snapshotCanvas === undefined) {
      snapshotCanvas = document.createElement("canvas");
      snapshotContext = snapshotCanvas.getContext("2d", { willReadFrequently: true });
    }
    if (snapshotCanvas.width !== size.width || snapshotCanvas.height !== size.height) {
      snapshotCanvas.width = size.width;
      snapshotCanvas.height = size.height;
    }
    snapshotContext.drawImage(target, 0, 0);
    const imageData = snapshotContext.getImageData(0, 0, size.width, size.height);
    return { width: size.width, height: size.height, data: imageData.data };
  };
}

async function runBrowserBenchmark(config) {
  const { width, height, frameCount, fps } = config;

  const tRendererInitStart = performance.now();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const renderer = createPixelReadableRenderer({ readPixels: createRealReadPixels() });
  await renderer.init(canvas, { width, height });
  const tRendererInitEnd = performance.now();

  const shape = Shape({ id: "cube-1" });
  const composition = createComposition({
    id: "bench-comp",
    name: "Bench",
    fps,
    durationInFrames: frameCount,
    width,
    height,
    tracks: [
      {
        id: "track-1",
        clips: [Sequence({ id: "clip-1", from: 0, durationInFrames: frameCount, content: shape })],
      },
    ],
  });
  const project = createProject({ id: "bench-project", name: "Bench", compositions: [composition] });

  const frameTimes = [];
  let nonBlankCheckPassed = false;

  const tFramesStart = performance.now();
  for (let frame = 0; frame < frameCount; frame += 1) {
    const tFrameStart = performance.now();
    const sceneState = resolveSceneAtFrame(project, "bench-comp", frame);
    const frameContext = createFrameContext({ frame, fps, durationInFrames: frameCount, seed: "bench" });
    renderer.renderFrame(sceneState, frameContext);
    const pixels = await renderer.readPixels();
    frameTimes.push(performance.now() - tFrameStart);

    if (frame === 0) {
      const alphaValues = new Set();
      for (let i = 3; i < pixels.data.length; i += 4) alphaValues.add(pixels.data[i]);
      nonBlankCheckPassed = alphaValues.size > 1;
    }
  }
  const tFramesEnd = performance.now();

  renderer.dispose();

  return {
    backend: renderer.backend,
    isFallback: renderer.capabilities.isFallback,
    rendererInitMs: tRendererInitEnd - tRendererInitStart,
    totalFrameLoopMs: tFramesEnd - tFramesStart,
    avgFrameMs: frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length,
    nonBlankCheckPassed,
  };
}

window.__cadraBench = { runBrowserBenchmark };
