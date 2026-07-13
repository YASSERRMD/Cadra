import { readFileSync } from "node:fs";

import {
  createFrameContext,
  type Project,
  resolveSceneAtFrame,
  resolveVariationAxesProperty,
  type SatoriNode,
  type SceneNode,
} from "@cadra/core";
import { createNativeGpuHeadlessRenderer } from "@cadra/headless";
import {
  computeSatoriLayerRenderKey,
  computeTextNodeRenderKey,
  createDefaultParseGltf,
  createInMemoryModelRegistry,
  createInMemorySatoriLayerRenderRegistry,
  createInMemoryTextRenderRegistry,
  type LoadedModel,
  type ModelRegistry,
  type PixelBuffer,
  type RenderTarget,
  type SatoriLayerRenderRegistry,
  type TextRenderRegistry,
} from "@cadra/renderer";
import { prepareSatoriLayerRenderData } from "@cadra/renderer/svg-layer/prepare-satori-layer-render-data.js";
import type { SatoriLayerFont } from "@cadra/satori-layer";
import { createFontRegistry, parseFontWithFontkit, prepareTextRenderData, resolveTextShapingFont } from "@cadra/text";

import type { GoldenScene } from "./scenes/golden-scene.js";

/** This package's own checked-in font fixtures (see `test-fixtures/fonts/`), resolved relative to this module's own compiled location, exactly like `browser-headless-render-entry-path.ts`'s `import.meta.url` rationale in `@cadra/encode`. */
const FONT_FIXTURES_DIR = new URL("../test-fixtures/fonts/", import.meta.url);

/** This package's own checked-in GLB fixtures (see `test-fixtures/models/`), resolved the same way `FONT_FIXTURES_DIR` is. */
const MODEL_FIXTURES_DIR = new URL("../test-fixtures/models/", import.meta.url);

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
 * `computeTextNodeRenderKey(requirement.node, scene.frame)` - `scene.frame`
 * (not always `0`), matching `buildTextObject`'s own per-frame lookup
 * (`node-factory.ts`): a `GoldenScene` always renders exactly one frame
 * (`GoldenScene.frame`'s own doc), so resolving `variationAxes` at that
 * specific frame is exact, not an approximation, for both a static and a
 * keyframed value alike - unlike `@cadra/encode`'s own `render-job.ts`
 * `prepareTextRenderEntriesForProject`, which prepares a whole real
 * composition's worth of frames, this harness never needs more than one.
 * A resolved `variationAxes` bakes a real, glyph-outline-correct static font
 * instance (`resolveTextShapingFont`, `@cadra/text`) before shaping, the
 * same helper `render-job.ts` uses.
 *
 * Returns `undefined` (not an empty registry) when `scene` declares no text
 * requirements at all, so `createNativeGpuHeadlessRenderer`'s own
 * `textRenderRegistry` option is omitted entirely for non-text scenes,
 * exactly matching its documented "every text node renders as an empty
 * placeholder" default.
 *
 * A `morph`-configured requirement also registers a second entry for its own
 * `morph.from` text (same font, synthetic `{...node, content: morph.from}`
 * key), mirroring `@cadra/encode`'s own `render-job.ts`
 * `prepareTextRenderEntriesForProject` - a scene author declares one
 * `TextRenderRequirement` per morphing node, same as any other text node,
 * not two.
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
    const variationAxes =
      requirement.node.variationAxes !== undefined
        ? resolveVariationAxesProperty(requirement.node.variationAxes, scene.frame)
        : undefined;
    // resolveTextShapingFont's own "variationSourceFont" param: only the
    // "fontkit" backend actually populates variationAxes (see
    // parseFontWithOpentype's own doc) - font above already has them when
    // this requirement's own backend is "fontkit", but baking needs a
    // *separate*, fontkit-parsed ParsedFont over the same bytes otherwise.
    const variationSourceFont =
      variationAxes !== undefined && requirement.backend !== "fontkit"
        ? parseFontWithFontkit(new Uint8Array(fontBytes))
        : undefined;

    const shapingFont = await resolveTextShapingFont(
      fontRegistry,
      font,
      requirement.node.content,
      variationAxes,
      variationSourceFont,
    );
    const data = await prepareTextRenderData(shapingFont, requirement.node.content);
    registry.register(computeTextNodeRenderKey(requirement.node, scene.frame), {
      data,
      fontBytes: Buffer.from(shapingFont.bytes),
      fontContentHash: shapingFont.contentHash,
    });

    if (requirement.node.morph !== undefined) {
      const fromShapingFont = await resolveTextShapingFont(
        fontRegistry,
        font,
        requirement.node.morph.from,
        variationAxes,
        variationSourceFont,
      );
      const fromData = await prepareTextRenderData(fromShapingFont, requirement.node.morph.from);
      registry.register(
        computeTextNodeRenderKey({ ...requirement.node, content: requirement.node.morph.from }, scene.frame),
        {
          data: fromData,
          fontBytes: Buffer.from(fromShapingFont.bytes),
          fontContentHash: fromShapingFont.contentHash,
        },
      );
    }
  }

  return registry;
}

/**
 * Prepares a real `ModelRegistry` for every one of `scene`'s
 * `modelRequirements`, registering each fixture's parsed GLB under its own
 * declared `assetRef` - the `ModelNode` counterpart to `buildTextRenderRegistry`
 * immediately above, one step simpler: a model's own loaded scene/clips
 * never vary by frame (see `@cadra/renderer`'s own `ModelRegistry` doc), so
 * this needs no per-node render-key computation, just a direct
 * `assetRef -> LoadedModel` registration.
 *
 * Returns `undefined` (not an empty registry) when `scene` declares no
 * model requirements at all, matching `buildTextRenderRegistry`'s own "omit
 * entirely" convention.
 */
async function buildModelRenderRegistry(scene: GoldenScene): Promise<ModelRegistry | undefined> {
  if (scene.modelRequirements === undefined || scene.modelRequirements.length === 0) {
    return undefined;
  }

  const parseGltf = createDefaultParseGltf();
  const registry = createInMemoryModelRegistry();

  for (const requirement of scene.modelRequirements) {
    const bytes = readFileSync(new URL(requirement.modelFixtureFileName, MODEL_FIXTURES_DIR));
    const asset = await parseGltf(new Uint8Array(bytes));
    registry.register(requirement.assetRef, asset as LoadedModel);
  }

  return registry;
}

/** Recursively collects every `SatoriNode` in `node`'s own subtree into `out`, mirroring `@cadra/encode`'s own `render-job.ts` `collectSatoriNodes`. */
function collectSatoriNodes(node: SceneNode, out: SatoriNode[]): void {
  if (node.kind === "satori") {
    out.push(node);
  }
  for (const child of node.children) {
    collectSatoriNodes(child, out);
  }
}

/**
 * Prepares a real `SatoriLayerRenderRegistry` for every `SatoriNode` found
 * anywhere in `project`, rasterized at `frame` - unlike `ModelNode`/`TextNode`,
 * a `SatoriNode` needs no per-scene fixture declaration at all: it has no
 * external asset to fetch (its own `layer` is authored data already present
 * in `buildProject()`'s output), so this walks `project` directly and
 * unconditionally, exactly like `@cadra/encode`'s own
 * `buildSatoriLayerRenderRegistryForProject` does for `render_frames`.
 *
 * Fonts come from this package's own bundled `Inter-Variable.ttf` fixture,
 * mirroring `@cadra/encode`'s own `render-job.ts` `loadDefaultSatoriFonts` -
 * see that function's own doc for why passing it through
 * `@cadra/satori-layer`'s `instanceFontForSatori` (invoked automatically
 * inside `renderLayerToSvg` for every entry in `fonts`) avoids the `fvar`-
 * parsing crash a *raw* variable font triggers in Satori's bundled font
 * parser.
 *
 * Returns `undefined` when `project` has no satori nodes at all, matching
 * `buildTextRenderRegistry`'s/`buildModelRenderRegistry`'s own "omit
 * entirely" convention.
 */
async function buildSatoriLayerRenderRegistry(
  project: Project,
  frame: number,
): Promise<SatoriLayerRenderRegistry | undefined> {
  const satoriNodes: SatoriNode[] = [];
  for (const composition of project.compositions) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        collectSatoriNodes(clip.node, satoriNodes);
      }
    }
  }

  if (satoriNodes.length === 0) {
    return undefined;
  }

  const fontBytes = readFileSync(new URL("Inter-Variable.ttf", FONT_FIXTURES_DIR));
  const font = parseFontWithFontkit(new Uint8Array(fontBytes));
  const fonts: SatoriLayerFont[] = [{ family: "Inter", font, weight: 400, style: "normal" }];

  const registry = createInMemorySatoriLayerRenderRegistry();
  for (const node of satoriNodes) {
    const cacheKey = computeSatoriLayerRenderKey(node, frame);
    if (registry.resolve(cacheKey) !== undefined) {
      continue;
    }
    const rasterized = await prepareSatoriLayerRenderData(node, frame, fonts);
    registry.register(cacheKey, { rasterized });
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
  // Built up front (not after renderer construction, as this function
  // originally did): buildSatoriLayerRenderRegistry below needs the actual
  // built project (unlike buildTextRenderRegistry/buildModelRenderRegistry,
  // which only need scene's own static requirement declarations), and
  // failing fast on an unknown compositionId before doing any registry
  // preparation or renderer construction at all means this error path never
  // needs to dispose a renderer that was never created.
  const project = scene.buildProject();
  const composition = project.compositions.find((candidate) => candidate.id === scene.compositionId);
  if (composition === undefined) {
    throw new GoldenSceneCompositionNotFoundError(scene);
  }

  const textRenderRegistry = await buildTextRenderRegistry(scene);
  const modelRegistry = await buildModelRenderRegistry(scene);
  const satoriLayerRenderRegistry = await buildSatoriLayerRenderRegistry(project, scene.frame);
  const renderer = createNativeGpuHeadlessRenderer({
    textRenderRegistry,
    modelRegistry,
    satoriLayerRenderRegistry,
  });

  try {
    // The native-GPU-headless renderer always draws into its own internal
    // headless target and ignores whatever `target` a caller passes here;
    // see `createNativeGpuHeadlessRenderer`'s own doc.
    await renderer.init({} as unknown as RenderTarget, { width: scene.width, height: scene.height });

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
