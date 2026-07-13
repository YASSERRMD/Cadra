import { readFileSync } from "node:fs";

import type { Project, SatoriNode, SceneNode, TextNode, VideoFrameMapping } from "@cadra/core";
import { isKeyframeTrack, resolveAudioMixdown, resolveVariationAxesProperty, resolveVideoSourceFrame } from "@cadra/core";
import type {
  BrowserLauncher,
  HeadlessBrowserLike,
  HeadlessServerFileWriteStreamLike,
  OnLogFn,
  OnProgressFn,
  RenderJobHandle,
  RenderJobStatusSnapshot,
  ResumableRangeStates,
} from "@cadra/headless";
import {
  BROWSER_ENTRY_GLOBAL_NAME,
  bundleBrowserEntry,
  getRenderJobStatus as getHeadlessRenderJobStatus,
  launchPlaywrightHeadlessBrowser,
  RenderJobFailedError,
  resumeRenderJob as resumeHeadlessRenderJob,
  submitRenderJob as submitHeadlessRenderJob,
} from "@cadra/headless";
import {
  computeSatoriLayerRenderKey,
  computeTextNodeRenderKey,
  computeVideoFrameCacheKey,
  createDataTexture,
  createDefaultEnvironmentRegistry,
  createDefaultLutRegistry,
  createDefaultParseGltf,
  createInMemoryModelRegistry,
  createInMemorySatoriLayerRenderRegistry,
  createInMemoryTextRenderRegistry,
  createInMemoryTextureRegistry,
  type EnvironmentRegistry,
  type LoadedModel,
  type LutRegistry,
  type ModelRegistry,
  parseCubeLut,
  parseHdrEnvironment,
  type SatoriLayerRenderRegistry,
  type TextRenderRegistry,
  type TextureRegistry,
} from "@cadra/renderer";
import { prepareSatoriLayerRenderData } from "@cadra/renderer/svg-layer/prepare-satori-layer-render-data.js";
import type { SatoriLayerFont } from "@cadra/satori-layer";
import {
  createFontRegistry,
  parseFontWithFontkit,
  type PositionedGlyph,
  prepareTextRenderData,
  resolveTextShapingFont,
  type TextRenderData,
} from "@cadra/text";
import { PNG } from "pngjs";

import type { EncodedAudioChunkResult } from "./encode-audio.js";
import type { EncodedChunkResult } from "./encode-frames.js";
import { DEFAULT_KEYFRAME_INTERVAL_FRAMES } from "./encode-frames.js";
import type { MuxMp4AudioTrackOptions } from "./mux-mp4.js";
import { muxToMp4Stream } from "./mux-mp4.js";
import type { NodeWritableLike } from "./mux-stream-target.js";
import type { MuxWebmAudioTrackOptions } from "./mux-webm.js";
import { muxToWebmStream } from "./mux-webm.js";
import type { SerializedEncodedAudioChunk, SerializedEncodedChunk } from "./serialized-encoded-chunk.js";
import {
  deserializeEncodedAudioChunkResult,
  deserializeEncodedChunkResult,
} from "./serialized-encoded-chunk.js";

/**
 * Phase 25's render job orchestrator, wiring `@cadra/headless`'s generic
 * `submitRenderJob`/`resumeRenderJob`/`getRenderJobStatus` (frame-range
 * splitting, bounded-concurrency worker pool, per-range retry/resume, job
 * status) to the concrete render/encode/mux pipeline this package owns.
 *
 * Mirrors `renderCompositionHeadlessServer`'s own architecture exactly, one
 * level up: where that function launches one browser per whole-composition
 * attempt and streams the muxed output directly, `submitEncodedRenderJob`
 * launches one browser per **range** attempt (dispatched through
 * `@cadra/headless`'s worker pool, so many ranges' browsers run
 * concurrently, bounded by `maxConcurrency`), collects each range's own
 * `EncodedChunkResult` sequence (via `@cadra/encode`'s
 * `runBrowserHeadlessRenderRange`/`SerializedEncodedChunk`), then performs a
 * single final concatenate-and-mux pass once every range has succeeded.
 * Launching a fresh browser per range attempt (rather than one browser
 * shared across every range, with only pages recycled) deliberately mirrors
 * `renderCompositionHeadlessServer`'s own per-attempt-fresh-browser design
 * for the same reason: a clean-slate browser per attempt is simple and
 * correctness-safe (no risk of one range's crashed/hung page corrupting a
 * browser instance other concurrent ranges still depend on), at the cost of
 * repeated Chromium launch overhead across many ranges; optimizing that
 * overhead (e.g. a shared browser with per-range pages, isolating page-level
 * failures from the shared browser) is a reasonable follow-up, not something
 * this phase's correctness depends on.
 *
 * Range-parallel output equivalence to a sequential render, and what level
 * of byte/pixel equivalence that claim actually covers: see
 * `renderComposition`'s own doc (frame-range determinism: every range's
 * rendered pixels are identical to what a full sequential render would have
 * produced at those same frame indices) and `runBrowserHeadlessRenderRange`'s
 * own doc (why every range's independently-probed codec choice is the same
 * one, keeping keyframes mutually compatible once concatenated). Byte-for-
 * byte identical *compressed* output between an independently-started-cold
 * range encoder and a continuous sequential encoder run is explicitly *not*
 * guaranteed by the WebCodecs/underlying codec specs (rate control/adaptive
 * quantization state is legitimately encoder-implementation-defined and can
 * differ instance to instance even given identical config and pixel-
 * identical input); this module's own test suite instead verifies pixel-level
 * equivalence of the rendered frames feeding the encoder (the spec-
 * guaranteed property) plus container-level duration/structural validity of
 * the final muxed output, and states that precisely rather than overclaiming
 * full byte-identity of the encoded/muxed bytes.
 *
 * Concatenation approach (see this package's own phase spec for why this,
 * and not per-range container files glued together, is the correct design):
 * every range's `EncodedChunkResult`s are collected as an in-memory array
 * (`SerializedEncodedChunk[]`, crossing back from the browser page via
 * `page.evaluate`'s structured-clone-safe return value), concatenated in
 * frame order once every range succeeds, deserialized back into
 * `EncodedChunkResult`-shaped values, and fed through exactly one
 * `muxToMp4Stream`/`muxToWebmStream` call, i.e. one ordinary,
 * single-container-file mux pass over the whole composition's worth of
 * chunks. No per-range container file is ever produced or concatenated at
 * the container level.
 */

/** Options accepted by `submitEncodedRenderJob`/`resumeEncodedRenderJob`. */
export interface SubmitEncodedRenderJobOptions {
  /** The project to render. */
  project: Project;
  /** Which of `project`'s compositions to render. */
  compositionId: string;
  /** Base seed for every frame's `FrameContext`; see `renderComposition`'s own doc for why this is required. */
  seed: string | number;
  /** Output container. */
  format: "mp4" | "webm";
  /** Target bitrate in bits per second for the video encoder; must be identical for every range (see this module's own top-level doc for why). */
  bitrate: number;
  /**
   * Where the final, single muxed file is written. `HeadlessServerFileWriteStreamLike`-
   * shaped (matching `renderCompositionHeadlessServer`'s own `destination`
   * option): `end(callback)` is called exactly once, after the final mux
   * pass has finished writing every byte, mirroring
   * `renderCompositionHeadlessServer`'s own destination lifecycle.
   */
  destination: HeadlessServerFileWriteStreamLike;
  /** Absolute path to the browser-side entry script to bundle, i.e. `BROWSER_HEADLESS_RENDER_ENTRY_PATH`; see `RenderCompositionHeadlessServerOptions.entryFilePath`'s own doc for why this is required, not defaulted. */
  entryFilePath: string;
  /** Target frames per range, before keyframe-interval alignment rounding. Defaults to `@cadra/headless`'s own `DEFAULT_RANGE_SIZE_FRAMES`. */
  rangeSizeFrames?: number;
  /**
   * Range-start alignment, in frames. Defaults to this job's own
   * `keyframeIntervalFrames` (itself defaulting to
   * `DEFAULT_KEYFRAME_INTERVAL_FRAMES`): aligning every range's start to a
   * multiple of the keyframe interval is what guarantees every range opens
   * on a forced keyframe (see `runBrowserHeadlessRenderRange`'s own doc), so
   * this option only needs overriding if a caller wants range boundaries
   * that are a multiple of, but not exactly equal to, `keyframeIntervalFrames`.
   */
  rangeAlignmentFrames?: number;
  /** Maximum ranges rendered concurrently (i.e. concurrent browser instances). Defaults to `@cadra/headless`'s own `DEFAULT_MAX_CONCURRENCY`. */
  maxConcurrency?: number;
  /** Maximum attempts (first try plus retries) per range before that range is declared permanently failed. Defaults to `@cadra/headless`'s own `DEFAULT_MAX_ATTEMPTS_PER_RANGE`. */
  maxAttemptsPerRange?: number;
  /** Force a keyframe every this many frames (and always at frame 0), passed through to every range's own `encodeFrames` call. Defaults to `DEFAULT_KEYFRAME_INTERVAL_FRAMES`. Every range uses this same value, which is what keeps every range's keyframe placement identical to what a single sequential encode would have placed. */
  keyframeIntervalFrames?: number;
  /** Reports per-range progress (that range's own frame index/total), matching `renderComposition`'s own `OnProgressFn` shape. Since ranges render concurrently, progress from different ranges interleaves; use `onStatusChange`/`getEncodedRenderJobStatus` for aggregate job-level progress instead. */
  onProgress?: OnProgressFn;
  /** Reports every log line every range's render produces, matching `RenderCompositionHeadlessServerOptions.onLog`'s own shape. */
  onLog?: OnLogFn;
  /** Invoked whenever any range's status changes, with the job's full up-to-date status snapshot; see `@cadra/headless`'s `RenderJobOptions.onStatusChange`'s own doc. */
  onStatusChange?: (status: RenderJobStatusSnapshot<SerializedEncodedChunk[]>) => void;
  /** Launches the headless browser each range attempt runs in. Defaults to `launchPlaywrightHeadlessBrowser`. Injectable for the same reason as `RenderCompositionHeadlessServerOptions.browserLauncher`. */
  browserLauncher?: BrowserLauncher;
  /** Bundles `entryFilePath` into injectable script source, reused across every range/attempt of this job (bundled exactly once, not once per range). Defaults to `bundleBrowserEntry`. */
  bundleEntry?: (options: { entryFilePath: string }) => Promise<string>;
  /** Milliseconds allowed for one range attempt before it is treated as timed out and retried. Defaults to `DEFAULT_RANGE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Resolves an `ImageNode.assetRef`, a `VideoNode.assetRef`, or an
   * `AudioMixdownSegment.assetRef` to that asset's own raw bytes, e.g.
   * `@cadra/mcp-server`'s own `createAssetBytesFetcher(workspaceRoot)` -
   * the same asset store serves all three kinds, so one resolver covers
   * them all. Omitted means every `ImageNode`/`VideoNode` in `project`
   * renders as the renderer's own documented placeholder (see
   * `buildImageRenderEntriesForProject`'s/`buildVideoAssetEntriesForProject`'s
   * own doc for the full "unresolved is an expected runtime state"
   * contract) and every audio segment renders as silence (see
   * `prepareAudioMixdownAssetEntries`'s own doc for the identical contract
   * on the audio side).
   */
  fetchAssetBytes?: (assetRef: string) => Promise<Uint8Array | undefined>;
  /** Target bitrate in bits per second for the audio encoder, if `project`'s own composition has any audio content at all (see `resolveAudioMixdown`). Defaults to `DEFAULT_AUDIO_BITRATE`. Has no effect on a composition with no `audioTracks` (or only empty ones): no audio encoding happens there at all, matching `renderAudioMixdown`'s own "a caller decides whether a silent mixdown is worth encoding" contract. */
  audioBitrate?: number;
}

/** `SubmitEncodedRenderJobOptions.audioBitrate`'s own default: 128 kbps, a standard, safe default for both AAC (mp4) and Opus (webm) at this module's own render sample rate/channel count. */
export const DEFAULT_AUDIO_BITRATE = 128_000;

/** Milliseconds allowed for one range attempt by default: 2 minutes. Shorter than `renderCompositionHeadlessServer`'s own 5-minute default, since a single range is, by construction, a fraction of a whole composition's frames. */
export const DEFAULT_RANGE_TIMEOUT_MS = 2 * 60 * 1000;

/** Maximum extra time `runOneRangeAttempt` waits for `browser.close()` to finish before giving up on it and letting the attempt settle anyway; see that function's own `finally` block doc for why this is bounded at all. */
const BROWSER_CLOSE_GRACE_MS = 10 * 1000;

/**
 * A submitted encoded render job's handle: a job id for status queries, plus
 * a `result` promise resolving once the final muxed file has been fully
 * written.
 */
export interface EncodedRenderJobHandle {
  /** Id accepted by `getEncodedRenderJobStatus`/`@cadra/headless`'s own `getRenderJobStatus`. */
  jobId: string;
  /**
   * Resolves once every range has rendered successfully and the final
   * concatenate-and-mux pass has finished writing every byte to
   * `destination` (and, once written, `destination.end()` has itself
   * finished). Rejects with `@cadra/headless`'s own `RenderJobFailedError`
   * if any range permanently failed (every other range still finishes its
   * own attempts first, per that error's own doc); nothing is muxed at all
   * in that case, matching this module's "one single final mux pass, only
   * once every range has succeeded" design.
   */
  result: Promise<void>;
}

/**
 * Reuses `@cadra/headless`'s own job-status query, typed for this module's
 * `SerializedEncodedChunk[]` segment shape. Exists so a caller need only
 * import from this module, not additionally from `@cadra/headless`, for the
 * common case of querying an encoded render job's status.
 */
export function getEncodedRenderJobStatus(
  jobId: string,
): RenderJobStatusSnapshot<SerializedEncodedChunk[]> {
  return getHeadlessRenderJobStatus<SerializedEncodedChunk[]>(jobId);
}

/** Mirrors `browser-headless-render-entry.ts`'s own `SerializedMsdfAtlasPage`; duplicated (not imported) for the same reason `BrowserRangeConfigArg` below is - see its own doc. */
interface SerializedMsdfAtlasPage {
  width: number;
  height: number;
  pixels: number[];
  png: number[];
}

/** Mirrors `browser-headless-render-entry.ts`'s own `SerializedImageRenderEntry`; duplicated (not imported) for the same reason `BrowserRangeConfigArg` below is - see its own doc. */
interface SerializedImageRenderEntry {
  assetRef: string;
  bytes: number[];
}

/** Mirrors `browser-headless-render-entry.ts`'s own `SerializedModelAssetEntry`; duplicated for the same reason `SerializedImageRenderEntry` above is. */
interface SerializedModelAssetEntry {
  assetRef: string;
  bytes: number[];
}

/** Mirrors `browser-headless-render-entry.ts`'s own `SerializedEnvironmentAssetEntry`; duplicated for the same reason `SerializedImageRenderEntry` above is. */
interface SerializedEnvironmentAssetEntry {
  envMapRef: string;
  bytes: number[];
}

/** Mirrors `browser-headless-render-entry.ts`'s own `SerializedLutAssetEntry`; duplicated for the same reason `SerializedImageRenderEntry` above is. */
interface SerializedLutAssetEntry {
  lutRef: string;
  bytes: number[];
}

/** Mirrors `browser-headless-render-entry.ts`'s own `SerializedVideoAssetEntry`; duplicated for the same reason `SerializedImageRenderEntry` above is. */
interface SerializedVideoAssetEntry {
  assetRef: string;
  bytes: number[];
}

/** Mirrors `browser-headless-render-entry.ts`'s own `VideoSampleRequest`; duplicated for the same reason `SerializedImageRenderEntry` above is. */
interface VideoSampleRequest {
  assetRef: string;
  sourceFrame: number;
}

/** Mirrors `browser-headless-render-entry.ts`'s own `SerializedSatoriLayerRenderEntry`; duplicated for the same reason `SerializedImageRenderEntry` above is. */
interface SerializedSatoriLayerRenderEntry {
  cacheKey: string;
  width: number;
  height: number;
  pixels: number[];
}

/** Mirrors `browser-headless-render-entry.ts`'s own `SerializedTextRenderData`. */
interface SerializedTextRenderData {
  atlasPages: SerializedMsdfAtlasPage[];
  glyphs: readonly PositionedGlyph[];
  lineCount: number;
}

/** Mirrors `browser-headless-render-entry.ts`'s own `SerializedTextRenderEntry` - one prepared `TextRenderRegistry` entry, ready to cross the `page.evaluate` structured-clone boundary. */
interface SerializedTextRenderEntry {
  cacheKey: string;
  data: SerializedTextRenderData;
  fontBytes: number[];
  fontContentHash: string;
}

/** The exact shape `runBrowserHeadlessRenderRange` (`@cadra/encode`'s own browser-side entry point) accepts, duplicated here (not imported) for the same reason `render-composition-headless-server.ts` duplicates `BrowserHeadlessRenderConfig`'s shape: this config crosses into the page via `page.evaluate`'s structured-cloned `arg`, not a compile-time import boundary. */
interface BrowserRangeConfigArg {
  project: Project;
  compositionId: string;
  seed: string | number;
  bitrate: number;
  startFrame: number;
  endFrame: number;
  keyframeIntervalFrames: number;
  textRenderEntries: SerializedTextRenderEntry[];
  imageRenderEntries: SerializedImageRenderEntry[];
  modelRenderEntries: SerializedModelAssetEntry[];
  environmentRenderEntries: SerializedEnvironmentAssetEntry[];
  lutRenderEntries: SerializedLutAssetEntry[];
  videoAssetEntries: SerializedVideoAssetEntry[];
  videoSamplesNeeded: VideoSampleRequest[];
  satoriLayerRenderEntries: SerializedSatoriLayerRenderEntry[];
}

/** Mirrors `browser-headless-render-entry.ts`'s own `SerializedAudioAssetEntry`; duplicated (not imported) for the same reason `BrowserRangeConfigArg` above is - see its own doc. */
interface SerializedAudioAssetEntry {
  assetRef: string;
  bytes: number[];
}

/** The exact shape `runBrowserHeadlessAudioMixdown` (`@cadra/encode`'s own browser-side entry point) accepts, duplicated here for the same reason `BrowserRangeConfigArg` above is. */
interface BrowserAudioMixdownConfigArg {
  project: Project;
  compositionId: string;
  container: "mp4" | "webm";
  bitrate: number;
  audioAssetEntries: SerializedAudioAssetEntry[];
}

/** Mirrors `browser-headless-render-entry.ts`'s own `SerializedAudioMixdownResult`; duplicated here for the same reason `BrowserRangeConfigArg` above is. */
interface SerializedAudioMixdownResult {
  chunks: SerializedEncodedAudioChunk[];
  codec: string;
  numberOfChannels: number;
  sampleRate: number;
}

/**
 * This package's own bundled default font, used for every `TextNode` that
 * does not (yet) resolve `fontRef` against a real font-asset registry -
 * `render_scene`'s actual render path never wired one up at all (every
 * text node silently built as an empty, glyph-less group; see this
 * module's own `buildTextRenderEntriesForProject` doc), the same
 * "SIL Open Font License, freely embeddable" font this workspace's own
 * `@cadra/golden-frames` test fixtures already use for text golden tests.
 */
const DEFAULT_FONT_PATH = new URL("../assets/fonts/Inter-Variable.ttf", import.meta.url);

/** Recursively collects every `TextNode` in `node`'s own subtree into `out`. */
function collectTextNodes(node: SceneNode, out: TextNode[]): void {
  if (node.kind === "text") {
    out.push(node);
  }
  for (const child of node.children) {
    collectTextNodes(child, out);
  }
}

/** Recursively collects every distinct `ImageNode.assetRef` in `node`'s own subtree into `out`. */
function collectImageAssetRefs(node: SceneNode, out: Set<string>): void {
  if (node.kind === "image") {
    out.add(node.assetRef);
  }
  for (const child of node.children) {
    collectImageAssetRefs(child, out);
  }
}

/** Recursively collects every distinct `VideoNode.assetRef` in `node`'s own subtree into `out`. */
function collectVideoAssetRefs(node: SceneNode, out: Set<string>): void {
  if (node.kind === "video") {
    out.add(node.assetRef);
  }
  for (const child of node.children) {
    collectVideoAssetRefs(child, out);
  }
}

/** Recursively collects every distinct `ModelNode.assetRef` in `node`'s own subtree into `out`. */
function collectModelAssetRefs(node: SceneNode, out: Set<string>): void {
  if (node.kind === "model") {
    out.add(node.assetRef);
  }
  for (const child of node.children) {
    collectModelAssetRefs(child, out);
  }
}

/** Recursively collects every `SatoriNode` in `node`'s own subtree into `out`. */
function collectSatoriNodes(node: SceneNode, out: SatoriNode[]): void {
  if (node.kind === "satori") {
    out.push(node);
  }
  for (const child of node.children) {
    collectSatoriNodes(child, out);
  }
}

/** A `VideoNode`'s own `resolveVideoSourceFrame` mapping (`@cadra/core`'s own `VideoFrameMapping`), plus the `assetRef` it applies to - `collectVideoNodeMappings`'s own per-node output shape. */
interface VideoNodeMapping extends VideoFrameMapping {
  assetRef: string;
}

/** Recursively collects every `VideoNode`'s own `resolveVideoSourceFrame` mapping in `node`'s own subtree into `out`. */
function collectVideoNodeMappings(node: SceneNode, out: VideoNodeMapping[]): void {
  if (node.kind === "video") {
    out.push({
      assetRef: node.assetRef,
      inFrame: node.inFrame,
      outFrame: node.outFrame,
      playbackRate: node.playbackRate,
      outOfRangeBehavior: node.outOfRangeBehavior,
    });
  }
  for (const child of node.children) {
    collectVideoNodeMappings(child, out);
  }
}

/**
 * Collects every `VideoNode` mapping across every composition/track/clip in
 * `project`'s own scene graph - `computeNeededVideoSamplesForRange`'s own
 * input, computed once per job (mirroring `textRenderEntries`/
 * `imageRenderEntries`'s own "computed once, reused by every range"
 * placement in `runEncodedRenderJob`): every field this reads
 * (`assetRef`/`inFrame`/`outFrame`/`playbackRate`/`outOfRangeBehavior`) is a
 * plain, non-keyframeable value on `VideoNode` (see its own doc in
 * `@cadra/core`), so nothing here depends on which frame range is currently
 * rendering.
 */
function collectVideoNodeMappingsForProject(project: Project): VideoNodeMapping[] {
  const mappings: VideoNodeMapping[] = [];
  for (const composition of project.compositions) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        collectVideoNodeMappings(clip.node, mappings);
      }
    }
  }
  return mappings;
}

/**
 * Computes every distinct `(assetRef, sourceFrame)` pair this range's own
 * `[startFrame, endFrame)` needs a decoded video frame for: for every
 * `VideoNodeMapping` in `videoNodeMappings` (see
 * `collectVideoNodeMappingsForProject`) and every composition-absolute
 * frame in this range, resolves `resolveVideoSourceFrame` and dedupes via
 * the exact same cache-key format `@cadra/renderer`'s own
 * `computeVideoFrameCacheKey` (and so, ultimately, `VideoFrameRegistry`
 * itself) uses - guaranteeing this list contains exactly the entries the
 * renderer will actually look up: no more (a wasted decode for a source
 * frame no node in this range will ever request) and no less (a
 * placeholder shown for a frame a real decode was actually available for).
 *
 * Pure arithmetic over an already-collected mapping list: no scene-graph
 * walk happens per range (see `collectVideoNodeMappingsForProject`'s own
 * doc for why one project-wide walk, done once per job, is enough).
 */
function computeNeededVideoSamplesForRange(
  videoNodeMappings: readonly VideoNodeMapping[],
  startFrame: number,
  endFrame: number,
): VideoSampleRequest[] {
  const seenKeys = new Set<string>();
  const requests: VideoSampleRequest[] = [];

  for (const mapping of videoNodeMappings) {
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const sourceFrame = resolveVideoSourceFrame(mapping, frame);
      const key = computeVideoFrameCacheKey(mapping.assetRef, sourceFrame);
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      requests.push({ assetRef: mapping.assetRef, sourceFrame });
    }
  }

  return requests;
}

/** One prepared, real (non-serialized) `TextRenderRegistry` entry - `prepareTextRenderEntriesForProject`'s own output shape, shared by both of its callers below. */
interface PreparedTextRenderEntry {
  cacheKey: string;
  data: TextRenderData;
  fontBytes: Buffer;
  fontContentHash: string;
}

/**
 * Prepares a `PreparedTextRenderEntry` for every distinct `TextNode`
 * (deduped by `computeTextNodeRenderKey(node, frame)`, mirroring
 * `TextRenderRegistry`'s own resolve-by-key contract) found anywhere in
 * `project`'s own scene graph, across every composition/track/clip - plus
 * one more per `morph`-configured `TextNode`, for its own `morph.from` text
 * (deduped the same way, via `computeTextNodeRenderKey` applied to a
 * synthetic `{...node, content: node.morph.from}`), since a morphing node's
 * renderer-side `Object3D` needs both texts' own shaped/atlas-generated data
 * registered before it can build either glyph group - see
 * `node-factory.ts`'s own `buildTextObject`.
 *
 * `frame` matters only for `variationAxes`: a plain (non-keyframed) value
 * resolves identically at every frame, so `frame` `0` alone is exact and
 * this only ever prepares one entry per node/side; a keyframed one
 * genuinely differs frame to frame (a different resolved instance -
 * different glyph *outlines*, not just a different advance width - see
 * `TextNode.variationAxes`' own doc), so every frame across that node's own
 * composition gets its own resolved sample here, deduped by
 * `computeTextNodeRenderKey` down to however many distinct values that
 * animation actually visits - the same "ahead of a `reconcile` call, not
 * during one" cost `content` itself would already pay if it were keyframed
 * (`computeTextNodeRenderKey`'s own doc). A resolved `variationAxes` bakes a
 * real, glyph-outline-correct static font instance (`resolveTextShapingFont`,
 * `@cadra/text`) before shaping; a node with no `variationAxes` at all pays
 * none of this cost, using the shared default font exactly as before.
 *
 * Font loading, HarfBuzz shaping, MSDF atlas generation, and variation
 * baking are all Node-only-dependency-laden work (`fontkit`'s `Buffer`
 * usage, `msdfgen-wasm`'s `createRequire`, `subset-font`'s `fs`), so this
 * always runs here, server-side, in real Node - see this module's two
 * callers for why each needs that: `buildTextRenderEntriesForProject`
 * (below) further serializes this result to cross a `page.evaluate`
 * structured-clone boundary into a bundled browser page;
 * `buildTextRenderRegistryForProject` (exported) registers it directly into
 * a `TextRenderRegistry` for a same-process renderer (`@cadra/headless`'s
 * native-GPU-headless path, no browser, no serialization boundary at all)
 * instead.
 *
 * Every node currently uses this module's own bundled default font as its
 * own *base* instance regardless of whether it set its own `fontRef`:
 * resolving `fontRef` against a real, agent-uploaded font asset registry is
 * a follow-up this phase's scope does not cover (`create_scene`/
 * `add_text_node`'s own MCP-server callers have no such registry wired
 * through to here yet either), not something dropped by mistake.
 */
async function prepareTextRenderEntriesForProject(
  project: Project,
): Promise<PreparedTextRenderEntry[]> {
  // Paired with each node's own composition's durationInFrames: needed to
  // enumerate every frame a keyframed variationAxes could resolve
  // differently at (see the loop below).
  const textNodes: Array<{ node: TextNode; durationInFrames: number }> = [];
  for (const composition of project.compositions) {
    const nodesInComposition: TextNode[] = [];
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        collectTextNodes(clip.node, nodesInComposition);
      }
    }
    for (const node of nodesInComposition) {
      textNodes.push({ node, durationInFrames: composition.durationInFrames });
    }
  }

  if (textNodes.length === 0) {
    return [];
  }

  const fontBytes = readFileSync(DEFAULT_FONT_PATH);
  // "opentype" (not "fontkit"): the only backend @cadra/text/browser's own
  // doc confirms works when bundled for a browser target, matching
  // createFontRegistry's own doc ("pass 'opentype' ... for registries that
  // must also work inside a browser-bundled render page"). Preparation
  // itself runs here in Node, but shaping must stay consistent with
  // whatever backend a browser-side re-shape would use, and there is none
  // here at all - "opentype" is simply the correct, only-supported choice.
  const fontRegistry = createFontRegistry("opentype");
  const font = await fontRegistry.registerBytes(fontBytes).ready;
  // resolveTextShapingFont's own "variationSourceFont" param: the
  // "opentype" backend above deliberately never populates variationAxes
  // (see that function's own doc), so baking needs this *separate*,
  // fontkit-parsed ParsedFont over the exact same bytes instead. Lazy - not
  // computed at all (no extra parse cost) unless this project actually has
  // at least one variationAxes-configured TextNode.
  const variationSourceFont = textNodes.some(({ node }) => node.variationAxes !== undefined)
    ? parseFontWithFontkit(fontBytes)
    : undefined;

  // Every distinct (cacheKey, content, resolved variationAxes) this
  // project's text needs shaped - see this function's own doc for exactly
  // which frames get sampled and why. Keying this map by
  // computeTextNodeRenderKey itself (not by node) both dedupes naturally
  // (two nodes/sides/frames that happen to resolve the same key only ever
  // get shaped once) and guarantees this stays consistent with
  // node-factory.ts's buildTextObject, which resolves against the exact
  // same key.
  const requestedEntries = new Map<
    string,
    { content: string; variationAxes: Readonly<Record<string, number>> | undefined }
  >();
  for (const { node, durationInFrames } of textNodes) {
    const framesToSample =
      node.variationAxes !== undefined && isKeyframeTrack(node.variationAxes)
        ? Array.from({ length: durationInFrames }, (_unused, frame) => frame)
        : [0];

    for (const frame of framesToSample) {
      const variationAxes =
        node.variationAxes !== undefined ? resolveVariationAxesProperty(node.variationAxes, frame) : undefined;
      requestedEntries.set(computeTextNodeRenderKey(node, frame), { content: node.content, variationAxes });
      if (node.morph !== undefined) {
        requestedEntries.set(computeTextNodeRenderKey({ ...node, content: node.morph.from }, frame), {
          content: node.morph.from,
          variationAxes,
        });
      }
    }
  }

  const entries = new Map<string, PreparedTextRenderEntry>();
  for (const [cacheKey, { content, variationAxes }] of requestedEntries) {
    const shapingFont = await resolveTextShapingFont(fontRegistry, font, content, variationAxes, variationSourceFont);

    // A 128px-per-em MSDF (vs the library's 42px default, tuned for
    // preview-sized text) keeps glyph edges crisp when a title fills a large
    // fraction of a 1080p+ frame: at the default, a full-width title
    // magnifies the atlas ~12x and its edges read visibly stair-stepped in
    // the encoded output. `range` stays at its default: the MSDF material's
    // alpha ramp is calibrated against that default, and a wider range
    // leaves a visible haze out to each glyph quad's own bounds.
    const data = await prepareTextRenderData(shapingFont, content, {
      atlasOptions: { fontSize: 128 },
    });
    entries.set(cacheKey, {
      cacheKey,
      data,
      fontBytes: Buffer.from(shapingFont.bytes),
      fontContentHash: shapingFont.contentHash,
    });
  }

  return Array.from(entries.values());
}

/**
 * Serializes `prepareTextRenderEntriesForProject`'s output to cross a
 * `page.evaluate` structured-clone boundary, for `runOneRangeAttempt`'s own
 * bundled browser-page render path (see that function's doc). Runs once per
 * job (not once per range/attempt - every range needs the exact same
 * entries, mirroring how `entrySource` itself is bundled once and reused).
 */
async function buildTextRenderEntriesForProject(
  project: Project,
): Promise<SerializedTextRenderEntry[]> {
  const entries = await prepareTextRenderEntriesForProject(project);
  return entries.map((entry) => ({
    cacheKey: entry.cacheKey,
    data: {
      atlasPages: entry.data.atlasPages.map((page) => ({
        width: page.width,
        height: page.height,
        pixels: Array.from(page.pixels),
        png: Array.from(page.png),
      })),
      glyphs: entry.data.glyphs,
      lineCount: entry.data.lineCount,
    },
    fontBytes: Array.from(entry.fontBytes),
    fontContentHash: entry.fontContentHash,
  }));
}

/** One prepared, real (non-serialized) image entry - `prepareImageEntriesForProject`'s own output shape, shared by both of its callers below. */
interface PreparedImageEntry {
  assetRef: string;
  bytes: Uint8Array;
}

/**
 * Fetches every distinct `ImageNode.assetRef` found anywhere in `project`'s
 * own scene graph (deduped, across every composition/track/clip) via
 * `fetchAssetBytes`. Mirrors `prepareTextRenderEntriesForProject`'s own
 * "one real, non-serialized core, two callers" shape: `buildImageRenderEntriesForProject`
 * (below) further serializes this result to cross a `page.evaluate`
 * structured-clone boundary; `buildTextureRegistryForProject` (exported)
 * decodes it directly into a `TextureRegistry` for a same-process renderer
 * instead, with no serialization boundary at all - see each one's own doc.
 *
 * `fetchAssetBytes` is optional and, when omitted, this returns `[]`
 * immediately: a caller with no asset store to fetch from (e.g. a test, or
 * any future caller with no asset-backed images at all) gets exactly
 * `submitEncodedRenderJob`'s pre-Layer-2 behavior back, not a crash. An
 * `assetRef` `fetchAssetBytes` itself cannot resolve (not actually stored,
 * or any other lookup failure it chooses to report as `undefined` rather
 * than throw) is silently omitted, not an error - matching
 * `TextureRegistry.resolve`'s own "unresolved is an expected runtime state"
 * contract: that `ImageNode` renders as the documented gray placeholder
 * instead of failing the whole render job over one missing asset.
 */
async function prepareImageEntriesForProject(
  project: Project,
  fetchAssetBytes?: (assetRef: string) => Promise<Uint8Array | undefined>,
): Promise<PreparedImageEntry[]> {
  if (fetchAssetBytes === undefined) {
    return [];
  }

  const assetRefs = new Set<string>();
  for (const composition of project.compositions) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        collectImageAssetRefs(clip.node, assetRefs);
      }
    }
  }

  const entries: PreparedImageEntry[] = [];
  for (const assetRef of assetRefs) {
    const bytes = await fetchAssetBytes(assetRef);
    if (bytes === undefined) {
      continue;
    }
    entries.push({ assetRef, bytes });
  }
  return entries;
}

/**
 * Serializes `prepareImageEntriesForProject`'s output to cross a
 * `page.evaluate` structured-clone boundary, for `runOneRangeAttempt`'s own
 * bundled browser-page render path (see that function's doc): no Node-only
 * decoding happens here at all (a real browser's own `createImageBitmap`
 * does that decoding, inside `browser-headless-render-entry.ts`'s own
 * `buildTextureRegistry`), this only fetches and serializes raw bytes.
 */
async function buildImageRenderEntriesForProject(
  project: Project,
  fetchAssetBytes?: (assetRef: string) => Promise<Uint8Array | undefined>,
): Promise<SerializedImageRenderEntry[]> {
  const entries = await prepareImageEntriesForProject(project, fetchAssetBytes);
  return entries.map((entry) => ({ assetRef: entry.assetRef, bytes: Array.from(entry.bytes) }));
}

/** Mirrors `PreparedImageEntry`, for the model case. */
interface PreparedModelEntry {
  assetRef: string;
  bytes: Uint8Array;
}

/**
 * Fetches every distinct `ModelNode.assetRef` found anywhere in `project`'s
 * own scene graph (deduped, across every composition/track/clip) via
 * `fetchAssetBytes` - mirrors `prepareImageEntriesForProject`'s own shape
 * exactly, including its "computed once per job, reused by every range"
 * treatment (a `ModelNode`'s own loaded scene/clips never vary by frame, the
 * same "resolve-only, keyed on the raw assetRef alone" reasoning
 * `ModelRegistry`'s own doc already gives for the same-process
 * `render_frames` path).
 *
 * Same "omitted `fetchAssetBytes`, or one `assetRef` it cannot resolve, is
 * not an error" contract as `prepareImageEntriesForProject`'s own doc - see
 * there for why.
 */
async function prepareModelEntriesForProject(
  project: Project,
  fetchAssetBytes?: (assetRef: string) => Promise<Uint8Array | undefined>,
): Promise<PreparedModelEntry[]> {
  if (fetchAssetBytes === undefined) {
    return [];
  }

  const assetRefs = new Set<string>();
  for (const composition of project.compositions) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        collectModelAssetRefs(clip.node, assetRefs);
      }
    }
  }

  const entries: PreparedModelEntry[] = [];
  for (const assetRef of assetRefs) {
    const bytes = await fetchAssetBytes(assetRef);
    if (bytes === undefined) {
      continue;
    }
    entries.push({ assetRef, bytes });
  }
  return entries;
}

/**
 * Serializes `prepareModelEntriesForProject`'s output to cross a
 * `page.evaluate` structured-clone boundary, mirroring
 * `buildImageRenderEntriesForProject`'s own doc: no Node-only parsing
 * happens here at all (`browser-headless-render-entry.ts`'s own
 * `buildModelRegistry` parses each entry's bytes in-page, via
 * `createDefaultParseGltf`), this only fetches and serializes raw bytes.
 */
async function buildModelRenderEntriesForProject(
  project: Project,
  fetchAssetBytes?: (assetRef: string) => Promise<Uint8Array | undefined>,
): Promise<SerializedModelAssetEntry[]> {
  const entries = await prepareModelEntriesForProject(project, fetchAssetBytes);
  return entries.map((entry) => ({ assetRef: entry.assetRef, bytes: Array.from(entry.bytes) }));
}

/**
 * Fetches every distinct `CompositionEnvironment.envMapRef` this project's
 * own compositions reference (via `collectEnvMapRefsForProject`, shared with
 * this same module's own same-process `buildEnvironmentRegistryForProject`)
 * and serializes each one's raw bytes to cross a `page.evaluate`
 * structured-clone boundary - the `environmentRenderEntries` counterpart to
 * `buildModelRenderEntriesForProject` immediately above, for
 * `browser-headless-render-entry.ts`'s own `runBrowserHeadlessRenderRange`/
 * `runBrowserHeadlessRender` caller.
 *
 * No decoding happens here: `parseHdrEnvironment` (like
 * `createDefaultParseGltf`) works identically in Node or in a real browser
 * page, so decoding stays deferred to whichever environment actually
 * renders, exactly like `buildModelRenderEntriesForProject`'s own doc
 * explains for GLTF. A ref `fetchAssetBytes` cannot resolve (including,
 * by design, every built-in name - see `buildEnvironmentRegistryForProject`'s
 * own doc) is simply omitted; the in-page registry falls back to the
 * renderer's own built-in procedural refs for anything not present here,
 * the same way the same-process path does.
 */
async function buildEnvironmentRenderEntriesForProject(
  project: Project,
  fetchAssetBytes?: (assetRef: string) => Promise<Uint8Array | undefined>,
): Promise<SerializedEnvironmentAssetEntry[]> {
  if (fetchAssetBytes === undefined) {
    return [];
  }

  const entries: SerializedEnvironmentAssetEntry[] = [];
  for (const envMapRef of collectEnvMapRefsForProject(project)) {
    const bytes = await fetchAssetBytes(envMapRef);
    if (bytes === undefined) {
      continue;
    }
    entries.push({ envMapRef, bytes: Array.from(bytes) });
  }
  return entries;
}

/**
 * Fetches every distinct `LutEffectConfig.lutRef` this project's own
 * compositions reference (via `collectLutRefsForProject`, shared with this
 * same module's own same-process `buildLutRegistryForProject`) and
 * serializes each one's raw bytes to cross a `page.evaluate`
 * structured-clone boundary - the `lutRenderEntries` counterpart to
 * `buildEnvironmentRenderEntriesForProject` immediately above, sharing its
 * exact same rationale (no decoding here; a ref that cannot be fetched is
 * simply omitted, falling back to the renderer's own built-in procedural
 * looks in-page).
 */
async function buildLutRenderEntriesForProject(
  project: Project,
  fetchAssetBytes?: (assetRef: string) => Promise<Uint8Array | undefined>,
): Promise<SerializedLutAssetEntry[]> {
  if (fetchAssetBytes === undefined) {
    return [];
  }

  const entries: SerializedLutAssetEntry[] = [];
  for (const lutRef of collectLutRefsForProject(project)) {
    const bytes = await fetchAssetBytes(lutRef);
    if (bytes === undefined) {
      continue;
    }
    entries.push({ lutRef, bytes: Array.from(bytes) });
  }
  return entries;
}

/** Mirrors `PreparedImageEntry`, for the video case. */
interface PreparedVideoEntry {
  assetRef: string;
  bytes: Uint8Array;
}

/**
 * Fetches every distinct `VideoNode.assetRef` found anywhere in `project`'s
 * own scene graph (deduped, across every composition/track/clip) via
 * `fetchAssetBytes` - mirrors `prepareImageEntriesForProject`'s own shape
 * exactly, one asset fetch per distinct `assetRef` regardless of how many
 * `VideoNode`s (or ranges) actually reference it; every range of the same
 * job reuses this same result (see `runEncodedRenderJob`'s own "computed
 * once per job" comment), since the raw bytes a `VideoNode.assetRef`
 * resolves to do not depend on which frame range is currently rendering,
 * only on which distinct assets the whole project references at all.
 *
 * Same "omitted `fetchAssetBytes`, or one `assetRef` it cannot resolve" is
 * not an error" contract as `prepareImageEntriesForProject`'s own doc - see
 * there for why.
 */
async function prepareVideoEntriesForProject(
  project: Project,
  fetchAssetBytes?: (assetRef: string) => Promise<Uint8Array | undefined>,
): Promise<PreparedVideoEntry[]> {
  if (fetchAssetBytes === undefined) {
    return [];
  }

  const assetRefs = new Set<string>();
  for (const composition of project.compositions) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        collectVideoAssetRefs(clip.node, assetRefs);
      }
    }
  }

  const entries: PreparedVideoEntry[] = [];
  for (const assetRef of assetRefs) {
    const bytes = await fetchAssetBytes(assetRef);
    if (bytes === undefined) {
      continue;
    }
    entries.push({ assetRef, bytes });
  }
  return entries;
}

/**
 * Serializes `prepareVideoEntriesForProject`'s output to cross a
 * `page.evaluate` structured-clone boundary, mirroring
 * `buildImageRenderEntriesForProject`'s own doc exactly: no Node-only
 * decoding happens here at all (a real browser's own `HTMLVideoElement`
 * does that decoding, inside `browser-headless-render-entry.ts`'s own
 * `buildVideoFrameRegistry`), this only fetches and serializes raw bytes.
 */
async function buildVideoAssetEntriesForProject(
  project: Project,
  fetchAssetBytes?: (assetRef: string) => Promise<Uint8Array | undefined>,
): Promise<SerializedVideoAssetEntry[]> {
  const entries = await prepareVideoEntriesForProject(project, fetchAssetBytes);
  return entries.map((entry) => ({ assetRef: entry.assetRef, bytes: Array.from(entry.bytes) }));
}

/**
 * Builds a real (non-serialized) `TextRenderRegistry` for `project`, via the
 * same `prepareTextRenderEntriesForProject` every `TextNode` in this module
 * ultimately renders through - for a caller driving a same-process renderer
 * directly (e.g. `@cadra/headless`'s `createNativeGpuHeadlessRenderer`, no
 * browser page and therefore no structured-clone boundary to serialize
 * across at all), rather than this module's own bundled-browser-page range
 * pipeline. Returns `undefined` (not an empty registry) when `project` has
 * no text nodes at all, matching `TextRenderRegistry`'s own "omit entirely
 * for a text-less scene" convention elsewhere in this codebase (e.g.
 * `@cadra/golden-frames`' `render-raster-scene.ts`).
 */
export async function buildTextRenderRegistryForProject(
  project: Project,
): Promise<TextRenderRegistry | undefined> {
  const entries = await prepareTextRenderEntriesForProject(project);
  if (entries.length === 0) {
    return undefined;
  }

  const registry = createInMemoryTextRenderRegistry();
  for (const entry of entries) {
    registry.register(entry.cacheKey, {
      data: entry.data,
      fontBytes: entry.fontBytes,
      fontContentHash: entry.fontContentHash,
    });
  }
  return registry;
}

/**
 * Builds a real (non-serialized) `TextureRegistry` for `project`, via
 * `prepareImageEntriesForProject`'s own shared collection/fetch logic - the
 * `TextureRegistry` counterpart to `buildTextRenderRegistryForProject`
 * immediately above, for the exact same "no browser page, no
 * `page.evaluate` structured-clone boundary at all" caller
 * (`@cadra/headless`'s `createNativeGpuHeadlessRenderer`). Returns
 * `undefined` (not an empty registry) when `project` has no image nodes at
 * all, or none of them resolve, matching `TextRenderRegistry`'s own "omit
 * entirely" convention.
 *
 * Decodes each entry's raw bytes as PNG via `pngjs` (`PNG.sync.read`) -
 * unlike `browser-headless-render-entry.ts`'s own `buildTextureRegistry`,
 * this has no real browser page to hand off to (`createImageBitmap` does
 * not exist in plain Node), so PNG is the one format this same-process path
 * can decode at all; any other format (or corrupt PNG bytes) fails this
 * entry's own `PNG.sync.read` call, caught and logged the same
 * "unresolved is an expected runtime state" way `buildTextureRegistry`
 * itself already handles a decode failure - that one `ImageNode` falls
 * through to the renderer's own documented gray placeholder instead of
 * failing the whole render.
 */
export async function buildTextureRegistryForProject(
  project: Project,
  fetchAssetBytes?: (assetRef: string) => Promise<Uint8Array | undefined>,
): Promise<TextureRegistry | undefined> {
  const entries = await prepareImageEntriesForProject(project, fetchAssetBytes);
  if (entries.length === 0) {
    return undefined;
  }

  const registry = createInMemoryTextureRegistry();
  for (const entry of entries) {
    try {
      const png = PNG.sync.read(Buffer.from(entry.bytes));
      registry.register(entry.assetRef, createDataTexture(new Uint8Array(png.data), png.width, png.height));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `buildTextureRegistryForProject: failed to decode image asset "${entry.assetRef}" as PNG (${message}). ` +
          "This node renders as the documented gray placeholder instead.",
      );
    }
  }
  return registry;
}

/** Every distinct `envMapRef` any composition in `project` actually references. */
function collectEnvMapRefsForProject(project: Project): Set<string> {
  const refs = new Set<string>();
  for (const composition of project.compositions) {
    if (composition.environment !== undefined) {
      refs.add(composition.environment.envMapRef);
    }
  }
  return refs;
}

/** Every distinct `lutRef` any composition's `postProcessing` effect stack in `project` actually references. */
function collectLutRefsForProject(project: Project): Set<string> {
  const refs = new Set<string>();
  for (const composition of project.compositions) {
    for (const effect of composition.postProcessing?.effects ?? []) {
      if (effect.type === "lut") {
        refs.add(effect.lutRef);
      }
    }
  }
  return refs;
}

/**
 * Builds a real (non-serialized) `EnvironmentRegistry` for `project`,
 * fetching and decoding every distinct `CompositionEnvironment.envMapRef`
 * found anywhere in its own compositions via `fetchAssetBytes` - the
 * `EnvironmentRegistry` counterpart to `buildTextureRegistryForProject`
 * immediately above, for the exact same "no browser page, no `page.evaluate`
 * structured-clone boundary at all" caller (`@cadra/headless`'s
 * `createNativeGpuHeadlessRenderer`, which already accepts an
 * `environmentRegistry` option - see that function's own doc - but had no
 * caller building a real one until now; every prior caller of either that
 * function or `@cadra/renderer`'s own `createRenderer` silently fell back to
 * `createDefaultEnvironmentRegistry()`'s two built-in procedural refs only,
 * `"studio"`/`"outdoor"`, so a scene author's real uploaded HDR environment
 * - a validly-typed `envMapRef`, per `parse.ts`'s own `ASSET_REF_FIELD_NAMES`
 * classification - rendered with no environment lighting/reflections at all,
 * with no error or diagnostic).
 *
 * A ref `fetchAssetBytes` cannot resolve (including, by design, every
 * built-in name - `createAssetBytesFetcher` returns `undefined` for anything
 * outside its own `cadra-asset://` scheme) is simply not added to this
 * registry's own custom map; `resolve` falls through to a real
 * `createDefaultEnvironmentRegistry()` for anything this project-specific
 * registry does not itself know about, so built-in refs keep working
 * unchanged and only real uploaded HDR environments need this function at
 * all. Bytes that fail to decode as a real HDR file are logged and skipped
 * the same "unresolved is an expected runtime state" way an unresolved
 * `ModelNode`/`ImageNode` asset already is - that composition's environment
 * then resolves exactly as if `envMapRef` were never set.
 *
 * Returns `undefined` (not an empty registry) when `project` references no
 * `envMapRef` at all, matching `TextRenderRegistry`'s/`TextureRegistry`'s
 * own "omit entirely" convention - `ThreeRenderer`'s own constructor default
 * already covers that case identically (a fresh
 * `createDefaultEnvironmentRegistry()`), so there is nothing this function
 * would add.
 */
export async function buildEnvironmentRegistryForProject(
  project: Project,
  fetchAssetBytes?: (assetRef: string) => Promise<Uint8Array | undefined>,
): Promise<EnvironmentRegistry | undefined> {
  if (fetchAssetBytes === undefined) {
    return undefined;
  }

  const refs = collectEnvMapRefsForProject(project);
  if (refs.size === 0) {
    return undefined;
  }

  const custom = new Map<string, ReturnType<typeof parseHdrEnvironment>>();
  for (const ref of refs) {
    const bytes = await fetchAssetBytes(ref);
    if (bytes === undefined) {
      continue;
    }
    try {
      custom.set(ref, parseHdrEnvironment(bytes));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `buildEnvironmentRegistryForProject: failed to decode environment asset "${ref}" as HDR (${message}). ` +
          "This composition's environment resolves as if envMapRef were never set instead.",
      );
    }
  }

  const defaults = createDefaultEnvironmentRegistry();
  return {
    resolve: (ref: string) => custom.get(ref) ?? defaults.resolve(ref),
  };
}

/**
 * Builds a real (non-serialized) `LutRegistry` for `project`, fetching and
 * decoding every distinct `LutEffectConfig.lutRef` found anywhere in any
 * composition's `postProcessing.effects` via `fetchAssetBytes` - the
 * `LutRegistry` counterpart to `buildEnvironmentRegistryForProject`
 * immediately above, sharing its exact same rationale, fallback-to-built-ins
 * shape, and "no caller built one until now" gap (`createNativeGpuHeadlessRenderer`'s
 * own `lutRegistry` option; `createDefaultLutRegistry()`'s own three
 * built-in procedural looks, `"warm"`/`"tealOrange"`/`"filmStock"`, were the
 * only ones ever reachable in production - a real uploaded `.cube` file
 * silently applied no grade at all).
 *
 * Returns `undefined` when `project` references no `lutRef` at all, for the
 * same reason `buildEnvironmentRegistryForProject` does.
 */
export async function buildLutRegistryForProject(
  project: Project,
  fetchAssetBytes?: (assetRef: string) => Promise<Uint8Array | undefined>,
): Promise<LutRegistry | undefined> {
  if (fetchAssetBytes === undefined) {
    return undefined;
  }

  const refs = collectLutRefsForProject(project);
  if (refs.size === 0) {
    return undefined;
  }

  const custom = new Map<string, ReturnType<typeof parseCubeLut>>();
  for (const ref of refs) {
    const bytes = await fetchAssetBytes(ref);
    if (bytes === undefined) {
      continue;
    }
    try {
      const text = new TextDecoder("utf-8").decode(bytes);
      custom.set(ref, parseCubeLut(text));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `buildLutRegistryForProject: failed to decode LUT asset "${ref}" as a .cube file (${message}). ` +
          "This effect resolves as if lutRef were never set instead.",
      );
    }
  }

  const defaults = createDefaultLutRegistry();
  return {
    resolve: (ref: string) => custom.get(ref) ?? defaults.resolve(ref),
  };
}

/**
 * Builds a real (non-serialized) `ModelRegistry` for `project`, fetching and
 * parsing every distinct `ModelNode.assetRef` found anywhere in its own
 * scene graph via `fetchAssetBytes` - the `ModelRegistry` counterpart to
 * `buildTextureRegistryForProject` immediately above, for the exact same "no
 * browser page, no `page.evaluate` structured-clone boundary at all" caller
 * (`@cadra/headless`'s `createNativeGpuHeadlessRenderer`, which already
 * accepts a `modelRegistry` option - see that function's own doc - but had
 * no caller building one until now).
 *
 * Parses via `createDefaultParseGltf()` directly on each fetched entry's
 * bytes, not `loadGltf` (which additionally re-fetches its own bytes
 * internally via a `FetchBytes`-shaped resolver) - this function already has
 * the bytes in hand from `fetchAssetBytes`, mirroring
 * `buildTextureRegistryForProject`'s own "fetch once, decode directly" shape
 * rather than going through a second loader. `createDefaultParseGltf`'s own
 * result (`{scene, animations}`) already structurally satisfies
 * `LoadedModel` - see that function's own doc.
 *
 * `fetchAssetBytes` is optional and, when omitted, this returns `undefined`
 * immediately, matching `buildTextureRegistryForProject`'s own "no asset
 * store, nothing decoded" behavior. An `assetRef` `fetchAssetBytes` cannot
 * resolve, or whose bytes fail to parse as a valid GLTF/GLB, is silently
 * skipped instead of failing the whole render - matching `ModelRegistry`'s
 * own "unresolved is an expected runtime state" contract (that `ModelNode`
 * renders as an empty group; see `node-factory.ts`'s own `"model"` case).
 *
 * Returns `undefined` (not an empty registry) when `project` has no model
 * nodes at all, matching `TextRenderRegistry`'s/`TextureRegistry`'s own
 * "omit entirely" convention.
 */
export async function buildModelRegistryForProject(
  project: Project,
  fetchAssetBytes?: (assetRef: string) => Promise<Uint8Array | undefined>,
): Promise<ModelRegistry | undefined> {
  if (fetchAssetBytes === undefined) {
    return undefined;
  }

  const assetRefs = new Set<string>();
  for (const composition of project.compositions) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        collectModelAssetRefs(clip.node, assetRefs);
      }
    }
  }

  if (assetRefs.size === 0) {
    return undefined;
  }

  const parseGltf = createDefaultParseGltf();
  const registry = createInMemoryModelRegistry();
  for (const assetRef of assetRefs) {
    const bytes = await fetchAssetBytes(assetRef);
    if (bytes === undefined) {
      continue;
    }
    try {
      const asset = await parseGltf(bytes);
      registry.register(assetRef, asset as LoadedModel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `buildModelRegistryForProject: failed to parse model asset "${assetRef}" as GLTF/GLB (${message}). ` +
          "This node renders as an empty group instead.",
      );
    }
  }
  return registry;
}

let cachedDefaultSatoriFonts: Promise<SatoriLayerFont[]> | undefined;

/**
 * Loads this module's own bundled `Inter-Variable.ttf` as a `SatoriLayerFont`
 * array for Satori rendering - both `buildSatoriLayerRenderRegistryForProject`
 * and `buildSatoriLayerRenderEntriesForRange`'s own shared font source (see
 * either one's own doc for why this specific mechanism is safe against the
 * `fvar`-parsing crash a *raw* variable font triggers in Satori's bundled
 * font parser). Parsed via `parseFontWithFontkit` (not the `"opentype"`
 * backend `prepareTextRenderEntriesForProject` uses for its own bundled
 * font): unlike that function's own output, nothing here ever crosses a
 * `page.evaluate` structured-clone boundary into a browser-bundled page -
 * Satori itself is a native-Node-addon-backed renderer with no browser
 * build at all (see `@cadra/satori-layer`'s own package doc), so every
 * caller of this helper already runs in plain Node regardless of which
 * render path (native-GPU or browser-based) is ultimately producing the
 * final video - so `fontkit`'s fuller, Node-only metrics/instancing support
 * is simply the better choice here, with no cross-environment constraint to
 * trade it away for.
 *
 * Memoized (once per process, not once per call): the same bytes parse to
 * the same result every time, and both call sites may run within the same
 * render job.
 */
function loadDefaultSatoriFonts(): Promise<SatoriLayerFont[]> {
  if (cachedDefaultSatoriFonts === undefined) {
    cachedDefaultSatoriFonts = (async () => {
      const fontBytes = readFileSync(DEFAULT_FONT_PATH);
      const font = parseFontWithFontkit(new Uint8Array(fontBytes));
      return [{ family: "Inter", font, weight: 400, style: "normal" } satisfies SatoriLayerFont];
    })();
  }
  return cachedDefaultSatoriFonts;
}

/**
 * Builds a real (non-serialized) `SatoriLayerRenderRegistry` for `project`,
 * pre-rendering and rasterizing every distinct `SatoriNode` at every frame
 * in `frames` - the `SatoriLayerRenderRegistry` counterpart to
 * `buildTextRenderRegistryForProject`/`buildTextureRegistryForProject`
 * above, for the exact same "no browser page, no `page.evaluate`
 * structured-clone boundary at all" caller (`@cadra/headless`'s
 * `createNativeGpuHeadlessRenderer`).
 *
 * Unlike text/image (registered once, frame-independent - a `TextNode`'s
 * own shaped glyphs and an `ImageNode`'s own decoded texture never depend
 * on which frame is being rendered), a `SatoriNode`'s own rendered pixels
 * genuinely can vary by frame (`elementAnimations`; see
 * `computeSatoriLayerRenderKey`'s own doc), so this needs the caller's own
 * exact frame list up front rather than resolving once - `frames` mirrors
 * exactly what a caller (e.g. `render_frames`, whose own input is already
 * a bounded, explicit list of frames to render) already has in hand, no
 * per-range windowing/streaming the way video's own per-range sample
 * computation needs.
 *
 * Returns `undefined` (not an empty registry) when `project` has no satori
 * nodes at all, matching `TextRenderRegistry`'s/`TextureRegistry`'s own
 * "omit entirely" convention.
 *
 * Fonts for `prepareSatoriLayerRenderData` come from `loadDefaultSatoriFonts`
 * (this module's own bundled `Inter-Variable.ttf`, the same file
 * `prepareTextRenderEntriesForProject` uses for every `TextNode`) - passing
 * the *raw* variable-font bytes straight to Satori crashes (Satori's own
 * bundled `@shuding/opentype.js` fork throws inside `parseFvarAxis` on any
 * font with an active variation axis), but `@cadra/satori-layer`'s own
 * `instanceFontForSatori` (invoked automatically inside `renderLayerToSvg`
 * for every entry in `fonts`) already exists specifically to prevent that:
 * it pins every variation axis to a static value and subsets the result
 * before Satori ever sees it - the exact mechanism `parseFvarAxis` needs to
 * not be reached at all. Verified directly, empirically, against this exact
 * font file (constructing a real `SatoriLayerFont` and feeding it through a
 * real `prepareSatoriLayerRenderData` call) that this renders real glyphs
 * with no crash, and that Satori falls back to this one available font
 * regardless of whether a layer's own `fontFamily` matches it, is a generic
 * CSS name like `"sans-serif"`, or is omitted entirely.
 */
export async function buildSatoriLayerRenderRegistryForProject(
  project: Project,
  frames: readonly number[],
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

  const fonts = await loadDefaultSatoriFonts();
  const registry = createInMemorySatoriLayerRenderRegistry();
  for (const node of satoriNodes) {
    for (const frame of frames) {
      const cacheKey = computeSatoriLayerRenderKey(node, frame);
      if (registry.resolve(cacheKey) !== undefined) {
        continue;
      }
      const rasterized = await prepareSatoriLayerRenderData(node, frame, fonts);
      registry.register(cacheKey, { rasterized });
    }
  }

  return registry;
}

/**
 * Fetches every distinct `SatoriNode` render-key's own rasterized pixels
 * needed anywhere within `[startFrame, endFrame)` - `render_scene`'s own
 * per-range counterpart to `buildSatoriLayerRenderRegistryForProject`
 * (`render_frames`' own same-process path) immediately above: computed once
 * per range (not once per job, unlike image/model/video's own raw asset
 * bytes), because a `SatoriNode`'s own rendered pixels genuinely can vary by
 * frame (`elementAnimations`; see `computeSatoriLayerRenderKey`'s own doc),
 * scoped to exactly the frames this one range actually needs - mirroring
 * `computeNeededVideoSamplesForRange`'s own per-range scoping. One
 * difference: unlike video, satori has no cheaper "resolve which distinct
 * samples are needed" arithmetic separate from the render itself, so every
 * frame in the range is walked directly, deduped only by `cacheKey` (a node
 * whose `elementAnimations` resolves to the same style across a run of
 * frames still rasterizes only once for that whole run, the same dedup
 * `buildSatoriLayerRenderRegistryForProject` itself already does).
 *
 * Fonts come from `loadDefaultSatoriFonts`, shared with
 * `buildSatoriLayerRenderRegistryForProject` - see that function's own doc.
 *
 * Returns `[]` when `project` has no satori nodes at all - the browser
 * side's own `buildSatoriLayerRenderRegistry` (see
 * `browser-headless-render-entry.ts`) already treats an empty entries array
 * the same as "no satori content to register," matching every other asset
 * kind's own "omitted means placeholder" contract.
 */
async function buildSatoriLayerRenderEntriesForRange(
  project: Project,
  startFrame: number,
  endFrame: number,
): Promise<SerializedSatoriLayerRenderEntry[]> {
  const satoriNodes: SatoriNode[] = [];
  for (const composition of project.compositions) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        collectSatoriNodes(clip.node, satoriNodes);
      }
    }
  }

  if (satoriNodes.length === 0) {
    return [];
  }

  const fonts = await loadDefaultSatoriFonts();
  const seenCacheKeys = new Set<string>();
  const entries: SerializedSatoriLayerRenderEntry[] = [];
  for (const node of satoriNodes) {
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const cacheKey = computeSatoriLayerRenderKey(node, frame);
      if (seenCacheKeys.has(cacheKey)) {
        continue;
      }
      seenCacheKeys.add(cacheKey);
      const rasterized = await prepareSatoriLayerRenderData(node, frame, fonts);
      entries.push({
        cacheKey,
        width: rasterized.width,
        height: rasterized.height,
        pixels: Array.from(rasterized.pixels),
      });
    }
  }

  return entries;
}

/**
 * Runs exactly one range attempt: launches a fresh browser (mirroring
 * `renderCompositionHeadlessServer`'s own `runOneAttempt`: one browser
 * launch per attempt, not shared/reused across attempts, for the same
 * clean-slate-per-attempt simplicity; see this module's own top-level doc),
 * opens a page, relays `console`/`pageerror` output through `onLog` and
 * per-frame progress through `onProgress`, evaluates the bundled
 * `runBrowserHeadlessRenderRange` for `range`, and returns its resulting
 * `SerializedEncodedChunk[]`, all bounded by `timeoutMs`.
 */
async function runOneRangeAttempt(
  launcher: BrowserLauncher,
  entrySource: string,
  baseConfig: Omit<
    BrowserRangeConfigArg,
    "startFrame" | "endFrame" | "videoSamplesNeeded" | "satoriLayerRenderEntries"
  >,
  videoNodeMappings: readonly VideoNodeMapping[],
  range: { startFrame: number; endFrame: number },
  onProgress: OnProgressFn | undefined,
  onLog: OnLogFn | undefined,
  timeoutMs: number,
): Promise<SerializedEncodedChunk[]> {
  let browser: HeadlessBrowserLike | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(`submitEncodedRenderJob: range attempt did not finish within ${timeoutMs}ms.`),
      );
    }, timeoutMs);
    (timeoutHandle as unknown as { unref?: () => void }).unref?.();
  });
  timeoutPromise.catch(() => {});

  try {
    browser = await launcher({});

    const crashed = new Promise<never>((_resolve, reject) => {
      browser?.onDisconnected(() => {
        reject(
          new Error(
            "submitEncodedRenderJob: the headless browser disconnected/crashed before the range render completed.",
          ),
        );
      });
    });
    crashed.catch(() => {});

    const page = await browser.newPage();
    page.onConsoleMessage((message) => {
      onLog?.({ level: message.type(), message: message.text() });
    });
    page.onPageError((error) => {
      onLog?.({ level: "error", message: error.message });
    });

    // Progress is relayed via a Node-side exposeFunction bridge, mirroring
    // renderCompositionHeadlessServer's own write/close/progress bridge:
    // buildEncodedChunksForRange's own renderComposition call (inside the
    // page) reports progress through window.__cadraHeadlessProgress
    // (the same global name the whole-composition path uses), so exposing
    // that exact name here is what wires this range's own progress calls
    // back out, with no change needed to the browser-side entry code.
    await page.exposeFunction("__cadraHeadlessProgress", ((frame: number, totalFrames: number) => {
      onProgress?.(frame, totalFrames);
    }) as (...args: never[]) => unknown);

    await page.addScript(entrySource);

    // Computed here, not passed in via baseConfig: a SatoriNode's own
    // rendered pixels genuinely can vary by frame (elementAnimations), so
    // which cache keys this specific range's own [startFrame, endFrame)
    // needs varies per range, exactly like videoSamplesNeeded below - see
    // buildSatoriLayerRenderEntriesForRange's own doc.
    const satoriLayerRenderEntries = await buildSatoriLayerRenderEntriesForRange(
      baseConfig.project,
      range.startFrame,
      range.endFrame,
    );

    const config: BrowserRangeConfigArg = {
      ...baseConfig,
      startFrame: range.startFrame,
      endFrame: range.endFrame,
      satoriLayerRenderEntries,
      // Computed here, not passed in via baseConfig: unlike
      // videoAssetEntries (job-wide raw bytes, identical for every range),
      // which sourceFrames this specific range's own [startFrame, endFrame)
      // needs genuinely varies per range - see
      // computeNeededVideoSamplesForRange's own doc.
      videoSamplesNeeded: computeNeededVideoSamplesForRange(
        videoNodeMappings,
        range.startFrame,
        range.endFrame,
      ),
    };

    // See render-composition-headless-server.ts's own extensive doc on why
    // `globalName` is passed through `arg` rather than closed over: the
    // same rationale (page.evaluate re-executes pageFunction's source
    // inside the page, with no access to this module's own enclosing
    // scope) applies identically here.
    const renderDone = page.evaluate(
      (arg: { config: BrowserRangeConfigArg; globalName: string }) => {
        const entry = (
          window as unknown as Record<
            string,
            | {
                runBrowserHeadlessRenderRange: (
                  config: BrowserRangeConfigArg,
                ) => Promise<SerializedEncodedChunk[]>;
              }
            | undefined
          >
        )[arg.globalName];
        if (entry === undefined) {
          throw new Error(
            `submitEncodedRenderJob: window["${arg.globalName}"] was not defined; the bundled entry script did not load correctly before evaluate() ran.`,
          );
        }
        return entry.runBrowserHeadlessRenderRange(arg.config);
      },
      { config, globalName: BROWSER_ENTRY_GLOBAL_NAME },
    );

    return await Promise.race([renderDone, crashed, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
    // `browser.close()` itself has no bounded wait anywhere in this
    // codebase: under sustained CPU contention (e.g. many concurrent
    // software-rendered Chromium instances, see browser-launcher.ts's own
    // doc on why this launcher defaults to swiftshader), a `close()` call
    // on an already-struggling browser process can itself hang well past
    // this attempt's own timeoutMs, delaying the next attempt's fresh
    // `launcher({})` call and compounding exactly the CPU pressure that
    // caused the timeout in the first place. Racing it against a fixed
    // ceiling bounds that: an attempt that hit `timeoutMs` always frees up
    // this function's own caller within `timeoutMs + BROWSER_CLOSE_GRACE_MS`
    // at the very most, whether or not the underlying process ever
    // actually finishes tearing down.
    if (browser !== undefined) {
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise<void>((resolve) => {
          const handle = setTimeout(resolve, BROWSER_CLOSE_GRACE_MS);
          (handle as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
    }
  }
}

/**
 * Collects every distinct `AudioMixdownSegment.assetRef` in
 * `project`'s own composition `compositionId`'s resolved audio mixdown
 * (`@cadra/core`'s `resolveAudioMixdown`) and fetches each one's raw bytes
 * via `fetchAssetBytes`, mirroring `prepareImageEntriesForProject`'s own
 * shape for the image case. Unlike that function, this resolves against
 * one specific composition (audio mixdown resolution is inherently
 * per-composition, unlike `ImageNode`/`TextNode` collection, which walks
 * every composition in `project`), matching exactly what this job's own
 * final render actually targets.
 *
 * Returns `[]` (not an error) both when `fetchAssetBytes` is omitted and
 * when the mixdown itself has no segments at all: a caller checking for
 * "is there any audio to render" should resolve the mixdown itself first
 * (see `runEncodedRenderJob`'s own doc) rather than infer it from this
 * function's own return value being empty for a different reason.
 *
 * An `assetRef` `fetchAssetBytes` itself cannot resolve is silently
 * omitted, not an error - every segment referencing it renders as silence
 * for its own window instead, matching `ResolveAudioBufferFn`'s own
 * "unresolved is an expected runtime state" contract exactly (the audio-
 * side counterpart to an unresolved `ImageNode.assetRef` falling back to
 * the renderer's own gray placeholder).
 */
async function prepareAudioMixdownAssetEntries(
  project: Project,
  compositionId: string,
  fetchAssetBytes?: (assetRef: string) => Promise<Uint8Array | undefined>,
): Promise<SerializedAudioAssetEntry[]> {
  if (fetchAssetBytes === undefined) {
    return [];
  }

  const mixdown = resolveAudioMixdown(project, compositionId);
  const assetRefs = new Set(mixdown.segments.map((segment) => segment.assetRef));

  const entries: SerializedAudioAssetEntry[] = [];
  for (const assetRef of assetRefs) {
    const bytes = await fetchAssetBytes(assetRef);
    if (bytes === undefined) {
      continue;
    }
    entries.push({ assetRef, bytes: Array.from(bytes) });
  }
  return entries;
}

/**
 * Launches one fresh browser (mirroring `runOneRangeAttempt`'s own
 * per-attempt-fresh-browser rationale - see that function's doc), evaluates
 * the bundled `runBrowserHeadlessAudioMixdown` for this job's own
 * composition, and returns its `SerializedAudioMixdownResult` (or
 * `undefined`, for a composition whose mixdown has no segments at all).
 *
 * Runs independently of every video range's own `runOneRangeAttempt` call
 * (`runEncodedRenderJob` kicks this off alongside `dispatch`, not after
 * it), since audio mixdown/encoding for the whole composition has no range
 * to align against and no dependency on any video range's own output.
 *
 * Unlike a video range attempt, this has no retry loop of its own: a
 * failure here (any rejection at all, including a genuine
 * `WebCodecsUnavailableForAudioEncodingError` from `encodeAudio` itself,
 * not just a single asset's own decode failure - see
 * `runBrowserHeadlessAudioMixdown`'s own doc for that distinction) is
 * caught by this function's own caller (`runEncodedRenderJob`) and treated
 * as "no audio for this render," logged via `onLog`, not a reason to fail
 * an otherwise-successful video render over an audio-only problem.
 */
async function runAudioMixdownAttempt(
  launcher: BrowserLauncher,
  entrySource: string,
  config: BrowserAudioMixdownConfigArg,
  onLog: OnLogFn | undefined,
  timeoutMs: number,
): Promise<SerializedAudioMixdownResult | undefined> {
  let browser: HeadlessBrowserLike | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`submitEncodedRenderJob: audio mixdown did not finish within ${timeoutMs}ms.`));
    }, timeoutMs);
    (timeoutHandle as unknown as { unref?: () => void }).unref?.();
  });
  timeoutPromise.catch(() => {});

  try {
    browser = await launcher({});

    const crashed = new Promise<never>((_resolve, reject) => {
      browser?.onDisconnected(() => {
        reject(
          new Error(
            "submitEncodedRenderJob: the headless browser disconnected/crashed before the audio mixdown completed.",
          ),
        );
      });
    });
    crashed.catch(() => {});

    const page = await browser.newPage();
    page.onConsoleMessage((message) => {
      onLog?.({ level: message.type(), message: message.text() });
    });
    page.onPageError((error) => {
      onLog?.({ level: "error", message: error.message });
    });

    await page.addScript(entrySource);

    const mixdownDone = page.evaluate(
      (arg: { config: BrowserAudioMixdownConfigArg; globalName: string }) => {
        const entry = (
          window as unknown as Record<
            string,
            | {
                runBrowserHeadlessAudioMixdown: (
                  config: BrowserAudioMixdownConfigArg,
                ) => Promise<SerializedAudioMixdownResult | undefined>;
              }
            | undefined
          >
        )[arg.globalName];
        if (entry === undefined) {
          throw new Error(
            `submitEncodedRenderJob: window["${arg.globalName}"] was not defined; the bundled entry script did not load correctly before evaluate() ran.`,
          );
        }
        return entry.runBrowserHeadlessAudioMixdown(arg.config);
      },
      { config, globalName: BROWSER_ENTRY_GLOBAL_NAME },
    );

    return await Promise.race([mixdownDone, crashed, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
    // See runOneRangeAttempt's own identical doc for why browser.close()
    // itself races a bounded grace ceiling rather than being awaited
    // unconditionally.
    if (browser !== undefined) {
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise<void>((resolve) => {
          const handle = setTimeout(resolve, BROWSER_CLOSE_GRACE_MS);
          (handle as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
    }
  }
}

/**
 * Concatenates every range's `SerializedEncodedChunk[]` (already in frame
 * order, since `@cadra/headless`'s job `result` resolves with every range's
 * segment ordered by `rangeIndex`) into one flat, frame-ordered
 * `EncodedChunkResult` array, deserializing each chunk back via
 * `deserializeEncodedChunkResult`.
 */
function concatenateSegments(segments: readonly SerializedEncodedChunk[][]): EncodedChunkResult[] {
  const flat: EncodedChunkResult[] = [];
  for (const segment of segments) {
    for (const serialized of segment) {
      flat.push(deserializeEncodedChunkResult(serialized));
    }
  }
  return flat;
}

/** Adapts an in-memory `EncodedChunkResult[]` into the `AsyncGenerator` shape `muxToMp4Stream`/`muxToWebmStream` accept. */
async function* toAsyncGenerator(
  chunks: readonly EncodedChunkResult[],
): AsyncGenerator<EncodedChunkResult> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/**
 * The codec string `firstChunkCodec` needs, read off `chunks`' first entry
 * with a `decoderConfig.codec`, or a valid fallback for an empty render;
 * mirrors `browser-headless-render-entry.ts`'s own
 * `rewindWithFirstChunkCodec` fallback rationale exactly (a
 * `durationInFrames: 0` composition legitimately produces zero chunks/zero
 * ranges).
 */
function resolveFirstChunkCodec(chunks: readonly EncodedChunkResult[]): string {
  for (const chunk of chunks) {
    const codec = chunk.metadata?.decoderConfig?.codec;
    if (codec !== undefined) {
      return codec;
    }
  }
  return "avc1.42001f";
}

/** Adapts an in-memory `EncodedAudioChunkResult[]` into the `AsyncGenerator` shape `MuxMp4AudioTrackOptions`/`MuxWebmAudioTrackOptions` accept, mirroring `toAsyncGenerator`'s own video-side purpose. */
async function* toAudioAsyncGenerator(
  chunks: readonly EncodedAudioChunkResult[],
): AsyncGenerator<EncodedAudioChunkResult> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** Deserializes `result` (`runAudioMixdownAttempt`'s own return value) into the `MuxMp4AudioTrackOptions`/`MuxWebmAudioTrackOptions` shape `muxToMp4Stream`/`muxToWebmStream` both accept as their shared `audio` argument shape. */
function toMuxAudioTrackOptions(
  result: SerializedAudioMixdownResult,
): MuxMp4AudioTrackOptions | MuxWebmAudioTrackOptions {
  const chunks = result.chunks.map((chunk) => deserializeEncodedAudioChunkResult(chunk));
  return {
    chunks: toAudioAsyncGenerator(chunks),
    codec: result.codec,
    numberOfChannels: result.numberOfChannels,
    sampleRate: result.sampleRate,
  };
}

/**
 * Once every range has succeeded (`renderResult`), concatenates every
 * range's segment and performs the single final mux pass into
 * `destination`, then calls `destination.end()`. `audio` (`runEncodedRenderJob`'s
 * own `runAudioMixdownAttempt` result, if the composition had any audio
 * content at all) is threaded into `muxToMp4Stream`/`muxToWebmStream`'s
 * own optional `audio` argument; omitted entirely (not an empty track)
 * produces the exact same video-only file this function always produced
 * before audio existed, matching `renderAudioMixdown`'s own "a caller
 * decides whether a silent mixdown is worth encoding" contract.
 */
async function muxConcatenatedSegments(
  segments: readonly SerializedEncodedChunk[][],
  options: {
    format: "mp4" | "webm";
    destination: HeadlessServerFileWriteStreamLike;
    project: Project;
    compositionId: string;
    audio?: SerializedAudioMixdownResult;
  },
): Promise<void> {
  const composition = options.project.compositions.find(
    (candidate) => candidate.id === options.compositionId,
  );
  const flatChunks = concatenateSegments(segments);
  const firstChunkCodec = resolveFirstChunkCodec(flatChunks);

  const muxOptions = {
    width: composition?.width ?? 0,
    height: composition?.height ?? 0,
    fps: composition?.fps ?? 0,
  };

  // HeadlessServerFileWriteStreamLike (`write`/`end`) is a strict superset of
  // NodeWritableLike (`write` only), so it satisfies that structural type
  // directly; muxToMp4Stream/muxToWebmStream's own NodeWritableLike branch
  // deliberately never calls `.end()` itself (see toSequentialOnData's own
  // doc: a Node destination's lifecycle remains the caller's
  // responsibility), so this function calls it explicitly below, exactly
  // mirroring how a real fs.createWriteStream-backed
  // renderCompositionHeadlessServer caller already manages its own
  // destination's lifecycle end to end.
  const nodeDestination: NodeWritableLike = options.destination;
  const chunksGenerator = toAsyncGenerator(flatChunks);
  const audio = options.audio !== undefined ? toMuxAudioTrackOptions(options.audio) : undefined;

  if (options.format === "mp4") {
    await muxToMp4Stream(
      chunksGenerator,
      muxOptions,
      firstChunkCodec,
      nodeDestination,
      audio as MuxMp4AudioTrackOptions | undefined,
    );
  } else {
    await muxToWebmStream(
      chunksGenerator,
      muxOptions,
      firstChunkCodec,
      nodeDestination,
      audio as MuxWebmAudioTrackOptions | undefined,
    );
  }

  await new Promise<void>((resolve) => {
    options.destination.end(resolve);
  });
}

/** Shared by `submitEncodedRenderJob`/`resumeEncodedRenderJob`: bundles the entry script once, builds the `RenderRangeFn`, and wires the final mux pass onto whichever `@cadra/headless` job handle `dispatch` produces. */
async function runEncodedRenderJob(
  options: SubmitEncodedRenderJobOptions,
  dispatch: (
    renderRange: (range: {
      rangeIndex: number;
      startFrame: number;
      endFrame: number;
    }) => Promise<SerializedEncodedChunk[]>,
    durationInFrames: number,
  ) => RenderJobHandle<SerializedEncodedChunk[]>,
): Promise<EncodedRenderJobHandle> {
  const composition = options.project.compositions.find(
    (candidate) => candidate.id === options.compositionId,
  );
  const durationInFrames = composition?.durationInFrames ?? 0;
  const launcher = options.browserLauncher ?? launchPlaywrightHeadlessBrowser;
  const bundleEntry = options.bundleEntry ?? bundleBrowserEntry;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RANGE_TIMEOUT_MS;
  const keyframeIntervalFrames = options.keyframeIntervalFrames ?? DEFAULT_KEYFRAME_INTERVAL_FRAMES;

  const entrySource = await bundleEntry({ entryFilePath: options.entryFilePath });
  // Computed once per job, not once per range/attempt: every range needs
  // the exact same entries (see buildTextRenderEntriesForProject's own
  // doc), mirroring entrySource itself being bundled once and reused.
  const textRenderEntries = await buildTextRenderEntriesForProject(options.project);
  const imageRenderEntries = await buildImageRenderEntriesForProject(
    options.project,
    options.fetchAssetBytes,
  );
  const modelRenderEntries = await buildModelRenderEntriesForProject(
    options.project,
    options.fetchAssetBytes,
  );
  const environmentRenderEntries = await buildEnvironmentRenderEntriesForProject(
    options.project,
    options.fetchAssetBytes,
  );
  const lutRenderEntries = await buildLutRenderEntriesForProject(
    options.project,
    options.fetchAssetBytes,
  );
  const videoAssetEntries = await buildVideoAssetEntriesForProject(
    options.project,
    options.fetchAssetBytes,
  );
  // Also computed once per job, not once per range: the mapping itself
  // (assetRef/inFrame/outFrame/playbackRate/outOfRangeBehavior) never
  // varies by frame range, only computeNeededVideoSamplesForRange's own
  // per-range resolveVideoSourceFrame arithmetic does - see that
  // function's own doc.
  const videoNodeMappings = collectVideoNodeMappingsForProject(options.project);

  // Kicked off alongside the video ranges below (not awaited here), since
  // whole-composition audio mixdown/encoding has no range to align against
  // and no dependency on any video range's own output - see
  // runAudioMixdownAttempt's own doc. A composition with no audio content
  // at all (resolveAudioMixdown's own segments empty) launches no browser
  // for this at all. Any failure here (including the browser task itself
  // rejecting, not just a single asset's own decode failure) degrades to
  // "no audio for this render" rather than failing the whole job: an audio
  // problem should never take down an otherwise-successful video render.
  const audioBitrate = options.audioBitrate ?? DEFAULT_AUDIO_BITRATE;
  const audioMixdownPromise: Promise<SerializedAudioMixdownResult | undefined> = (async () => {
    if (resolveAudioMixdown(options.project, options.compositionId).segments.length === 0) {
      return undefined;
    }
    const audioAssetEntries = await prepareAudioMixdownAssetEntries(
      options.project,
      options.compositionId,
      options.fetchAssetBytes,
    );
    try {
      return await runAudioMixdownAttempt(
        launcher,
        entrySource,
        {
          project: options.project,
          compositionId: options.compositionId,
          container: options.format,
          bitrate: audioBitrate,
          audioAssetEntries,
        },
        options.onLog,
        timeoutMs,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onLog?.({
        level: "error",
        message: `submitEncodedRenderJob: audio mixdown failed, rendering without audio instead (${message}).`,
      });
      return undefined;
    }
  })();

  const renderRange = (range: {
    rangeIndex: number;
    startFrame: number;
    endFrame: number;
  }): Promise<SerializedEncodedChunk[]> =>
    runOneRangeAttempt(
      launcher,
      entrySource,
      {
        project: options.project,
        compositionId: options.compositionId,
        seed: options.seed,
        bitrate: options.bitrate,
        keyframeIntervalFrames,
        textRenderEntries,
        imageRenderEntries,
        modelRenderEntries,
        environmentRenderEntries,
        lutRenderEntries,
        videoAssetEntries,
      },
      videoNodeMappings,
      range,
      options.onProgress,
      options.onLog,
      timeoutMs,
    );

  const handle = dispatch(renderRange, durationInFrames);

  const result = handle.result.then(
    async (segments) => {
      // Awaited here (not earlier): every video range and the audio
      // mixdown run fully concurrently regardless of which finishes first,
      // so this adds no extra latency the audio task's own duration wasn't
      // already going to cost regardless of when it's awaited.
      const audio = await audioMixdownPromise;
      return muxConcatenatedSegments(segments, {
        format: options.format,
        destination: options.destination,
        project: options.project,
        compositionId: options.compositionId,
        ...(audio !== undefined && { audio }),
      });
    },
    (error: unknown) => {
      // A permanently-failed range means no mux pass ever runs (per this
      // module's own "single final mux, only once every range succeeds"
      // design): re-thrown as-is (RenderJobFailedError, or whatever else
      // handle.result itself rejected with) so a caller's own error
      // handling/inspection (e.g. RenderJobFailedError.failedRanges) is
      // unaffected by this module's own extra mux-pass wrapping.
      if (error instanceof RenderJobFailedError) {
        throw error;
      }
      throw error instanceof Error ? error : new Error(String(error));
    },
  );

  return { jobId: handle.jobId, result };
}

/**
 * Submits a render job that splits `options.project`'s composition
 * `options.compositionId` into keyframe-interval-aligned frame ranges,
 * renders and encodes each one independently via its own headless browser
 * instance (`@cadra/headless`'s `submitRenderJob`, bounded by
 * `options.maxConcurrency`, each range retried up to
 * `options.maxAttemptsPerRange` times on its own), then, once every range
 * has succeeded, concatenates every range's ordered `EncodedChunkResult`s
 * and performs one single final mux pass into `options.destination`. See
 * this module's own top-level doc for the full design and equivalence
 * claims.
 *
 * Returns a promise (not a synchronous handle, unlike `@cadra/headless`'s
 * own `submitRenderJob`): this function has a genuine, unavoidable
 * asynchronous prerequisite before a real job/jobId can exist at all
 * (`options.bundleEntry`, esbuild bundling the browser-side entry script),
 * where `@cadra/headless`'s own core has none. `handle.jobId` is therefore
 * always a concrete, already-resolved string once this promise resolves,
 * with no "wait, is it ready yet" ambiguity for a caller to handle -
 * something a synchronous-but-sometimes-not-yet-valid handle would not
 * offer.
 *
 * Query progress via `getEncodedRenderJobStatus(handle.jobId)` (or
 * `options.onStatusChange`, which fires as soon as dispatch begins,
 * possibly before this promise itself resolves) while the job is running,
 * and await `handle.result` for final completion (including the final mux
 * pass, which only starts once the underlying `@cadra/headless` job status
 * is itself `"done"`).
 */
export async function submitEncodedRenderJob(
  options: SubmitEncodedRenderJobOptions,
): Promise<EncodedRenderJobHandle> {
  return runEncodedRenderJob(options, (renderRange, durationInFrames) =>
    submitHeadlessRenderJob<SerializedEncodedChunk[]>({
      project: options.project,
      compositionId: options.compositionId,
      durationInFrames,
      renderRange,
      rangeSizeFrames: options.rangeSizeFrames,
      rangeAlignmentFrames:
        options.rangeAlignmentFrames ??
        options.keyframeIntervalFrames ??
        DEFAULT_KEYFRAME_INTERVAL_FRAMES,
      maxConcurrency: options.maxConcurrency,
      maxAttemptsPerRange: options.maxAttemptsPerRange,
      onStatusChange: options.onStatusChange,
    }),
  );
}

/**
 * Resumes a previously-submitted encoded render job from a
 * `RenderJobStatusSnapshot`'s (or `getEncodedRenderJobStatus`'s) own
 * `ranges` array: every range already `"done"` is kept as-is (its segment
 * reused, never re-rendered), and every outstanding range is re-attempted,
 * exactly mirroring `@cadra/headless`'s own `resumeRenderJob` (see its doc
 * for the full resume contract). Once every range succeeds (whether reused
 * from `previousRanges` or freshly re-rendered here), the same single final
 * concatenate-and-mux pass runs as `submitEncodedRenderJob`'s own.
 *
 * `options` mirrors `SubmitEncodedRenderJobOptions` minus `rangeSizeFrames`/
 * `rangeAlignmentFrames` (ranges are already fixed by `previousRanges`, not
 * re-split), matching `@cadra/headless`'s own `resumeRenderJob` options
 * shape.
 */
export async function resumeEncodedRenderJob(
  previousRanges: ResumableRangeStates<SerializedEncodedChunk[]>,
  options: Omit<SubmitEncodedRenderJobOptions, "rangeSizeFrames" | "rangeAlignmentFrames">,
): Promise<EncodedRenderJobHandle> {
  return runEncodedRenderJob(options as SubmitEncodedRenderJobOptions, (renderRange) =>
    resumeHeadlessRenderJob<SerializedEncodedChunk[]>(previousRanges, {
      project: options.project,
      compositionId: options.compositionId,
      renderRange,
      maxConcurrency: options.maxConcurrency,
      maxAttemptsPerRange: options.maxAttemptsPerRange,
      onStatusChange: options.onStatusChange,
    }),
  );
}
