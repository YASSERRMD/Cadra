import { readFileSync } from "node:fs";

import { createFrameContext, resolveSceneAtFrame } from "@cadra/core";
import { createNativeGpuHeadlessRenderer } from "@cadra/headless";
import {
  computeTextNodeRenderKey,
  createInMemoryTextRenderRegistry,
  type PixelBuffer,
  type RenderTarget,
  type TextRenderRegistry,
} from "@cadra/renderer";
import { createFontRegistry, prepareTextRenderData } from "@cadra/text";

import type { GoldenScene } from "./scenes/golden-scene.js";

/** This package's own checked-in font fixtures (see `test-fixtures/fonts/`), resolved relative to this module's own compiled location, exactly like `browser-headless-render-entry-path.ts`'s `import.meta.url` rationale in `@cadra/encode`. */
const FONT_FIXTURES_DIR = new URL("../test-fixtures/fonts/", import.meta.url);

/** Thrown when a `GoldenScene`'s own `compositionId` does not exist in its own `buildProject()` output - a scene-authoring bug, never expected at runtime. */
export class GoldenSceneCompositionNotFoundError extends Error {
  constructor(scene: GoldenScene) {
    super(
      `renderRasterGoldenScene: scene "${scene.name}" has no composition "${scene.compositionId}" in its own buildProject() output.`,
    );
    this.name = "GoldenSceneCompositionNotFoundError";
  }
}

/**
 * Prepares real, shaped `TextRenderEntry` data for every one of `scene`'s
 * `textRequirements` (Phase 71's own text-registry gap fix; see
 * `three-renderer.ts`'s constructor doc) and registers each under
 * `computeTextNodeRenderKey(requirement.node, 0)` - frame `0`, matching
 * `buildTextObject`'s own hardcoded lookup frame (`node-factory.ts`): text
 * geometry is a structural, build-once decision keyed off the node's
 * content/fontRef/variationAxes at frame 0, not the frame the scene is
 * actually screenshotted at (every curated text scene in this package holds
 * those fields constant across its own duration, so this is exact, not an
 * approximation).
 *
 * Returns `undefined` (not an empty registry) when `scene` declares no text
 * requirements at all, so `createNativeGpuHeadlessRenderer`'s own
 * `textRenderRegistry` option is omitted entirely for non-text scenes,
 * exactly matching its documented "every text node renders as an empty
 * placeholder" default.
 */
async function buildTextRenderRegistry(scene: GoldenScene): Promise<TextRenderRegistry | undefined> {
  if (scene.textRequirements === undefined || scene.textRequirements.length === 0) {
    return undefined;
  }

  const registry = createInMemoryTextRenderRegistry();

  for (const requirement of scene.textRequirements) {
    const fontBytes = readFileSync(new URL(requirement.fontFixtureFileName, FONT_FIXTURES_DIR));
    const fontRegistry = createFontRegistry(requirement.backend);
    const font = await fontRegistry.registerBytes(fontBytes, { backend: requirement.backend }).ready;
    const data = await prepareTextRenderData(font, requirement.node.content);

    registry.register(computeTextNodeRenderKey(requirement.node, 0), {
      data,
      fontBytes,
      fontContentHash: font.contentHash,
    });
  }

  return registry;
}

/**
 * Renders one `driver: "nativeGpuHeadless"` `GoldenScene` to a
 * `PixelBuffer`, via `createNativeGpuHeadlessRenderer` (a real native
 * Dawn/WebGPU device, no browser process; see that function's own doc),
 * the same proven path every native-GPU e2e test in this workspace (Phases
 * 66-70) already renders real scenes through. Not every `GoldenScene`: see
 * `GoldenSceneDriver`'s own doc for which scenes need the separate browser
 * driver (`render-browser-scene.ts`) instead, and why.
 *
 * Walks every frame from `0` up to `scene.frame` in order, discarding every
 * readback but the last, rather than jumping straight to `scene.frame` in
 * one `renderFrame` call: this matches `renderComposition`'s own
 * documented contract (it "walks every integer frame ... in order"), which
 * every other real render path in this codebase (the headless server, the
 * native-GPU e2e suite) already follows. Kept as this driver's own general
 * contract for any future effect that reads a node's *previous* rendered
 * state, even though the one such effect this harness currently exercises
 * (`motionBlur`) was verified to need more than this alone - see
 * `motion-blur-scene.ts`'s own doc for that separately-tracked finding.
 */
export async function renderRasterGoldenScene(scene: GoldenScene): Promise<PixelBuffer> {
  const textRenderRegistry = await buildTextRenderRegistry(scene);
  const renderer = createNativeGpuHeadlessRenderer({ textRenderRegistry });

  try {
    // The native-GPU-headless renderer always draws into its own internal
    // headless target and ignores whatever `target` a caller passes here;
    // see `createNativeGpuHeadlessRenderer`'s own doc.
    await renderer.init({} as unknown as RenderTarget, { width: scene.width, height: scene.height });

    const project = scene.buildProject();
    const composition = project.compositions.find((candidate) => candidate.id === scene.compositionId);
    if (composition === undefined) {
      throw new GoldenSceneCompositionNotFoundError(scene);
    }

    for (let frame = 0; frame <= scene.frame; frame += 1) {
      const sceneState = resolveSceneAtFrame(project, scene.compositionId, frame);
      const frameContext = createFrameContext({
        frame,
        fps: composition.fps,
        durationInFrames: composition.durationInFrames,
        seed: scene.seed,
      });
      renderer.renderFrame(sceneState, frameContext);
    }

    return await renderer.readPixels();
  } finally {
    renderer.dispose();
  }
}
