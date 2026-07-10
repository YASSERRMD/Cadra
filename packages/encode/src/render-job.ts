import { readFileSync } from "node:fs";

import type { Project, SceneNode, TextNode } from "@cadra/core";
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
import { computeTextNodeRenderKey } from "@cadra/renderer";
import { createFontRegistry, type PositionedGlyph, prepareTextRenderData } from "@cadra/text";

import type { EncodedChunkResult } from "./encode-frames.js";
import { DEFAULT_KEYFRAME_INTERVAL_FRAMES } from "./encode-frames.js";
import { muxToMp4Stream } from "./mux-mp4.js";
import type { NodeWritableLike } from "./mux-stream-target.js";
import { muxToWebmStream } from "./mux-webm.js";
import type { SerializedEncodedChunk } from "./serialized-encoded-chunk.js";
import { deserializeEncodedChunkResult } from "./serialized-encoded-chunk.js";

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
}

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

/**
 * Prepares a `SerializedTextRenderEntry` for every distinct `TextNode`
 * (deduped by `computeTextNodeRenderKey(node, 0)`, mirroring
 * `TextRenderRegistry`'s own resolve-by-key contract) found anywhere in
 * `project`'s own scene graph, across every composition/track/clip.
 *
 * Fixes the gap this package's own render path had: `createRenderer()`
 * (called from `browser-headless-render-entry.ts`, the actual entry
 * `submitEncodedRenderJob` bundles and runs per range) was never handed a
 * `TextRenderRegistry` at all, so every `TextNode` resolved to an empty,
 * glyph-less `THREE.Group()` (see `node-factory.ts`'s own `buildTextObject`)
 * - correctly reproducing the mesh/light/post-processing pipeline while
 * silently rendering zero text, with no thrown error anywhere in that
 * path. Font loading, HarfBuzz shaping, and MSDF atlas generation are all
 * Node-only-dependency-laden work (`fontkit`'s `Buffer` usage,
 * `msdfgen-wasm`'s `createRequire`, `subset-font`'s `fs`) that cannot run
 * inside the browser-bundled render page itself (see `@cadra/text/browser`'s
 * own module doc for why that package's browser-safe subset deliberately
 * omits `prepareTextRenderData`/`createFontRegistry`), so this runs here,
 * server-side, once per job (not once per range/attempt - every range
 * needs the exact same entries, mirroring how `entrySource` itself is
 * bundled once and reused), with the result carried into the page as
 * plain, `page.evaluate`-structured-clone-safe data.
 *
 * Every node currently uses this module's own bundled default font
 * regardless of whether it set its own `fontRef`: resolving `fontRef`
 * against a real, agent-uploaded font asset registry is a follow-up this
 * phase's scope does not cover (`create_scene`/`add_text_node`'s own
 * MCP-server callers have no such registry wired through to here yet
 * either), not something dropped by mistake.
 */
async function buildTextRenderEntriesForProject(
  project: Project,
): Promise<SerializedTextRenderEntry[]> {
  const textNodes: TextNode[] = [];
  for (const composition of project.compositions) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        collectTextNodes(clip.node, textNodes);
      }
    }
  }

  if (textNodes.length === 0) {
    return [];
  }

  const fontBytes = readFileSync(DEFAULT_FONT_PATH);
  const fontBytesArray = Array.from(fontBytes);
  // "opentype" (not "fontkit"): the only backend @cadra/text/browser's own
  // doc confirms works when bundled for a browser target, matching
  // createFontRegistry's own doc ("pass 'opentype' ... for registries that
  // must also work inside a browser-bundled render page"). Preparation
  // itself runs here in Node, but shaping must stay consistent with
  // whatever backend a browser-side re-shape would use, and there is none
  // here at all - "opentype" is simply the correct, only-supported choice.
  const fontRegistry = createFontRegistry("opentype");
  const font = await fontRegistry.registerBytes(fontBytes).ready;

  const entries = new Map<string, SerializedTextRenderEntry>();
  for (const node of textNodes) {
    const cacheKey = computeTextNodeRenderKey(node, 0);
    if (entries.has(cacheKey)) {
      continue;
    }

    // A 128px-per-em MSDF (vs the library's 42px default, tuned for
    // preview-sized text) keeps glyph edges crisp when a title fills a large
    // fraction of a 1080p+ frame: at the default, a full-width title
    // magnifies the atlas ~12x and its edges read visibly stair-stepped in
    // the encoded output. `range` stays at its default: the MSDF material's
    // alpha ramp is calibrated against that default, and a wider range
    // leaves a visible haze out to each glyph quad's own bounds.
    const data = await prepareTextRenderData(font, node.content, {
      atlasOptions: { fontSize: 128 },
    });
    entries.set(cacheKey, {
      cacheKey,
      data: {
        atlasPages: data.atlasPages.map((page) => ({
          width: page.width,
          height: page.height,
          pixels: Array.from(page.pixels),
          png: Array.from(page.png),
        })),
        glyphs: data.glyphs,
        lineCount: data.lineCount,
      },
      fontBytes: fontBytesArray,
      fontContentHash: font.contentHash,
    });
  }

  return Array.from(entries.values());
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
  baseConfig: Omit<BrowserRangeConfigArg, "startFrame" | "endFrame">,
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

    const config: BrowserRangeConfigArg = {
      ...baseConfig,
      startFrame: range.startFrame,
      endFrame: range.endFrame,
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

/**
 * Once every range has succeeded (`renderResult`), concatenates every
 * range's segment and performs the single final mux pass into
 * `destination`, then calls `destination.end()`.
 */
async function muxConcatenatedSegments(
  segments: readonly SerializedEncodedChunk[][],
  options: {
    format: "mp4" | "webm";
    destination: HeadlessServerFileWriteStreamLike;
    project: Project;
    compositionId: string;
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

  if (options.format === "mp4") {
    await muxToMp4Stream(chunksGenerator, muxOptions, firstChunkCodec, nodeDestination);
  } else {
    await muxToWebmStream(chunksGenerator, muxOptions, firstChunkCodec, nodeDestination);
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
      },
      range,
      options.onProgress,
      options.onLog,
      timeoutMs,
    );

  const handle = dispatch(renderRange, durationInFrames);

  const result = handle.result.then(
    (segments) =>
      muxConcatenatedSegments(segments, {
        format: options.format,
        destination: options.destination,
        project: options.project,
        compositionId: options.compositionId,
      }),
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
