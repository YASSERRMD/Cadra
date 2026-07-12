import type { Project } from "@cadra/core";
import {
  CompositionNotFoundForRenderError,
  type OnProgressFn,
  renderComposition,
} from "@cadra/headless";
import {
  createInMemoryTextRenderRegistry,
  createPixelReadableRenderer,
  createRenderer,
  type PixelBuffer,
  type TextRenderRegistry,
} from "@cadra/renderer";
import type { PositionedGlyph } from "@cadra/text/browser";

import { type CapturedVideoFrame, captureFrames } from "./capture-frames.js";
import { type EncodedChunkResult, encodeFrames } from "./encode-frames.js";
import { muxToMp4Stream } from "./mux-mp4.js";
import type { WebWritableStreamLike } from "./mux-stream-target.js";
import { muxToWebmStream } from "./mux-webm.js";
import type { SerializedEncodedChunk } from "./serialized-encoded-chunk.js";
import { serializeEncodedChunk } from "./serialized-encoded-chunk.js";

/**
 * This module is never imported by other TypeScript source in this
 * workspace: it is a browser-side entry point meant to be pointed at by
 * `@cadra/headless`'s `bundleBrowserEntry` (esbuild's `entryPoints`), then
 * injected wholesale into a headless-Chromium page via `addScriptTag`/
 * `HeadlessPageLike.addScript`. Everything it imports (`@cadra/core`,
 * `@cadra/headless`, `@cadra/renderer`, and this package's own
 * capture/encode/mux modules) gets inlined into one flat IIFE bundle with no
 * runtime `import` left over; see `bundleBrowserEntry`'s own doc for why the
 * bundling itself lives in `@cadra/headless` rather than here (avoiding a
 * circular `@cadra/headless` <-> `@cadra/encode` workspace dependency).
 *
 * Runs the full render pipeline end to end, entirely inside the page:
 * constructs a real `createRenderer()` (WebGPU-with-WebGL2-fallback, see
 * `createRenderer`'s own doc) plus a real `readPixels` (a canvas 2D
 * `drawImage` snapshot of the render target, then `getImageData`; see
 * `createRealReadPixels`'s own doc for why this specific technique), drives
 * `renderComposition` to walk every frame, pipes each one through
 * `captureFrames` -> `encodeFrames`, muxes the encoded chunks to MP4/WebM via
 * `muxToMp4Stream`/`muxToWebmStream`, and streams the result out through a
 * `WebWritableStreamLike` whose `write`/`close` calls a Node-side function
 * exposed via `window.__cadraHeadlessWrite`/`window.__cadraHeadlessClose`
 * (installed by `@cadra/headless`'s server orchestrator through
 * `page.exposeFunction` before this script runs; see
 * `render-composition-headless-server.ts`'s own doc for the full bridge
 * protocol this function's `window` globals are named after).
 *
 * Video-only for this phase: a composition's `audioTracks` are not yet
 * rendered/muxed on this path (see this package's own `renderAudioMixdown`/
 * `encodeAudio`, which this entry point does not call). Wiring those in is a
 * mechanical follow-up once a browser-side asset-fetching bridge for
 * `resolveAudioBuffer` exists; nothing about this function's shape
 * (`muxToMp4Stream`/`muxToWebmStream` already accept an optional audio
 * track argument) needs to change to add it later.
 */

/** Bridges a `WebWritableStreamLike` write/close pair to Node-exposed `window` functions. */
declare global {
  interface Window {
    /** Writes one chunk of the encoded output to the Node-side file/stream. Resolves once the Node side has accepted it. */
    __cadraHeadlessWrite?: (chunkBytes: number[]) => Promise<void>;
    /** Signals the encoded output is complete; the Node side finalizes (closes) its destination. */
    __cadraHeadlessClose?: () => Promise<void>;
    /** Reports one frame's progress back to the Node side, mirroring `OnProgressFn`'s shape. */
    __cadraHeadlessProgress?: (frame: number, totalFrames: number) => Promise<void>;
  }
}

/**
 * A `MsdfAtlasPage`, with its two `Uint8Array` fields (`pixels`/`png`)
 * widened to plain `number[]`: verified empirically (this module's own
 * `createBridgedWriteTarget` doc) that a raw `Uint8Array` does not survive
 * Playwright's structured-clone boundary as itself, so every binary field
 * crossing into this page via `page.evaluate`'s `arg` uses this same
 * defensive `number[]` encoding, reconstructed via `Uint8Array.from` once
 * inside the page (see `buildTextRenderRegistry` below).
 */
interface SerializedMsdfAtlasPage {
  width: number;
  height: number;
  pixels: number[];
  png: number[];
}

/** `TextRenderData` (`@cadra/text`'s own shape) with its atlas pages' binary fields serialized; see `SerializedMsdfAtlasPage`'s own doc. `glyphs`/`lineCount` are already plain data, needing no conversion. */
interface SerializedTextRenderData {
  atlasPages: readonly SerializedMsdfAtlasPage[];
  glyphs: readonly PositionedGlyph[];
  lineCount: number;
}

/**
 * One `TextRenderRegistry` entry (see that interface's own doc in
 * `@cadra/renderer`), prepared ahead of time on the Node side (font
 * loading, HarfBuzz shaping, and MSDF atlas generation are all
 * Node-only-dependency-laden work that cannot run inside this bundled
 * browser page - see `@cadra/text/browser`'s own module doc for why) and
 * carried across `page.evaluate`'s structured-clone boundary as plain,
 * serializable data.
 */
export interface SerializedTextRenderEntry {
  /** Matches `computeTextNodeRenderKey(node, 0)` for the `TextNode`(s) this entry serves. */
  cacheKey: string;
  data: SerializedTextRenderData;
  fontBytes: number[];
  fontContentHash: string;
}

/** Reconstructs a real, in-page `TextRenderRegistry` from `entries`, undoing `SerializedTextRenderEntry`'s own `Uint8Array` -> `number[]` encoding. */
function buildTextRenderRegistry(entries: readonly SerializedTextRenderEntry[]): TextRenderRegistry {
  const registry = createInMemoryTextRenderRegistry();

  for (const entry of entries) {
    registry.register(entry.cacheKey, {
      data: {
        atlasPages: entry.data.atlasPages.map((page) => ({
          width: page.width,
          height: page.height,
          pixels: Uint8Array.from(page.pixels),
          png: Uint8Array.from(page.png),
        })),
        glyphs: entry.data.glyphs,
        lineCount: entry.data.lineCount,
      },
      fontBytes: Uint8Array.from(entry.fontBytes),
      fontContentHash: entry.fontContentHash,
    });
  }

  return registry;
}

/** Config this entry function accepts, structured-cloned in from the Node orchestrator via `page.evaluate`. */
export interface BrowserHeadlessRenderConfig {
  /** The project to render, i.e. `renderComposition`'s own `options.project`. */
  project: Project;
  /** Which of `project`'s compositions to render. */
  compositionId: string;
  /** Base seed for every frame's `FrameContext`; see `renderComposition`'s own doc for why this is required. */
  seed: string | number;
  /** Output container: selects `muxToMp4Stream` or `muxToWebmStream`. */
  format: "mp4" | "webm";
  /** Target bitrate in bits per second for `encodeFrames`. */
  bitrate: number;
  /** Every `TextNode` render entry this project needs, prepared ahead of time on the Node side; see `SerializedTextRenderEntry`'s own doc. Omitted/empty means every text node renders as an empty placeholder, matching `createRenderer`'s own no-registry default. */
  textRenderEntries?: readonly SerializedTextRenderEntry[];
}

/**
 * Config `runBrowserHeadlessRenderRange` accepts: `BrowserHeadlessRenderConfig`
 * minus `format` (a range render never muxes; see that function's own doc),
 * plus the frame bounds to render.
 */
export interface BrowserHeadlessRenderRangeConfig {
  /** The project to render, i.e. `renderComposition`'s own `options.project`. */
  project: Project;
  /** Which of `project`'s compositions to render. */
  compositionId: string;
  /** Base seed for every frame's `FrameContext`; see `renderComposition`'s own doc for why this is required. */
  seed: string | number;
  /** Target bitrate in bits per second for `encodeFrames`. Must match every other range of the same job exactly (see `runBrowserHeadlessRenderRange`'s own doc for why). */
  bitrate: number;
  /** First frame (inclusive) of this range, i.e. `renderComposition`'s own `startFrame`. */
  startFrame: number;
  /** Frame index one past the last frame (exclusive) of this range, i.e. `renderComposition`'s own `endFrame`. */
  endFrame: number;
  /**
   * Force a keyframe every this many frames (and always at frame 0),
   * passed through to `encodeFrames`. Defaults to
   * `DEFAULT_KEYFRAME_INTERVAL_FRAMES` when omitted, matching
   * `encodeFrames`'s own default exactly. Must match every other range of
   * the same job (and the value the job's own range-splitting was aligned
   * to): `encodeFrames`'s `isKeyframeDue` check uses each frame's absolute
   * index, so every range must agree on the same interval for its own
   * `startFrame` to reliably land on a forced keyframe.
   */
  keyframeIntervalFrames?: number;
  /** Every `TextNode` render entry this project needs, prepared ahead of time on the Node side; see `SerializedTextRenderEntry`'s own doc. Omitted/empty means every text node renders as an empty placeholder, matching `createRenderer`'s own no-registry default. */
  textRenderEntries?: readonly SerializedTextRenderEntry[];
}

/**
 * Real `ReadPixelsFn` for the headless-server render path: draws `target`
 * (the render canvas WebGL2/WebGPU just drew into) onto a fresh, same-sized
 * 2D canvas via `drawImage`, then reads that back with `getImageData`.
 *
 * This indirect snapshot (rather than reading the WebGL2/WebGPU context's
 * own pixels directly, e.g. `gl.readPixels`) is deliberately backend-
 * agnostic: `createRenderer()` can hand back either a WebGPU or a WebGL2
 * `RenderTarget`, and a raw `gl.readPixels`-based implementation would need
 * to branch on which backend actually initialized (and WebGPU's own
 * readback path, `GPUBuffer` mapping, is asynchronous and copy-based in a
 * way that does not unify cleanly with WebGL2's synchronous
 * `readPixels`). A 2D-context `drawImage` snapshot works identically
 * regardless of what drew into the source canvas, since every canvas
 * (WebGL2, WebGPU, or 2D) can always be the source of a `drawImage` call.
 * `getImageData` returns top-left-origin RGBA8 already, exactly matching
 * `PixelBuffer`'s own documented layout, so no row-flip or channel
 * reordering is needed either.
 *
 * `willReadFrequently: true` hints the browser to back the snapshot canvas
 * with a CPU-backed 2D context rather than GPU-backed, since every single
 * frame of a render calls `getImageData` on it (the exact repeated-readback
 * pattern that hint exists for), avoiding a GPU-to-CPU sync stall on every
 * frame that a default GPU-backed 2D context would otherwise incur.
 *
 * Exported (not just called locally) so this exact function is directly
 * reachable off the bundled entry's `window[BROWSER_ENTRY_GLOBAL_NAME]` for
 * this module's own regression test, which feeds it synthetic frames
 * directly rather than driving a full render/encode/mux pass.
 */
export function createRealReadPixels(): (
  target: HTMLCanvasElement | OffscreenCanvas,
  size: { width: number; height: number },
) => Promise<PixelBuffer> {
  let snapshotCanvas: HTMLCanvasElement | undefined;
  let snapshotContext: CanvasRenderingContext2D | undefined;

  return async (target, size) => {
    if (snapshotCanvas === undefined || snapshotContext === undefined) {
      snapshotCanvas = document.createElement("canvas");
      const context = snapshotCanvas.getContext("2d", { willReadFrequently: true });
      if (context === null) {
        throw new Error("createRealReadPixels: failed to acquire a 2D rendering context.");
      }
      snapshotContext = context;
    }

    if (snapshotCanvas.width !== size.width || snapshotCanvas.height !== size.height) {
      snapshotCanvas.width = size.width;
      snapshotCanvas.height = size.height;
    }

    // The snapshot canvas is reused across every frame of a render (only
    // resized, never recreated), and a resize to the *same* size (the
    // common case once past frame 0) leaves its old pixel content in
    // place. `target` itself is not guaranteed fully opaque (a WebGL/WebGPU
    // render target commonly clears to transparent, with only actual
    // geometry opaque), so an uncleared `drawImage` composites each new
    // frame's transparent regions over the *previous* frame's opaque
    // pixels instead of replacing them, accumulating stale geometry frame
    // over frame. Clearing first guarantees this frame's readback reflects
    // only `target`'s own current content.
    snapshotContext.clearRect(0, 0, size.width, size.height);
    // `target` is `HTMLCanvasElement | OffscreenCanvas`; both are valid
    // CanvasImageSource drawImage() arguments.
    snapshotContext.drawImage(target as CanvasImageSource, 0, 0);
    const imageData = snapshotContext.getImageData(0, 0, size.width, size.height);
    return { width: size.width, height: size.height, data: imageData.data };
  };
}

/** Builds a `WebWritableStreamLike` whose writer bridges every `write`/`close` call to the exposed Node-side `window` functions. */
function createBridgedWriteTarget(): WebWritableStreamLike {
  return {
    getWriter() {
      return {
        async write(chunk: Uint8Array): Promise<void> {
          const write = window.__cadraHeadlessWrite;
          if (write === undefined) {
            throw new Error(
              "browser-headless-render-entry: window.__cadraHeadlessWrite was not exposed before this script ran.",
            );
          }
          // exposeFunction's arguments are structured-clone/JSON-serialized
          // across the page<->Node boundary: a Uint8Array does not survive
          // that round trip as itself (Playwright's own exposeFunction
          // serializes it to an object with numeric string keys, not a real
          // array-like the Node side can trivially reconstruct), so it is
          // converted to a plain number[] here, which does survive
          // intact and reconstructs on the Node side via `Uint8Array.from`.
          await write(Array.from(chunk));
        },
        async close(): Promise<void> {
          const close = window.__cadraHeadlessClose;
          if (close === undefined) {
            throw new Error(
              "browser-headless-render-entry: window.__cadraHeadlessClose was not exposed before this script ran.",
            );
          }
          await close();
        },
      };
    },
  };
}

/** Adapts `window.__cadraHeadlessProgress` (exposed by the Node orchestrator) into a plain `OnProgressFn`, matching `renderComposition`'s own callback shape. */
function createBridgedOnProgress(): OnProgressFn {
  return (frame, totalFrames) => {
    // Fire-and-forget: renderComposition's own OnProgressFn is synchronous
    // (see its doc), so this cannot await the exposed function's promise
    // without changing renderComposition's contract. A dropped/delayed
    // progress notification is an acceptable loss (this is purely a
    // caller-visible progress signal, not something the render's
    // correctness depends on); any rejection is swallowed rather than
    // becoming an unhandled rejection.
    void window.__cadraHeadlessProgress?.(frame, totalFrames)?.catch(() => {});
  };
}

/**
 * Shared by `runBrowserHeadlessRender`/`runBrowserHeadlessRenderRange`:
 * looks up `compositionId` in `project`, constructs a real
 * `createRenderer()`/`readPixels` pipeline sized to that composition, and
 * returns the composition itself plus the `encodeFrames` output for
 * `[startFrame, endFrame)` (defaulting to the composition's own full `[0,
 * durationInFrames)` when omitted, matching `renderComposition`'s own
 * defaults exactly), using `keyframeIntervalFrames` if given (otherwise
 * `encodeFrames`'s own default, `DEFAULT_KEYFRAME_INTERVAL_FRAMES`).
 *
 * @throws {CompositionNotFoundForRenderError} if `compositionId` does not
 *   exist in `project`.
 */
function buildEncodedChunksForRange(
  project: Project,
  compositionId: string,
  seed: string | number,
  bitrate: number,
  range: { startFrame?: number; endFrame?: number; keyframeIntervalFrames?: number } = {},
  textRenderEntries: readonly SerializedTextRenderEntry[] = [],
): {
  composition: { width: number; height: number; fps: number };
  encodedChunks: AsyncGenerator<EncodedChunkResult>;
} {
  const foundComposition = project.compositions.find((candidate) => candidate.id === compositionId);
  if (foundComposition === undefined) {
    throw new CompositionNotFoundForRenderError(compositionId);
  }
  // Re-bound to a fresh `const`: TypeScript's control-flow narrowing of
  // `foundComposition !== undefined` above does not flow into the nested
  // `encodedChunksGenerator` function declaration below (a function
  // declaration is conservatively treated as possibly running after
  // `foundComposition` could have been reassigned, even though it is itself
  // a `const` that provably never is). `composition` here is that same
  // already-narrowed value, just visible to the closure without re-raising
  // the "possibly undefined" error.
  const composition = foundComposition;

  const canvas = document.createElement("canvas");
  canvas.width = composition.width;
  canvas.height = composition.height;

  const innerRenderer = createRenderer({ textRenderRegistry: buildTextRenderRegistry(textRenderEntries) });
  const renderer = createPixelReadableRenderer({
    renderer: innerRenderer,
    readPixels: createRealReadPixels(),
  });

  // `init` cannot be awaited here (this function is intentionally
  // synchronous up to its returned generator: the generator itself performs
  // every asynchronous step, including `init`, lazily on first pull) without
  // either making this function `async` (which would then require every
  // caller to unwrap a further outer promise around the returned generator
  // itself, an awkward "a promise of a generator" shape) or eagerly starting
  // the render before a caller has had a chance to attach `onProgress`/error
  // handling. Instead, `init` is awaited as the generator's own first
  // action, which every consumer already awaits naturally via `for await`/
  // `.next()`.
  async function* encodedChunksGenerator(): AsyncGenerator<EncodedChunkResult> {
    await renderer.init(canvas, { width: composition.width, height: composition.height });

    const renderedFrames = renderComposition({
      project,
      compositionId,
      renderer,
      seed,
      startFrame: range.startFrame,
      endFrame: range.endFrame,
      onProgress: createBridgedOnProgress(),
    });

    const capturedFrames = captureFrames(renderedFrames, { fps: composition.fps });

    // encodeFrames only accepts the CapturedVideoFrame case (see its own
    // doc): this page always has WebCodecs available (real Chromium, not a
    // WebCodecs-less test double), so captureFrames always yields that case
    // here, never the CapturedPixelBuffer fallback.
    const videoFrames = capturedFrames as AsyncGenerator<CapturedVideoFrame>;
    yield* encodeFrames(videoFrames, {
      width: composition.width,
      height: composition.height,
      bitrate,
      framerate: composition.fps,
      keyframeIntervalFrames: range.keyframeIntervalFrames,
    });
  }

  return { composition, encodedChunks: encodedChunksGenerator() };
}

/**
 * Entry function this module's default export is: called via
 * `page.evaluate(runBrowserHeadlessRender, config)` (structured-cloning
 * `config` in), it runs the full render/encode/mux pipeline and resolves
 * once every byte has been written and the destination closed.
 *
 * Rejects with a real `Error` (not a plain structured-clonable object) if
 * anything in the pipeline throws: verified directly against a real
 * Playwright `page.evaluate` call while building this phase that
 * Playwright's own rejection wrapping only preserves the original thrown
 * value's message text when that value is a genuine `Error` instance (its
 * wrapped message becomes `"page.evaluate: Error: <original message>"`); a
 * plain object thrown instead (e.g. `{ message: "..." }`, this function's
 * original design) is flattened to the unhelpful literal string
 * `"page.evaluate: Object"` on the Node side, silently losing the real
 * error entirely. `page.evaluate`'s structured-clone requirement applies to
 * its *resolved* return value, not to why a *rejected* promise's underlying
 * cause is or is not preserved; those are two different Playwright code
 * paths with two different fidelity guarantees, and only the `Error` one
 * is fit for this function's error-surfacing purpose.
 */
export async function runBrowserHeadlessRender(config: BrowserHeadlessRenderConfig): Promise<void> {
  try {
    const { composition, encodedChunks } = buildEncodedChunksForRange(
      config.project,
      config.compositionId,
      config.seed,
      config.bitrate,
      {},
      config.textRenderEntries,
    );

    const destination = createBridgedWriteTarget();
    const muxOptions = {
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
    };

    if (config.format === "mp4") {
      await muxToMp4StreamWithFirstChunkCodec(encodedChunks, muxOptions, destination);
    } else {
      await muxToWebmStreamWithFirstChunkCodec(encodedChunks, muxOptions, destination);
    }
  } catch (error) {
    // Re-thrown as a real Error unconditionally (even when `error` already
    // is one): see this function's own doc for why only a genuine Error
    // instance's message text survives Playwright's page.evaluate rejection
    // wrapping intact.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message);
  }
}

/**
 * Phase 25's per-range entry function: renders and encodes exactly one
 * frame range (`[config.startFrame, config.endFrame)`) of `config.project`'s
 * composition, entirely inside this page, and returns the resulting
 * `EncodedChunkResult`s as an ordered array of structured-clone-safe
 * `SerializedEncodedChunk`s (see that module's own doc for why a live
 * `EncodedVideoChunk` cannot itself cross the `page.evaluate` return-value
 * boundary), rather than muxing/streaming anything: concatenation across
 * every range of a job and the single final mux pass both happen back on
 * the Node side, once every range's own segment has been collected (see
 * `@cadra/headless`'s `render-job-orchestrator.ts`'s own doc for the full
 * job-level design, and this package's own `render-job.ts` for the Node-side
 * wiring that calls this function once per range/attempt).
 *
 * Uses the exact same `createRenderer()`/`captureFrames`/`encodeFrames`
 * pipeline as `runBrowserHeadlessRender` (via the shared
 * `buildEncodedChunksForRange` helper), just bounded to `[startFrame,
 * endFrame)` via `renderComposition`'s own new sub-range support: this is
 * what makes a range's rendered pixels identical to what a full sequential
 * render would have produced at those same frame indices (see
 * `renderComposition`'s own doc), and, since `encodeFrames`'s own
 * `isKeyframeDue` check uses each frame's absolute index, a range whose
 * `startFrame` is a multiple of `keyframeIntervalFrames` always opens with a
 * forced keyframe, exactly as it would have within a single continuous
 * encode of the whole composition.
 *
 * `config.bitrate` (and, implicitly, the resolution/framerate carried by
 * `config.project`'s own composition) must be identical across every range
 * of the same job: `encodeFrames`' own codec probing
 * (`probeSupportedCodec`) always resolves the same codec choice given the
 * same `width`/`height`/`bitrate`/`framerate`/`codecPreferences` target in
 * the same browser/environment, so every range's own fresh `VideoEncoder`
 * lands on the same codec family, keeping every range's keyframes mutually
 * compatible once concatenated into a single stream and muxed once (see
 * this package's own `render-job.ts` module doc for the full equivalence
 * argument, including what is and is not guaranteed to be byte-identical
 * across independently-constructed encoders).
 *
 * Rejects with a real `Error`, mirroring `runBrowserHeadlessRender`'s own
 * rationale for why (see its doc).
 */
export async function runBrowserHeadlessRenderRange(
  config: BrowserHeadlessRenderRangeConfig,
): Promise<SerializedEncodedChunk[]> {
  try {
    const { encodedChunks } = buildEncodedChunksForRange(
      config.project,
      config.compositionId,
      config.seed,
      config.bitrate,
      {
        startFrame: config.startFrame,
        endFrame: config.endFrame,
        keyframeIntervalFrames: config.keyframeIntervalFrames,
      },
      config.textRenderEntries,
    );

    const serialized: SerializedEncodedChunk[] = [];
    for await (const chunkResult of encodedChunks) {
      serialized.push(serializeEncodedChunk(chunkResult));
    }
    return serialized;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message);
  }
}

/**
 * `muxToMp4Stream`'s third positional argument (`firstChunkCodec`) must come
 * from the actual first encoded chunk's own `metadata.decoderConfig.codec`
 * (see `mux-mp4.ts`'s own doc), which is only known once encoding has
 * already produced at least one chunk. This wraps `encodedChunks` in a
 * single-item lookahead so that first codec string can be read without
 * consuming (and thus losing) that first chunk from the stream `muxToMp4Stream`
 * itself needs to consume in full.
 */
async function muxToMp4StreamWithFirstChunkCodec(
  encodedChunks: AsyncGenerator<import("./encode-frames.js").EncodedChunkResult>,
  options: import("./mux-mp4.js").MuxMp4Options,
  destination: WebWritableStreamLike,
): Promise<void> {
  const rewound = await rewindWithFirstChunkCodec(encodedChunks);
  await muxToMp4Stream(rewound.stream, options, rewound.codec, destination);
}

/** Same lookahead technique as `muxToMp4StreamWithFirstChunkCodec`, for the WebM path. */
async function muxToWebmStreamWithFirstChunkCodec(
  encodedChunks: AsyncGenerator<import("./encode-frames.js").EncodedChunkResult>,
  options: import("./mux-webm.js").MuxWebmOptions,
  destination: WebWritableStreamLike,
): Promise<void> {
  const rewound = await rewindWithFirstChunkCodec(encodedChunks);
  await muxToWebmStream(rewound.stream, options, rewound.codec, destination);
}

/**
 * Pulls exactly one chunk from `chunks` to read its codec string, then
 * returns a new `AsyncGenerator` that yields that same chunk back first,
 * followed by every remaining chunk from the original `chunks` generator
 * unchanged: from a consumer's perspective, nothing was ever removed from
 * the stream, only peeked at.
 *
 * A composition with zero frames (`durationInFrames: 0`) produces zero
 * encoded chunks; `codec` falls back to an arbitrary-but-valid H.264 string
 * in that case purely so `toMp4VideoCodec`/`toWebmVideoCodec` (both of which
 * require a non-empty codec string) do not throw for a legitimately empty
 * render, matching how `muxToMp4Buffer`/`muxToWebmBuffer`'s own test suites
 * handle the zero-chunk case elsewhere in this package.
 */
async function rewindWithFirstChunkCodec(
  chunks: AsyncGenerator<import("./encode-frames.js").EncodedChunkResult>,
): Promise<{
  stream: AsyncGenerator<import("./encode-frames.js").EncodedChunkResult>;
  codec: string;
}> {
  const first = await chunks.next();

  if (first.done === true) {
    async function* empty(): AsyncGenerator<import("./encode-frames.js").EncodedChunkResult> {
      // Deliberately empty: the original stream was already exhausted with
      // zero chunks.
    }
    return { stream: empty(), codec: "avc1.42001f" };
  }

  const firstChunk = first.value;
  const codec = firstChunk.metadata?.decoderConfig?.codec ?? "avc1.42001f";

  async function* rewound(): AsyncGenerator<import("./encode-frames.js").EncodedChunkResult> {
    yield firstChunk;
    yield* chunks;
  }

  return { stream: rewound(), codec };
}
