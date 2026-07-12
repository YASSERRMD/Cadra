import type { Project } from "@cadra/core";
import { resolveAudioMixdown } from "@cadra/core";
import {
  CompositionNotFoundForRenderError,
  type OnProgressFn,
  renderComposition,
} from "@cadra/headless";
import {
  computeVideoFrameCacheKey,
  createImageTexture,
  createInMemoryTextRenderRegistry,
  createInMemoryTextureRegistry,
  createInMemoryVideoFrameRegistry,
  createPixelReadableRenderer,
  createRenderer,
  type DecodeVideo,
  type PixelBuffer,
  type SampleAtTimestamp,
  sampleVideoFrame,
  type TextRenderRegistry,
  type TextureRegistry,
  type VideoFrameRegistry,
  type VideoSource,
} from "@cadra/renderer";
import type { PositionedGlyph } from "@cadra/text/browser";

import { type CapturedVideoFrame, captureFrames } from "./capture-frames.js";
import { encodeAudio, type EncodeAudioOptions, type EncodedAudioChunkResult } from "./encode-audio.js";
import { type EncodedChunkResult, encodeFrames } from "./encode-frames.js";
import { muxToMp4Stream } from "./mux-mp4.js";
import type { WebWritableStreamLike } from "./mux-stream-target.js";
import { muxToWebmStream } from "./mux-webm.js";
import type { AudioBufferLike } from "./offline-audio-context-like.js";
import { renderAudioMixdown } from "./render-audio-mixdown.js";
import type { SerializedEncodedAudioChunk, SerializedEncodedChunk } from "./serialized-encoded-chunk.js";
import { serializeEncodedAudioChunk, serializeEncodedChunk } from "./serialized-encoded-chunk.js";

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
 * Video-only itself: this function's own `muxToMp4Stream`/`muxToWebmStream`
 * calls never pass an `audio` argument, so a composition's `audioTracks`
 * never reach the file this function alone produces. This is not the same
 * as "this module renders no audio at all" - see this file's own
 * `runBrowserHeadlessAudioMixdown` below, a separate, standalone entry
 * point `render-job.ts` invokes in its own dedicated browser page,
 * independent of (and possibly concurrent with) every range's own call to
 * `runBrowserHeadlessRenderRange`; its own encoded result is what the
 * Node-side final mux pass (`render-job.ts`'s own `muxConcatenatedSegments`)
 * actually threads into `muxToMp4Stream`/`muxToWebmStream`'s optional
 * `audio` argument. `runBrowserHeadlessRender` (this function) has no
 * per-range/whole-composition split to reconcile audio against in the
 * first place (unlike the range-parallel job path), so wiring audio into
 * it directly instead remains exactly the "mechanical follow-up" this
 * comment used to describe, if a caller of this specific function ever
 * needs it - `render_scene`/`probe_render` (this codebase's own real
 * callers) do not, since they only ever go through the range-parallel
 * `submitEncodedRenderJob` path instead.
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

/**
 * One `TextureRegistry` entry for an `ImageNode.assetRef` (see that
 * interface's own doc in `@cadra/renderer`): the asset's raw, still-encoded
 * bytes (PNG/JPEG/etc, whatever was actually uploaded), fetched ahead of
 * time on the Node side (`@cadra/encode`'s own `render-job.ts`, via
 * `SubmitEncodedRenderJobOptions.fetchAssetBytes`) and carried across
 * `page.evaluate`'s structured-clone boundary as plain, serializable data -
 * mirroring `SerializedTextRenderEntry`'s own purpose, one step simpler:
 * decoding itself happens here, in the page (`buildTextureRegistry` below),
 * not ahead of time, since (unlike font shaping/MSDF atlas generation) a
 * real browser's own `createImageBitmap` is the *only* correct decoder for
 * "whatever arbitrary image format an agent might upload," and that
 * decoder does not exist outside a real browser page.
 */
export interface SerializedImageRenderEntry {
  /** The `ImageNode.assetRef` this entry serves. */
  assetRef: string;
  /** The asset's raw, still-encoded bytes. */
  bytes: number[];
}

/**
 * Reconstructs a real, in-page `TextureRegistry` from `entries`: decodes
 * each one's raw bytes via a real browser `createImageBitmap` (a real
 * Chromium page's own decoder, so this covers PNG/JPEG/WebP/GIF alike, no
 * per-format branching needed here), then wraps the result as a
 * `THREE.Texture` via `@cadra/renderer`'s own `createImageTexture`.
 *
 * One entry failing to decode (corrupt bytes, or a format this browser's
 * own `createImageBitmap` does not support) is caught and logged via
 * `console.error` - which still surfaces to the Node side through
 * `runOneRangeAttempt`'s own `page.onConsoleMessage`/`onLog` relay - rather
 * than rejecting this function or the render job as a whole: that one
 * `ImageNode` simply falls through to the renderer's own documented gray
 * placeholder instead, matching `TextureRegistry.resolve`'s own "unresolved
 * is an expected runtime state, not a programming error" contract.
 */
async function buildTextureRegistry(
  entries: readonly SerializedImageRenderEntry[],
): Promise<TextureRegistry> {
  const registry = createInMemoryTextureRegistry();

  await Promise.all(
    entries.map(async (entry) => {
      try {
        const blob = new Blob([Uint8Array.from(entry.bytes)]);
        const bitmap = await createImageBitmap(blob);
        registry.register(entry.assetRef, createImageTexture(bitmap));
      } catch (error) {
        console.error(`Failed to decode image asset "${entry.assetRef}":`, error);
      }
    }),
  );

  return registry;
}

/**
 * One `VideoNode.assetRef` this project needs, fetched ahead of time on the
 * Node side (`@cadra/encode`'s own `render-job.ts`, via the same
 * `fetchAssetBytes` seam `SerializedImageRenderEntry` already uses) and
 * carried across `page.evaluate`'s structured-clone boundary as plain,
 * serializable data - mirroring `SerializedImageRenderEntry`'s own purpose
 * exactly: real decoding (`createRealDecodeVideo` below) happens here, in
 * the page, not ahead of time, for the same "a real browser's own decoder is
 * the only correct one for an arbitrary uploaded format" reason images
 * already establish.
 */
export interface SerializedVideoAssetEntry {
  /** The `VideoNode.assetRef` this entry serves. */
  assetRef: string;
  /** The asset's raw, still-encoded bytes. */
  bytes: number[];
}

/**
 * One `(assetRef, sourceFrame)` pair this range's own `[startFrame,
 * endFrame)` actually needs a decoded frame for, precomputed on the Node
 * side (`render-job.ts`'s own `computeNeededVideoSamplesForRange`, via
 * `resolveVideoSourceFrame` over every `VideoNode` found in the project's
 * scene graph) rather than recomputed here: every `VideoNode` field
 * `resolveVideoSourceFrame` reads (`inFrame`/`outFrame`/`playbackRate`/
 * `outOfRangeBehavior`) is a plain, non-keyframeable value (see
 * `VideoNode`'s own doc), so this arithmetic never depends on anything only
 * a full scene resolve could provide, and doing it once, Node-side, avoids
 * every one of a job's parallel range pages needing its own copy of the
 * project-wide scene-graph-walk logic `collectVideoNodes` already is.
 */
export interface VideoSampleRequest {
  /** The `VideoNode.assetRef` this request samples. */
  assetRef: string;
  /** The exact source-video-local frame to sample, i.e. `resolveVideoSourceFrame`'s own return value for some composition-absolute frame in this range. */
  sourceFrame: number;
}

/**
 * Real, in-page `DecodeVideo`: wraps `bytes` in a `Blob`/object URL and
 * loads it into a real `HTMLVideoElement`, resolving once `loadeddata`
 * fires - unlike `loadedmetadata` (duration/dimensions known, but no
 * guarantee a frame is actually decoded/paintable yet), `loadeddata`
 * specifically guarantees the element's very first frame is available,
 * which `createRealSampleAtTimestamp`'s own "already at this timestamp,
 * skip the seek" fast path (below) depends on being true immediately after
 * this resolves for the common `sourceFrame: 0` case.
 */
function createRealDecodeVideo(): DecodeVideo {
  return (bytes) =>
    new Promise<VideoSource>((resolve, reject) => {
      // Uint8Array.from(bytes), not bytes directly: bytes's own declared
      // type (DecodeVideo's own signature) is generic over its backing
      // buffer (Uint8Array<ArrayBufferLike>), which BlobPart's stricter
      // Uint8Array<ArrayBuffer> does not accept - the same normalization
      // buildTextureRegistry's own Blob construction already needs, for
      // the same reason (see its own call site).
      const blob = new Blob([Uint8Array.from(bytes)]);
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";

      const onLoaded = (): void => {
        video.removeEventListener("error", onError);
        resolve(video);
      };
      const onError = (): void => {
        video.removeEventListener("loadeddata", onLoaded);
        reject(video.error instanceof Error ? video.error : new Error("video decode failed to load"));
      };
      video.addEventListener("loadeddata", onLoaded, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.src = URL.createObjectURL(blob);
    });
}

/**
 * Real, in-page `SampleAtTimestamp`: seeks `source` (an `HTMLVideoElement`,
 * see `createRealDecodeVideo`) to `timestamp` and captures the resulting
 * frame via `createImageBitmap`.
 *
 * Skips the seek (and its `seeked` event wait) entirely when `source` is
 * already sitting at `timestamp` (within a small epsilon): a fresh element
 * starts at `currentTime === 0`, so requesting `timestamp === 0` (the
 * common first sample of any asset) would otherwise assign `.currentTime`
 * to the value it already holds - a no-op the spec does not guarantee fires
 * `seeked` at all, which would hang this function forever.
 */
function createRealSampleAtTimestamp(): SampleAtTimestamp {
  return async (source, timestamp) => {
    const video = source as HTMLVideoElement;

    if (Math.abs(video.currentTime - timestamp) > 1e-4) {
      await new Promise<void>((resolve, reject) => {
        const onSeeked = (): void => {
          video.removeEventListener("error", onError);
          resolve();
        };
        const onError = (): void => {
          video.removeEventListener("seeked", onSeeked);
          reject(video.error instanceof Error ? video.error : new Error(`video seek to ${timestamp}s failed`));
        };
        video.addEventListener("seeked", onSeeked, { once: true });
        video.addEventListener("error", onError, { once: true });
        video.currentTime = timestamp;
      });
    }

    return createImageBitmap(video);
  };
}

/**
 * Reconstructs a real, in-page `VideoFrameRegistry` from `entries`
 * (`SerializedVideoAssetEntry`'s own raw bytes per distinct `assetRef`) and
 * `samplesNeeded` (the exact `(assetRef, sourceFrame)` pairs this range's
 * own frames actually resolve to, see `VideoSampleRequest`'s own doc):
 * decodes each distinct `assetRef` exactly once via `createRealDecodeVideo`,
 * then samples every one of its own needed source frames sequentially
 * against that one shared `HTMLVideoElement` (a single element only has one
 * `currentTime` at a time - sampling the same asset's own distinct frames
 * concurrently would race each other's own seeks), while distinct assets
 * still decode and sample fully in parallel.
 *
 * `fps` is the composition's own frame rate, not any notion of a source
 * video's own encoded frame rate: `resolveVideoSourceFrame` (which produced
 * every `sourceFrame` this function samples) has no fps parameter at all,
 * meaning every `sourceFrame` it returns is already expressed in the same
 * fps space as the composition-absolute frame that produced it - see
 * `resolveVideoSourceFrame`'s own doc in `@cadra/core`.
 *
 * One asset failing to decode, or one sample failing (corrupt bytes, a
 * format this browser's own `HTMLVideoElement` does not support, or a seek
 * past a corrupt region), is caught and logged via `console.error` rather
 * than rejecting this function or the render as a whole - mirroring
 * `buildTextureRegistry`'s own per-asset resilience exactly: that one
 * `VideoNode` (at that one frame) falls through to the renderer's own
 * documented placeholder instead of failing an otherwise-successful render.
 */
async function buildVideoFrameRegistry(
  entries: readonly SerializedVideoAssetEntry[],
  samplesNeeded: readonly VideoSampleRequest[],
  fps: number,
): Promise<VideoFrameRegistry> {
  const registry = createInMemoryVideoFrameRegistry();
  if (samplesNeeded.length === 0) {
    return registry;
  }

  const decodeVideo = createRealDecodeVideo();
  const sampleAtTimestamp = createRealSampleAtTimestamp();

  const sourcesByAssetRef = new Map<string, VideoSource>();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const source = await decodeVideo(Uint8Array.from(entry.bytes));
        sourcesByAssetRef.set(entry.assetRef, source);
      } catch (error) {
        console.error(`Failed to decode video asset "${entry.assetRef}":`, error);
      }
    }),
  );

  const sourceFramesByAssetRef = new Map<string, Set<number>>();
  for (const request of samplesNeeded) {
    const sourceFrames = sourceFramesByAssetRef.get(request.assetRef) ?? new Set<number>();
    sourceFrames.add(request.sourceFrame);
    sourceFramesByAssetRef.set(request.assetRef, sourceFrames);
  }

  await Promise.all(
    Array.from(sourceFramesByAssetRef.entries()).map(async ([assetRef, sourceFrames]) => {
      const source = sourcesByAssetRef.get(assetRef);
      if (source === undefined) {
        return;
      }
      for (const sourceFrame of sourceFrames) {
        try {
          const image = await sampleVideoFrame(source, sourceFrame, fps, { sampleAtTimestamp });
          registry.register(computeVideoFrameCacheKey(assetRef, sourceFrame), { image });
        } catch (error) {
          console.error(
            `Failed to sample video asset "${assetRef}" at source frame ${sourceFrame}:`,
            error,
          );
        }
      }
    }),
  );

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
  /** Every `ImageNode` asset this project needs, fetched ahead of time on the Node side; see `SerializedImageRenderEntry`'s own doc. Omitted/empty means every image node renders as the documented gray placeholder, matching `createRenderer`'s own no-registry default. */
  imageRenderEntries?: readonly SerializedImageRenderEntry[];
  /** Every `VideoNode` asset this project needs, fetched ahead of time on the Node side; see `SerializedVideoAssetEntry`'s own doc. Omitted/empty means every video node renders as the documented placeholder, matching `createRenderer`'s own no-registry default. */
  videoAssetEntries?: readonly SerializedVideoAssetEntry[];
  /** Every `(assetRef, sourceFrame)` pair this render's own frames actually need a decoded video frame for; see `VideoSampleRequest`'s own doc. Omitted/empty means no video frame is ever sampled (every video node renders as the documented placeholder for the whole render), independent of whether `videoAssetEntries` itself is populated. */
  videoSamplesNeeded?: readonly VideoSampleRequest[];
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
  /** Every `ImageNode` asset this project needs, fetched ahead of time on the Node side; see `SerializedImageRenderEntry`'s own doc. Omitted/empty means every image node renders as the documented gray placeholder, matching `createRenderer`'s own no-registry default. */
  imageRenderEntries?: readonly SerializedImageRenderEntry[];
  /** Every `VideoNode` asset this range needs, fetched ahead of time on the Node side; see `SerializedVideoAssetEntry`'s own doc. Omitted/empty means every video node renders as the documented placeholder, matching `createRenderer`'s own no-registry default. */
  videoAssetEntries?: readonly SerializedVideoAssetEntry[];
  /** Every `(assetRef, sourceFrame)` pair this range's own `[startFrame, endFrame)` actually needs a decoded video frame for; see `VideoSampleRequest`'s own doc. Omitted/empty means no video frame is ever sampled for this range, independent of whether `videoAssetEntries` itself is populated. */
  videoSamplesNeeded?: readonly VideoSampleRequest[];
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
 * `async` (unlike text rendering, `buildTextureRegistry` must decode real
 * image bytes via `createImageBitmap`, which has no synchronous form, so
 * `createRenderer`'s own `textureRegistry` cannot be built without an
 * `await` first) - but this `await` only decodes bytes; it starts no frame
 * render and reports no progress, so it does not reintroduce the "eagerly
 * starting the render before a caller has had a chance to attach
 * `onProgress`/error handling" problem the *returned generator itself*
 * still exists specifically to avoid (see `encodedChunksGenerator`'s own
 * doc immediately below). Every caller was already `async` regardless (see
 * `runBrowserHeadlessRender`/`runBrowserHeadlessRenderRange`'s own bodies),
 * so awaiting this function's own result adds no new "a promise of a
 * generator" awkwardness on their end.
 *
 * @throws {CompositionNotFoundForRenderError} if `compositionId` does not
 *   exist in `project`.
 */
async function buildEncodedChunksForRange(
  project: Project,
  compositionId: string,
  seed: string | number,
  bitrate: number,
  range: { startFrame?: number; endFrame?: number; keyframeIntervalFrames?: number } = {},
  textRenderEntries: readonly SerializedTextRenderEntry[] = [],
  imageRenderEntries: readonly SerializedImageRenderEntry[] = [],
  videoAssetEntries: readonly SerializedVideoAssetEntry[] = [],
  videoSamplesNeeded: readonly VideoSampleRequest[] = [],
): Promise<{
  composition: { width: number; height: number; fps: number };
  encodedChunks: AsyncGenerator<EncodedChunkResult>;
}> {
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

  const textureRegistry = await buildTextureRegistry(imageRenderEntries);
  const videoFrameRegistry = await buildVideoFrameRegistry(
    videoAssetEntries,
    videoSamplesNeeded,
    composition.fps,
  );
  const innerRenderer = createRenderer({
    textRenderRegistry: buildTextRenderRegistry(textRenderEntries),
    textureRegistry,
    videoFrameRegistry,
  });
  const renderer = createPixelReadableRenderer({
    renderer: innerRenderer,
    readPixels: createRealReadPixels(),
  });

  // `init` cannot be awaited here (the *generator* is intentionally left
  // synchronous to construct up to this point: it performs every remaining
  // asynchronous step, including `init`, lazily on first pull) without
  // eagerly starting the render before a caller has had a chance to attach
  // `onProgress`/error handling. Instead, `init` is awaited as the
  // generator's own first action, which every consumer already awaits
  // naturally via `for await`/`.next()`.
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
    const { composition, encodedChunks } = await buildEncodedChunksForRange(
      config.project,
      config.compositionId,
      config.seed,
      config.bitrate,
      {},
      config.textRenderEntries,
      config.imageRenderEntries,
      config.videoAssetEntries,
      config.videoSamplesNeeded,
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
    const { encodedChunks } = await buildEncodedChunksForRange(
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
      config.imageRenderEntries,
      config.videoAssetEntries,
      config.videoSamplesNeeded,
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
 * One audio asset this project needs, fetched ahead of time on the Node
 * side (`@cadra/encode`'s own `render-job.ts`, via the same
 * `fetchAssetBytes` seam `SerializedImageRenderEntry` already uses - audio
 * and image assets are resolved through the exact same asset store, just
 * decoded differently once here) and carried across `page.evaluate`'s
 * structured-clone boundary as plain, serializable data.
 */
export interface SerializedAudioAssetEntry {
  /** The `AudioMixdownSegment.assetRef` this entry serves. */
  assetRef: string;
  /** The asset's raw, still-encoded bytes. */
  bytes: number[];
}

/** Config `runBrowserHeadlessAudioMixdown` accepts, structured-cloned in from the Node orchestrator via `page.evaluate`. */
export interface BrowserHeadlessAudioMixdownConfig {
  /** The project to resolve the audio mixdown from, i.e. `resolveAudioMixdown`'s own `project`. */
  project: Project;
  /** Which of `project`'s compositions to mix down. */
  compositionId: string;
  /** Target container: selects AAC (`"mp4"`) or Opus (`"webm"`), matching this same job's own video container. */
  container: "mp4" | "webm";
  /** Target bitrate in bits per second for the audio encoder. */
  bitrate: number;
  /** Every audio asset this project's mixdown needs, fetched ahead of time on the Node side; see `SerializedAudioAssetEntry`'s own doc. An asset this list omits (not fetched, or the fetch failed) renders as silence for every segment referencing it, matching `ResolveAudioBufferFn`'s own "not available is expected" contract. */
  audioAssetEntries: readonly SerializedAudioAssetEntry[];
}

/** `runBrowserHeadlessAudioMixdown`'s own result: the whole composition's audio, already encoded, ready for `render-job.ts`'s final mux pass to thread into `muxToMp4Stream`/`muxToWebmStream`'s optional `audio` argument. */
export interface SerializedAudioMixdownResult {
  /** The encoded audio chunk stream, serialized. */
  chunks: SerializedEncodedAudioChunk[];
  /** WebCodecs codec string, from the first chunk's own `metadata.decoderConfig.codec`. */
  codec: string;
  /** Number of channels the mixdown was actually rendered at. */
  numberOfChannels: number;
  /** Sample rate (Hz) the mixdown was actually rendered at. */
  sampleRate: number;
}

/**
 * Renders `config.project`'s own composition `config.compositionId`'s full
 * audio mixdown (`@cadra/core`'s `resolveAudioMixdown`) to a single encoded
 * chunk stream, entirely inside this page: decodes each of
 * `config.audioAssetEntries`'s own raw bytes into a real `AudioBuffer` via
 * a throwaway `OfflineAudioContext`'s own `decodeAudioData` (the one real
 * Web Audio decoder capable of "whatever format an agent uploaded" - the
 * audio-side counterpart to `buildTextureRegistry`'s own `createImageBitmap`
 * use for images), builds the synchronous `resolveAudioBuffer` map
 * `renderAudioMixdown` needs from the results, renders the full-composition
 * mixdown, then encodes it via `encodeAudio`.
 *
 * Returns `undefined` (not an empty chunk list) when the mixdown has no
 * segments at all (a composition with no `audioTracks`, or only empty
 * ones): `renderAudioMixdown`'s own doc explicitly leaves "skip encoding a
 * silent composition's audio entirely" to a caller, and this is that
 * caller - avoiding the wasted encode of a track nobody needs, and letting
 * `render-job.ts`'s own final mux pass omit `muxToMp4Stream`/
 * `muxToWebmStream`'s optional `audio` argument entirely for a silent
 * composition, exactly as if this function had never been called.
 *
 * One audio asset failing to decode (corrupt bytes, or a format this
 * browser's own `decodeAudioData` does not support) is caught and logged
 * via `console.error` rather than rejecting this function or the render as
 * a whole: every segment referencing that one asset renders as silence for
 * its own window instead (see `ResolveAudioBufferFn`'s own "not available
 * is an expected runtime state" contract), matching the same resilience
 * `buildTextureRegistry` already applies per image asset. A genuine
 * mixdown/encode failure (e.g. `WebCodecsUnavailableForAudioEncodingError`)
 * is not caught here, unlike a single asset's own decode failure: it
 * propagates to this function's own caller, which treats it as "no audio
 * for this render" at the whole-job level (see `render-job.ts`'s own doc),
 * not a reason to fail an otherwise-successful video render.
 *
 * Rejects with a real `Error`, mirroring `runBrowserHeadlessRender`'s own
 * rationale for why (see its doc).
 */
export async function runBrowserHeadlessAudioMixdown(
  config: BrowserHeadlessAudioMixdownConfig,
): Promise<SerializedAudioMixdownResult | undefined> {
  try {
    const composition = config.project.compositions.find(
      (candidate) => candidate.id === config.compositionId,
    );
    if (composition === undefined) {
      throw new CompositionNotFoundForRenderError(config.compositionId);
    }

    const mixdown = resolveAudioMixdown(config.project, config.compositionId);
    if (mixdown.segments.length === 0) {
      return undefined;
    }

    // A throwaway context, used only for its own real decodeAudioData
    // (a BaseAudioContext method, so any concrete subclass has it) - never
    // rendered, never reused for renderAudioMixdown's own actual mixdown
    // pass below (that one needs its own context sized to the composition's
    // full duration, constructed by renderAudioMixdown itself).
    const decodeContext = new OfflineAudioContext(1, 1, 44_100);
    const decodedBuffers = new Map<string, AudioBufferLike>();
    for (const entry of config.audioAssetEntries) {
      try {
        const arrayBuffer = Uint8Array.from(entry.bytes).buffer;
        const decoded = await decodeContext.decodeAudioData(arrayBuffer);
        decodedBuffers.set(entry.assetRef, decoded);
      } catch (error) {
        console.error(`Failed to decode audio asset "${entry.assetRef}":`, error);
      }
    }

    const mixedBuffer = await renderAudioMixdown({
      mixdown,
      fps: composition.fps,
      durationInFrames: composition.durationInFrames,
      resolveAudioBuffer: (assetRef) => decodedBuffers.get(assetRef),
    });

    const encodeOptions: EncodeAudioOptions = {
      container: config.container,
      bitrate: config.bitrate,
    };
    const chunks: EncodedAudioChunkResult[] = [];
    for await (const chunkResult of encodeAudio(mixedBuffer, encodeOptions)) {
      chunks.push(chunkResult);
    }

    const codec = chunks[0]?.metadata?.decoderConfig?.codec;
    if (codec === undefined) {
      throw new Error(
        "runBrowserHeadlessAudioMixdown: encodeAudio produced no chunk carrying a decoderConfig.codec.",
      );
    }

    return {
      chunks: chunks.map((chunkResult) => serializeEncodedAudioChunk(chunkResult)),
      codec,
      numberOfChannels: mixedBuffer.numberOfChannels,
      sampleRate: mixedBuffer.sampleRate,
    };
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
