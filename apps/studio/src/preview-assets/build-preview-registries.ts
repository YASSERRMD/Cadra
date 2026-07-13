import type { Project } from "@cadra/core";
import type { AudioContextLike, DecodeVideoFrameFn, ResolveAudioBufferFn } from "@cadra/player";
import {
  computeVideoFrameCacheKey,
  createDefaultEnvironmentRegistry,
  createDefaultLutRegistry,
  createDefaultParseGltf,
  createImageTexture,
  createInMemoryModelRegistry,
  createInMemoryTextureRegistry,
  createInMemoryVideoFrameRegistry,
  type CreateRendererOptions,
  DEFAULT_ENVIRONMENT_REFS,
  DEFAULT_LUT_REFS,
  type LoadedModel,
  parseCubeLut,
  parseHdrEnvironment,
  type SampleAtTimestamp,
  sampleVideoFrame,
  type VideoSource,
} from "@cadra/renderer";

import { collectAssetRefs } from "./collect-asset-refs.js";
import { createFetchAssetBytesOverHttp } from "./fetch-asset-bytes.js";

/** Fetches an asset's raw bytes, given its `cadra-asset://` ref. Matches `@cadra/renderer`'s own `FetchBytes` shape, parameter renamed for clarity at this module's own call sites. */
export type FetchAssetBytesFn = (assetRef: string) => Promise<Uint8Array>;

/**
 * Everything a live `Viewport` mount needs to render real asset content:
 * spread `createRendererOptions` into `createRenderer()`, spread the rest
 * directly into `mountPreview()`'s own options object.
 *
 * Returned synchronously, before any asset has actually finished fetching:
 * every registry/resolver here is a real, mutable instance that starts empty
 * and fills in as background fetches individually resolve (see this
 * module's own top-level doc for why this shape - not "await everything,
 * then return" - is what `Viewport.tsx` actually needs). `onAssetReady` is
 * called after every individual image/model/environment/LUT asset that
 * finishes loading successfully, so the caller can nudge the current frame
 * to redraw: `@cadra/renderer`'s own reconciler (`node-factory.ts`'s
 * `"image"`/`"model"` cases) re-checks its own registry on every later
 * `applyNodeProperties` call for as long as a node is still showing its own
 * placeholder, so a plain `PreviewHandle.seek()` to the frame already
 * showing is all a caller needs to pick up newly arrived content - no
 * remount required. Video needs no such nudge at all: its own readiness is
 * gated natively by `mountPreview`'s own frame-accurate-seeking machinery on
 * every frame. Audio needs none either: `ResolveAudioBufferFn` is consulted
 * fresh on every scheduling decision, never cached by a one-shot reconcile.
 *
 * `dispose()` releases every real browser resource this module constructed
 * on `project`'s behalf (decoded `<video>` elements, object URLs, the
 * `AudioContext` used to decode audio) - call it from the same effect
 * cleanup that calls the `PreviewHandle`'s own `dispose()`, since
 * `Viewport`'s mount effect already rebuilds this whole bag from scratch on
 * every `document` change (see that component's own top-level doc for why
 * remounting fully, rather than incrementally updating, is this codebase's
 * deliberate current choice) - without this, every remount would leak the
 * previous mount's own video elements/object URLs/AudioContext.
 */
export interface PreviewRegistries {
  createRendererOptions: CreateRendererOptions;
  resolveAudioBuffer?: ResolveAudioBufferFn;
  audioContext?: AudioContextLike;
  decodeVideoFrame?: DecodeVideoFrameFn;
  dispose(): void;
}

/** Constructs a `PreviewRegistries` for `project`, matching `Viewport`'s own `createRenderer`/`observeResize` injectable-prop pattern. */
export type BuildPreviewRegistriesFn = (project: Project, fps: number, onAssetReady: () => void) => PreviewRegistries;

/**
 * Real, in-page `DecodeVideo`-shaped decode: wraps `bytes` in a `Blob`/object
 * URL and loads it into a real `HTMLVideoElement`, resolving once
 * `loadeddata` fires. Mirrors `@cadra/encode`'s own
 * `browser-headless-render-entry.ts`'s `createRealDecodeVideo` exactly (same
 * one-shot render pipeline, same real browser APIs), with one addition: the
 * object URL is handed back too (not just the element), so this module's own
 * `dispose()` can `revokeObjectURL` it - the one-shot render pipeline never
 * needs to, since its whole page is torn down immediately after one render,
 * but a studio document can be opened/closed/switched many times in one
 * long-lived tab.
 */
function decodeVideoElement(bytes: Uint8Array): Promise<{ video: HTMLVideoElement; objectUrl: string }> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([Uint8Array.from(bytes)]);
    const objectUrl = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    const onLoaded = (): void => {
      video.removeEventListener("error", onError);
      resolve({ video, objectUrl });
    };
    const onError = (): void => {
      video.removeEventListener("loadeddata", onLoaded);
      reject(video.error instanceof Error ? video.error : new Error("video decode failed to load"));
    };
    video.addEventListener("loadeddata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.src = objectUrl;
  });
}

/** Real, in-page `SampleAtTimestamp`: seeks `source` to `timestamp` and captures the resulting frame. Mirrors `browser-headless-render-entry.ts`'s own `createRealSampleAtTimestamp` exactly, including its zero-seek fast path. */
const sampleAtTimestamp: SampleAtTimestamp = async (source, timestamp) => {
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

/** Runs `fn` after every previously-queued `runExclusive` call for the same `key` has settled (successfully or not), so two callers never seek/sample the same `<video>` element concurrently - a single element only has one `currentTime` at a time (mirrors `browser-headless-render-entry.ts`'s own "sample sequentially per asset" rationale), which `mountPreview`'s own decode-queue de-dup (keyed on the exact `(assetRef, frame)` pair, not `assetRef` alone) does not by itself prevent across the *distinct* frames a prefetch window requests concurrently. */
function createKeyedExclusiveRunner(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = tails.get(key) ?? Promise.resolve();
    const result = previousTail.then(fn, fn);
    tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  };
}

/** Fetches and decodes every `ref` in `refs` in parallel, calling `onEach(ref, decoded)` followed by `onAssetReady()` as each individually succeeds, and logging (via `label`) rather than throwing when one fails - every per-kind populate function below is a thin call to this, differing only in how "decode" works for that kind. */
function populateInBackground<T>(
  refs: ReadonlySet<string>,
  fetchBytes: FetchAssetBytesFn,
  decode: (bytes: Uint8Array) => Promise<T>,
  onEach: (ref: string, decoded: T) => void,
  onAssetReady: () => void,
  label: string,
): void {
  for (const ref of refs) {
    void (async () => {
      try {
        const bytes = await fetchBytes(ref);
        const decoded = await decode(bytes);
        onEach(ref, decoded);
        onAssetReady();
      } catch (error) {
        console.error(`buildPreviewRegistries: failed to fetch/decode ${label} asset "${ref}":`, error);
      }
    })();
  }
}

/**
 * Builds every registry/resolver `createRenderer()`/`mountPreview()` need to
 * render `project`'s own real asset content instead of each kind's
 * documented placeholder, fetching bytes via `fetchBytes` (defaults to
 * `createFetchAssetBytesOverHttp()`, i.e. a locally running Cadra MCP
 * server's `GET /assets` endpoint - see that function's own doc).
 *
 * Synchronous by design (see `PreviewRegistries`'s own doc for the full
 * rationale): every registry/resolver is real and already wired to
 * `createRenderer()`/`mountPreview()`'s own shape the instant this returns,
 * but starts out empty and fills in as each asset's own background fetch/
 * decode resolves.
 *
 * `fps` must be the composition actually about to be previewed (not
 * necessarily every composition `project` contains): `resolveVideoSourceFrame`
 * (upstream of every `decodeVideoFrame` call this returns) has no `fps`
 * parameter of its own, so the `frame` values `decodeVideoFrame` is ever
 * actually called with are already expressed in that one composition's own
 * fps space - see `@cadra/core`'s own `resolveVideoSourceFrame` doc.
 *
 * A project with no assets referenced anywhere never touches `fetch`/
 * `AudioContext`/`document.createElement` at all - `collectAssetRefs`
 * itself is synchronous and free of any real I/O, and every per-kind ref
 * set it returns empty short-circuits before any real work begins.
 *
 * A project referencing only the built-in environment/LUT refs (`"studio"`/
 * `"outdoor"`, `"warm"`/`"tealOrange"`/`"filmStock"`) never fetches for
 * those specifically either - `DEFAULT_ENVIRONMENT_REFS`/`DEFAULT_LUT_REFS`
 * are filtered out before this module ever calls `fetchBytes`, since they
 * already resolve via each registry's own built-in fallback with no asset
 * to fetch at all.
 *
 * Text/Satori rendering is deliberately out of scope: both depend on
 * native Node addons (`@resvg/resvg-js` for SVG rasterization; HarfBuzz-
 * adjacent shaping code entangled with other Node-only dependencies in this
 * codebase's current packaging) with no browser build at all, confirmed via
 * `@cadra/svg-raster`/`@cadra/text`'s own browser-safe subset modules. A
 * `TextNode`/`SatoriNode` in the live viewport keeps rendering as its
 * documented empty placeholder; there is no existing "renders real text
 * inside a real browser" path anywhere in this codebase to build this one
 * on top of (see this task's own investigation for the full detail).
 *
 * `ModelNode` real-asset resolution is also deliberately out of scope for
 * now, for a different reason: unlike `image` (fixed to retry against the
 * registry on any later reconcile, see `node-factory.ts`'s own `"image"`
 * case), `model`'s own placeholder path returns `owned: undefined` entirely
 * (an empty group, no owned resources at all to retry into) rather than a
 * mutable `owned` object a later call could populate - fixing this the same
 * way needs a broader reconciler signature change (a way for
 * `applyNodeProperties` to hand the reconciler a *replacement* `owned`, not
 * just mutate an existing one), out of scope for this task; flagged as a
 * follow-up. `modelRegistry` below is still populated for whatever *does*
 * resolve before a `ModelNode`'s own first reconcile (the one-shot render
 * pipelines' own case, always true there), just not for one that resolves
 * later, live.
 */
export function buildPreviewRegistries(
  project: Project,
  fps: number,
  onAssetReady: () => void,
  fetchBytes: FetchAssetBytesFn = createFetchAssetBytesOverHttp(),
): PreviewRegistries {
  const refs = collectAssetRefs(project);
  const disposers: Array<() => void> = [];

  const textureRegistry = createInMemoryTextureRegistry();
  populateInBackground(
    refs.images,
    fetchBytes,
    async (bytes) => createImageTexture(await createImageBitmap(new Blob([Uint8Array.from(bytes)]))),
    (ref, texture) => textureRegistry.register(ref, texture),
    onAssetReady,
    "image",
  );

  const modelRegistry = createInMemoryModelRegistry();
  const parseGltf = createDefaultParseGltf();
  populateInBackground(
    refs.models,
    fetchBytes,
    // `GltfAsset` is deliberately opaque (see its own doc): `createDefaultParseGltf`'s
    // real result structurally satisfies `LoadedModel`, mirroring
    // `browser-headless-render-entry.ts`'s own identical cast at its own
    // equivalent call site.
    async (bytes) => (await parseGltf(bytes)) as LoadedModel,
    (ref, model) => modelRegistry.register(ref, model),
    onAssetReady,
    "model",
  );

  const customEnvironments = new Map<string, ReturnType<typeof parseHdrEnvironment>>();
  const defaultEnvironments = createDefaultEnvironmentRegistry();
  const customEnvironmentRefs = new Set(
    Array.from(refs.environments).filter((ref) => !(DEFAULT_ENVIRONMENT_REFS as readonly string[]).includes(ref)),
  );
  populateInBackground(
    customEnvironmentRefs,
    fetchBytes,
    (bytes) => Promise.resolve(parseHdrEnvironment(bytes)),
    (ref, texture) => customEnvironments.set(ref, texture),
    onAssetReady,
    "environment",
  );
  const environmentRegistry = {
    resolve: (ref: string) => customEnvironments.get(ref) ?? defaultEnvironments.resolve(ref),
  };

  const customLuts = new Map<string, ReturnType<typeof parseCubeLut>>();
  const defaultLuts = createDefaultLutRegistry();
  const customLutRefs = new Set(
    Array.from(refs.luts).filter((ref) => !(DEFAULT_LUT_REFS as readonly string[]).includes(ref)),
  );
  populateInBackground(
    customLutRefs,
    fetchBytes,
    (bytes) => Promise.resolve(parseCubeLut(new TextDecoder("utf-8").decode(bytes))),
    (ref, lut) => customLuts.set(ref, lut),
    onAssetReady,
    "LUT",
  );
  const lutRegistry = { resolve: (ref: string) => customLuts.get(ref) ?? defaultLuts.resolve(ref) };

  const createRendererOptions: CreateRendererOptions = {
    textureRegistry,
    modelRegistry,
    environmentRegistry,
    lutRegistry,
  };

  const result: PreviewRegistries = {
    createRendererOptions,
    dispose: () => {
      for (const dispose of disposers) {
        dispose();
      }
    },
  };

  if (refs.videos.size > 0) {
    const videoFrameRegistry = createInMemoryVideoFrameRegistry();
    createRendererOptions.videoFrameRegistry = videoFrameRegistry;

    const sourcesByAssetRef = new Map<string, Promise<{ video: HTMLVideoElement; objectUrl: string }>>();
    const runExclusive = createKeyedExclusiveRunner();

    function getSource(assetRef: string): Promise<{ video: HTMLVideoElement; objectUrl: string }> {
      let pending = sourcesByAssetRef.get(assetRef);
      if (pending === undefined) {
        pending = fetchBytes(assetRef).then(decodeVideoElement);
        sourcesByAssetRef.set(assetRef, pending);
      }
      return pending;
    }

    result.decodeVideoFrame = async (assetRef: string, frame: number): Promise<void> => {
      await runExclusive(assetRef, async () => {
        const { video } = await getSource(assetRef);
        const image = await sampleVideoFrame(video as VideoSource, frame, fps, { sampleAtTimestamp });
        videoFrameRegistry.register(computeVideoFrameCacheKey(assetRef, frame), { image });
      });
    };

    disposers.push(() => {
      for (const pending of sourcesByAssetRef.values()) {
        pending
          .then(({ video, objectUrl }) => {
            video.pause();
            video.removeAttribute("src");
            URL.revokeObjectURL(objectUrl);
          })
          .catch(() => {
            // A source that never finished decoding has nothing to release.
          });
      }
    });
  }

  if (refs.audio.size > 0) {
    const audioContext = new AudioContext();
    const buffers = new Map<string, AudioBuffer>();
    result.resolveAudioBuffer = (assetRef: string) => buffers.get(assetRef);
    result.audioContext = audioContext;

    const decodeAudio = (bytes: Uint8Array): Promise<AudioBuffer> => {
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return audioContext.decodeAudioData(arrayBuffer);
    };
    // resolveAudioBuffer is consulted fresh on every scheduling decision
    // (attachAudioToTransport's own scheduleClip), never cached by a
    // one-shot reconcile the way image/model are - late-arriving audio
    // takes effect on its own next natural scheduling point, no
    // onAssetReady nudge needed. Still passed through here (not omitted)
    // purely so a failed decode gets the exact same logged-and-skipped
    // treatment every other kind gets.
    populateInBackground(refs.audio, fetchBytes, decodeAudio, (ref, buffer) => buffers.set(ref, buffer), () => {
      // No-op: see the doc above for why audio needs no re-render nudge.
    }, "audio");

    disposers.push(() => {
      void audioContext.close().catch(() => {
        // Already closed, or never fully opened; nothing further to release.
      });
    });
  }

  return result;
}
