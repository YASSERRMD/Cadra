import type {
  ModelRegistry,
  PixelReadableRenderer,
  RenderSize,
  RenderTarget,
  TextRenderRegistry,
  ThreeRendererDependencies,
} from "@cadra/renderer";
import { createDefaultModelRegistry, defaultThreeRendererDependencies, ThreeRenderer } from "@cadra/renderer";
import type { Texture } from "three";
import { PMREMGenerator, WebGPURenderer } from "three/webgpu";

/**
 * Phase 24 research spike: an experimental, opt-in, Chromium-free headless
 * render path that drives a real `ThreeRenderer` (this codebase's own
 * `Renderer`/reconciler/opacity/camera-resolution logic, reused verbatim via
 * `@cadra/renderer`'s additively-exported `ThreeRendererDependencies`
 * injection seam) through a real native WebGPU device, acquired from the
 * `webgpu` npm package (Dawn-backed, no browser process, no Playwright
 * anywhere in this module), by default.
 *
 * This module exists because of four genuine platform gaps, all discovered
 * and worked around while building this phase, documented in
 * `docs/adr/0001-native-gpu-headless-render-path.md`:
 *
 * 1. Plain Node defines none of the WebGPU spec's ambient globals a browser
 *    provides for free: not just `GPUDevice`/`GPUAdapter` (the actual
 *    device-level types this module deals with directly), but also the
 *    constant-bag globals real WebGPU code reads as bare identifiers
 *    (`GPUTextureUsage`, `GPUBufferUsage`, `GPUMapMode`, `GPUShaderStage`,
 *    `GPUColorWrite`). Three.js's `WebGPUBackend` reads `GPUTextureUsage`
 *    directly deep inside its own texture-creation path (not merely through
 *    the injected `device`), and this module's own
 *    `createHeadlessGpuCanvasTarget`/`readNativeGpuTexturePixels` read
 *    `GPUTextureUsage`/`GPUBufferUsage`/`GPUMapMode` the same way; without
 *    installing them first, both fail at runtime with a plain
 *    `ReferenceError` (verified while building this phase), not a
 *    WebGPU-specific error. `createDefaultNativeGpuRoot` installs these via
 *    the `webgpu` npm package's own `globals` export, exactly as that
 *    package's own README documents as required usage
 *    (`Object.assign(globalThis, globals)`), not an optional convenience.
 *
 * 2. Even with a real `device` injected directly into `WebGPURenderer`'s own
 *    constructor parameters, Three.js's `WebGPUUtils.getPreferredCanvasFormat()`
 *    still reads the *global* `navigator.gpu.getPreferredCanvasFormat()` as
 *    a bare reference, entirely independent of the injected `device`
 *    (verified while building this phase: omitting a real global
 *    `navigator.gpu` reproduces a real `TypeError: Cannot read properties
 *    of undefined (reading 'getPreferredCanvasFormat')`). `createDefaultNativeGpuRoot`
 *    installs a real `navigator.gpu` pointing at the same root the device
 *    itself came from, via `Object.defineProperty` rather than a plain
 *    assignment (Node v20's later minor versions and v22+ define a built-in
 *    `navigator` global as a getter-only accessor property, which throws on
 *    a plain `globalThis.navigator = ...` assignment).
 *
 * 3. Three.js's `WebGPURenderer` unconditionally starts an internal
 *    `Animation` loop at the end of every `init()` call, and that loop's
 *    `requestAnimationFrame` source defaults to the global `self` (a
 *    browser/worker windowing concept with no meaning in Node,
 *    `typeof self === "undefined"` there), not anything derived from the
 *    injected `device`/`canvas`. `installNativeGpuGlobals` below polyfills a
 *    minimal `self.requestAnimationFrame` so `init()` does not throw; this
 *    loop's own callback (`this._animationLoop`) is never actually set by
 *    this module (only manual `render()` calls drive drawing, exactly
 *    matching every other `Renderer` in this codebase, which never runs its
 *    own `requestAnimationFrame` loop either), so the polyfilled scheduler
 *    firing (or not) has no observable effect on rendering correctness.
 *
 * 4. The `webgpu` npm package's own README states plainly that it "doesn't
 *    provide a way to render to an `HTMLCanvasElement`" and that its
 *    supported use is "render to textures and then read them back": it
 *    ships a real `GPUAdapter`/`GPUDevice`, but no `GPUCanvasContext`
 *    implementation at all (that is a browser compositor/swapchain concept
 *    with no headless equivalent as an installable package today).
 *    `createHeadlessGpuCanvasTarget` below is this module's own minimal,
 *    hand-written polyfill of just the two `GPUCanvasContext` methods
 *    `WebGPUBackend` actually calls (`configure`/`getCurrentTexture`),
 *    backed by a manually-managed `GPUTexture` recreated on every
 *    `getCurrentTexture()` call (mirroring a real swapchain's "new backbuffer
 *    each frame" contract) with `COPY_SRC` usage added so `readPixels` can
 *    read it back afterward, which a real (browser-owned, compositor-consumed)
 *    swapchain texture would not need.
 *
 * All four are narrow, deliberate workarounds for real, verified gaps, not
 * speculative code: every step here was proven to work end to end (a real,
 * non-blank, pixel-verified render) against this exact `webgpu`/`three`
 * version pair while building this phase. See this module's own tests for
 * the passing, no-browser, no-Playwright proof.
 *
 * **Experimental. Opt-in only.** Nothing in this module is imported by
 * `render-composition.ts`/`render-composition-headless-server.ts`, and
 * nothing in either of those changes as a result of this module existing:
 * the default headless render path remains Phase 23's Playwright/Chromium
 * one. A caller must explicitly import `createNativeGpuHeadlessRenderer`
 * (or `createNativeGpuDevice` directly) to opt into this path at all.
 */

/** A real or fake `GPUAdapter`, narrowed to the one method this module calls. */
export interface NativeGpuAdapterLike {
  requestDevice(descriptor?: GPUDeviceDescriptor): Promise<GPUDevice>;
}

/** A real or fake `navigator.gpu`-shaped object, narrowed to the one method this module calls. */
export interface NativeGpuRootLike {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<NativeGpuAdapterLike | null>;
}

/**
 * Constructs (or returns) the `navigator.gpu`-shaped root this module
 * acquires an adapter/device from. Allowed to return either a plain value or
 * a `Promise` (the real default, `createDefaultNativeGpuRoot`, is async
 * purely because it dynamically imports the `webgpu` module itself; the
 * `webgpu` package's own `create()` call underneath is synchronous), mirroring
 * `Renderer.init`'s own "`Promise<void> | void`" contract for the same
 * reason: a future synchronous fake should not be forced to wrap itself in a
 * trivially-resolved promise. Injectable for the same reason every other
 * real GPU/browser construct in this codebase is (`ReadPixelsFn`,
 * `VideoEncoderConstructor`, `AudioContextLike`): a fast unit test should
 * not have to pay a real native WebGPU device's acquisition cost (or run on
 * a machine that has one at all) just to exercise this module's own
 * plumbing, so tests inject a fake; production code (and this module's own
 * "does this really work here" integration test) uses the real default,
 * `createDefaultNativeGpuRoot`.
 */
export type NativeGpuRootFactory = () => Promise<NativeGpuRootLike> | NativeGpuRootLike;

/**
 * The real default: the `webgpu` npm package's own `create([])`, i.e. a
 * genuine Dawn-backed native WebGPU implementation with no browser process
 * anywhere underneath. Dynamically imported inside this function's own body
 * (not a static top-level `import`), mirroring `launchPlaywrightHeadlessBrowser`'s
 * own dynamic `import("playwright")`: `@cadra/headless`'s package template
 * exposes only a single `"."` `exports` subpath, so anything importing from
 * this package's barrel transitively pulls in this module too, and a static
 * top-level `import("webgpu")` would load Dawn's native binding the instant
 * that bundle loads, even for a caller that never calls this function at
 * all (e.g. `@cadra/encode`'s browser-side entry script, bundled by
 * `bundleBrowserEntry` for an actual browser target, where a native Node
 * addon cannot load at all). A dynamic `import()` inside this function's own
 * body only executes if this function is actually invoked.
 */
export async function createDefaultNativeGpuRoot(): Promise<NativeGpuRootLike> {
  const { create, globals } = await import("webgpu");
  // The `webgpu` package's own README documents this exact call
  // (`Object.assign(globalThis, globals)`) as required usage, not an
  // optional convenience: `globals` is a plain object of the real GPU
  // class constructors (`GPUDevice`, `GPUTexture`, ...) plus the
  // constant-bag globals (`GPUTextureUsage`, `GPUBufferUsage`, `GPUMapMode`,
  // `GPUShaderStage`, `GPUColorWrite`) that a browser provides ambiently but
  // plain Node does not define at all. Three.js's `WebGPUBackend` reads
  // `GPUTextureUsage` directly (as a bare global, not through the injected
  // `device`) deep inside its own texture-creation path, and this module's
  // own `createHeadlessGpuCanvasTarget`/`readNativeGpuTexturePixels` read
  // `GPUTextureUsage`/`GPUBufferUsage`/`GPUMapMode` the same way; without
  // this line, both fail at runtime with a plain `ReferenceError` (verified
  // while building this phase), not a WebGPU-specific error, since these are
  // just missing global identifiers as far as the JS engine is concerned.
  Object.assign(globalThis, globals);

  const root = create([]) as unknown as NativeGpuRootLike;

  // A second, distinct gap from the `globals` one above: even with a real
  // `device` injected directly into `WebGPURenderer`'s constructor
  // parameters, Three.js's `WebGPUUtils.getPreferredCanvasFormat()` still
  // reads the *global* `navigator.gpu.getPreferredCanvasFormat()` as a bare
  // reference, entirely independent of the injected `device` (verified while
  // building this phase: omitting this line reproduces a real
  // `TypeError: Cannot read properties of undefined (reading
  // 'getPreferredCanvasFormat')`, since plain Node's global `navigator`
  // object, when one exists at all, has no `gpu` property). A plain
  // `globalThis.navigator = ...` assignment throws on Node v20's later
  // minor versions and Node v22+ (both define a built-in `navigator` global
  // as a getter-only accessor property), so this redefines the property via
  // `Object.defineProperty` instead, exactly as any real Node-hosted caller
  // of the `webgpu` package must.
  Object.defineProperty(globalThis, "navigator", {
    value: { gpu: root },
    configurable: true,
    writable: true,
  });

  return root;
}

/** Thrown when `requestAdapter()` resolves to `null`, i.e. no WebGPU-capable adapter (hardware or software) is available on this machine at all. */
export class NativeGpuAdapterUnavailableError extends Error {
  constructor() {
    super(
      "createNativeGpuDevice: requestAdapter() resolved to null. No WebGPU-capable adapter " +
        "(hardware or software) is available through the injected NativeGpuRootFactory on this machine.",
    );
    this.name = "NativeGpuAdapterUnavailableError";
  }
}

/** Options accepted by `createNativeGpuDevice`. */
export interface CreateNativeGpuDeviceOptions {
  /** Constructs the `navigator.gpu`-shaped root to request an adapter from. Defaults to `createDefaultNativeGpuRoot` (the real `webgpu` package). */
  createRoot?: NativeGpuRootFactory;
  /** Forwarded to `requestAdapter()` verbatim, e.g. `{ powerPreference: "high-performance" }`. */
  adapterOptions?: GPURequestAdapterOptions;
  /** Forwarded to `requestDevice()` verbatim. */
  deviceDescriptor?: GPUDeviceDescriptor;
}

/**
 * Acquires a real (or, in a test, fake) `GPUDevice` with no browser
 * anywhere in the call path: `createRoot()` (a real `webgpu` package
 * instance by default) -> `requestAdapter()` -> `requestDevice()`. This is
 * the exact three-call sequence verified to succeed on Darwin/arm64 (Metal
 * backend) while building this phase; see the ADR for what this looked like
 * on the one machine this phase was built and verified on.
 *
 * @throws {NativeGpuAdapterUnavailableError} if no adapter is available at all.
 */
export async function createNativeGpuDevice(
  options: CreateNativeGpuDeviceOptions = {},
): Promise<GPUDevice> {
  const createRoot = options.createRoot ?? createDefaultNativeGpuRoot;
  const root = await createRoot();
  const adapter = await root.requestAdapter(options.adapterOptions);
  if (adapter === null) {
    throw new NativeGpuAdapterUnavailableError();
  }
  return adapter.requestDevice(options.deviceDescriptor);
}

/**
 * Polyfills the one global Three.js's `WebGPURenderer` genuinely needs and
 * plain Node does not provide: `self` (its internal `Animation` loop's
 * default `requestAnimationFrame` source; see this module's own doc for why)
 * plus `requestAnimationFrame`/`cancelAnimationFrame` themselves. Safe to
 * call more than once (idempotent: only assigns a property that is not
 * already present), so a caller rendering multiple frames/renderers in the
 * same process never double-installs this.
 *
 * This is a narrow, deliberate polyfill of exactly the scheduling surface
 * `WebGPURenderer.init()`'s own internal `Animation.start()` call touches,
 * not a general-purpose "make Node look like a browser" shim: nothing else
 * in this module (or the `Renderer`/`PixelReadableRenderer` contract this
 * module implements) ever reads `self`/`requestAnimationFrame` itself, and
 * `renderFrame` below never lets that internal loop's own scheduled
 * callback do anything observable (see this function's own doc above for
 * why the loop firing has no effect on correctness).
 */
export function installNativeGpuGlobals(): void {
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  if (globalRecord.self === undefined) {
    globalRecord.self = globalThis;
  }
  if (globalRecord.requestAnimationFrame === undefined) {
    // The `time` argument passed to `callback` is a monotonically
    // increasing placeholder tick count, not a real timestamp: this
    // renderer's own internal `Animation` loop callback is never wired up
    // by this module (see this function's own doc above), so no code
    // anywhere in this render path ever reads this value. A placeholder
    // counter (rather than `Date.now()`/`performance.now()`) keeps this
    // module free of wall-clock reads, matching this codebase's own
    // determinism lint rule for scene-evaluation-adjacent code, even though
    // this particular value happens to be unobserved either way.
    let placeholderTick = 0;
    globalRecord.requestAnimationFrame = (callback: (time: number) => void): number => {
      placeholderTick += 1;
      return setTimeout(() => callback(placeholderTick), 16) as unknown as number;
    };
  }
  if (globalRecord.cancelAnimationFrame === undefined) {
    globalRecord.cancelAnimationFrame = (handle: number): void => {
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    };
  }
}

/**
 * A minimal hand-written `GPUCanvasContext` polyfill: implements exactly the
 * two methods `WebGPUBackend` actually calls (`configure`/`getCurrentTexture`,
 * plus the no-op `unconfigure` it calls on teardown), backed by a single
 * manually-managed `GPUTexture` that this function recreates (destroying the
 * previous one) on every `getCurrentTexture()` call, mirroring a real
 * swapchain's "hand back a fresh backbuffer each frame" contract closely
 * enough for `WebGPUBackend`'s own usage (it calls `getCurrentTexture()`
 * once per `render()` call, never holds the previous call's texture view
 * across a frame boundary).
 *
 * `usage` always includes `COPY_SRC` (on top of whatever `configure()`'s own
 * `descriptor.usage` requests), specifically so `readNativeGpuPixels` can
 * copy the drawn texture out to a mappable buffer afterward: a real browser
 * swapchain texture is consumed directly by the compositor and never needs
 * this, but a headless caller has no compositor, so reading the texture back
 * itself is the only way to ever see what was drawn.
 */
function createHeadlessGpuCanvasTarget(
  device: GPUDevice,
  size: RenderSize,
): { canvas: RenderTarget; getLastDrawnTexture: () => GPUTexture | undefined } {
  let currentTexture: GPUTexture | undefined;
  let configuredFormat: GPUTextureFormat = "bgra8unorm";

  const context = {
    configure(descriptor: GPUCanvasConfiguration): void {
      configuredFormat = descriptor.format;
    },
    unconfigure(): void {
      currentTexture?.destroy();
      currentTexture = undefined;
    },
    getCurrentTexture(): GPUTexture {
      currentTexture?.destroy();
      currentTexture = device.createTexture({
        size: { width: size.width, height: size.height, depthOrArrayLayers: 1 },
        format: configuredFormat,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
      });
      return currentTexture;
    },
  };

  // Structurally satisfies just enough of `HTMLCanvasElement`/`OffscreenCanvas`
  // for `WebGPUBackend`'s own canvas-target code path: `width`/`height` (it
  // reads these to build its default viewport) and `getContext("webgpu")`
  // (it never requests any other context type). `addEventListener`/
  // `removeEventListener`/`style` are present as harmless no-ops only
  // because `RenderTarget`'s real union members (`HTMLCanvasElement`,
  // `OffscreenCanvas`) both declare them; nothing in this module or
  // `WebGPUBackend`'s own canvas-target render path ever calls them.
  const canvas = {
    width: size.width,
    height: size.height,
    getContext: (contextId: string) => (contextId === "webgpu" ? context : null),
    addEventListener: () => {},
    removeEventListener: () => {},
    style: {},
  } as unknown as RenderTarget;

  return { canvas, getLastDrawnTexture: () => currentTexture };
}

/**
 * Reads `texture`'s pixels back to a plain `Uint8ClampedArray`, via
 * `copyTextureToBuffer` + `mapAsync(GPUMapMode.READ)`, the same recipe
 * verified against a real render in this phase's own spike. `bytesPerRow`
 * is padded up to WebGPU's required 256-byte alignment (`copyTextureToBuffer`
 * rejects an unaligned `bytesPerRow`); the returned array has any such
 * padding stripped back out, so its length is always exactly
 * `width * height * 4`, matching `PixelBuffer`'s own documented contract.
 */
async function readNativeGpuTexturePixels(
  device: GPUDevice,
  texture: GPUTexture,
  size: RenderSize,
): Promise<Uint8ClampedArray> {
  const bytesPerPixel = 4;
  const unalignedBytesPerRow = size.width * bytesPerPixel;
  const alignedBytesPerRow = Math.ceil(unalignedBytesPerRow / 256) * 256;

  const readBuffer = device.createBuffer({
    size: alignedBytesPerRow * size.height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: readBuffer, bytesPerRow: alignedBytesPerRow, rowsPerImage: size.height },
    { width: size.width, height: size.height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);

  await readBuffer.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(readBuffer.getMappedRange().slice(0));
  readBuffer.unmap();
  readBuffer.destroy();

  if (alignedBytesPerRow === unalignedBytesPerRow) {
    return new Uint8ClampedArray(padded.buffer, padded.byteOffset, padded.byteLength);
  }

  // Strip the per-row alignment padding: copy each row's real
  // `unalignedBytesPerRow` bytes out, skipping the aligned padding at the
  // end of every row.
  const unpadded = new Uint8ClampedArray(unalignedBytesPerRow * size.height);
  for (let row = 0; row < size.height; row += 1) {
    const paddedRowStart = row * alignedBytesPerRow;
    const unpaddedRowStart = row * unalignedBytesPerRow;
    unpadded.set(padded.subarray(paddedRowStart, paddedRowStart + unalignedBytesPerRow), unpaddedRowStart);
  }
  return unpadded;
}

/** Options accepted by `createNativeGpuHeadlessRenderer`. */
export interface CreateNativeGpuHeadlessRendererOptions {
  /** Acquires the native `GPUDevice` this renderer draws through. Defaults to a real `webgpu`-package device via `createNativeGpuDevice()`. */
  createDevice?: () => Promise<GPUDevice>;
  /**
   * Resolves a `"model"` scene node's own `assetRef` to its already-loaded
   * `LoadedModel` (Phase 69). Defaults to a fresh, empty
   * `createDefaultModelRegistry()`, mirroring `ThreeRenderer`'s own
   * constructor default - every `"model"` node then renders as an empty
   * placeholder until a caller `.register()`s a real one on this exact
   * instance before rendering.
   */
  modelRegistry?: ModelRegistry;
  /**
   * Resolves a `"text"` scene node's own shaped/atlas-generated render data
   * (Phase 71). Defaults to `undefined`, mirroring `ThreeRenderer`'s own
   * constructor default - every `"text"` node then renders as an empty
   * placeholder until a caller supplies a real registry populated ahead of
   * time (shaping and MSDF atlas generation are both async; see
   * `TextRenderRegistry`'s own doc in `@cadra/renderer`).
   */
  textRenderRegistry?: TextRenderRegistry;
}

/**
 * **Experimental.** Constructs a `PixelReadableRenderer` (this codebase's
 * standard headless-render-with-readback contract, from `@cadra/renderer`)
 * backed by a real `ThreeRenderer` driven through a native WebGPU device
 * acquired with no browser process (the `webgpu` npm package, by default).
 *
 * This is a genuine alternative backend, not a parallel/disconnected
 * system: `init`/`renderFrame`/`resize`/`dispose`/`readPixels` all delegate
 * to a real `ThreeRenderer` instance (the exact same reconciler,
 * `applyLayerOpacity`, and `findActiveCamera` logic `createRenderer()`'s
 * default browser/WebGL2 path uses), differing only in `ThreeRendererDependencies.createWebGpuRenderer`:
 * this function supplies one that acquires a native device
 * (`createNativeGpuDevice`, injectable via `options.createDevice`) and hands
 * it to `three/webgpu`'s real `WebGPURenderer` alongside a headless
 * `GPUCanvasContext` polyfill (`createHeadlessGpuCanvasTarget`), instead of
 * `defaultThreeRendererDependencies`'s own browser-`canvas`-based factory.
 * `detectWebGpuSupport` is fixed to always report `true` (this renderer
 * only ever exercises the WebGPU path, deliberately: there is no native
 * WebGL2 fallback story here, so falling back would silently produce a
 * misleading `RendererCapabilities.backend`); a device-acquisition failure
 * (e.g. `NativeGpuAdapterUnavailableError`) surfaces as a real rejection
 * from `init()` instead.
 *
 * `readPixels()` (via `PixelReadableRenderer`) reads back whichever
 * `GPUTexture` the most recent `renderFrame()` call actually drew into (via
 * the same headless canvas target's own `getLastDrawnTexture()`), not a
 * fresh empty texture: `renderFrame` always calls the underlying
 * `ThreeRenderer.renderFrame`, which internally calls
 * `context.getCurrentTexture()` again through `WebGPUBackend`'s own render
 * path before drawing, so by the time `readPixels()` runs, the headless
 * target's `getLastDrawnTexture()` is exactly the texture that call's
 * drawing commands were submitted against.
 *
 * See this module's own top-of-file doc for the two platform gaps this
 * function's helpers work around (`installNativeGpuGlobals`,
 * `createHeadlessGpuCanvasTarget`), and
 * `docs/adr/0001-native-gpu-headless-render-path.md` for the full research
 * and benchmark this spike is grounded in.
 */
export function createNativeGpuHeadlessRenderer(
  options: CreateNativeGpuHeadlessRendererOptions = {},
): PixelReadableRenderer {
  installNativeGpuGlobals();

  const createDevice = options.createDevice ?? (() => createNativeGpuDevice());
  const modelRegistry = options.modelRegistry ?? createDefaultModelRegistry();
  const textRenderRegistry = options.textRenderRegistry;

  let headlessTarget: ReturnType<typeof createHeadlessGpuCanvasTarget> | undefined;
  let device: GPUDevice | undefined;
  let currentSize: RenderSize | undefined;

  const deps: ThreeRendererDependencies = {
    detectWebGpuSupport: () => true,
    createWebGpuRenderer: (target: RenderTarget, _size: RenderSize) => {
      // `target` here is the very `headlessTarget.canvas` this closure
      // constructs below (init() below is always called with it, since this
      // module owns `ThreeRenderer.init`'s `target` argument end to end),
      // never a caller-supplied real HTMLCanvasElement: this experimental
      // renderer's own `init()` ignores whatever `target` a caller passes
      // in (see its own doc) and always draws into its own headless target.
      const renderer = new WebGPURenderer({ device, canvas: target, antialias: false });
      // Minimal Phase 56 conformance: `ThreeRendererDependencies`'s
      // `ThreeRendererLike` now requires `createEnvironmentMap` (PMREM
      // prefiltering support), which no real Three.js renderer class
      // provides natively. This experimental spike does not otherwise apply
      // `@cadra/renderer`'s own `applyColorWorkflowDefaults`/area-light setup
      // (both pre-existing, orthogonal gaps in this ADR-scoped research path,
      // not introduced here), so this is scoped to exactly the one method
      // needed to satisfy the type.
      const pmremGenerator = new PMREMGenerator(renderer);
      return Object.assign(renderer, {
        createEnvironmentMap(equirectangular: Texture): Texture {
          return pmremGenerator.fromEquirectangular(equirectangular).texture;
        },
      });
    },
    createWebGl2Renderer: () => {
      // Never actually reachable: detectWebGpuSupport always returns true
      // above, so ThreeRenderer never calls this branch. Throws (rather
      // than silently constructing something) so a future change to
      // ThreeRenderer's own branching logic fails loudly here instead of
      // silently drawing through an unintended path.
      throw new Error(
        "createNativeGpuHeadlessRenderer: createWebGl2Renderer should never be called; " +
          "this experimental renderer always forces the WebGPU path.",
      );
    },
    initPhysics: defaultThreeRendererDependencies.initPhysics,
    createPhysicsBake: defaultThreeRendererDependencies.createPhysicsBake,
    createParticleRuntime: defaultThreeRendererDependencies.createParticleRuntime,
  };

  const inner = new ThreeRenderer(deps, undefined, undefined, modelRegistry, textRenderRegistry);

  return {
    async init(_target: RenderTarget, size: RenderSize): Promise<void> {
      device = await createDevice();
      headlessTarget = createHeadlessGpuCanvasTarget(device, size);
      currentSize = size;
      await inner.init(headlessTarget.canvas, size);
    },
    renderFrame(sceneState, frameContext): void {
      inner.renderFrame(sceneState, frameContext);
    },
    resize(size: RenderSize): void {
      if (device === undefined) {
        inner.resize(size);
        return;
      }
      // The headless canvas target's own texture size is fixed at
      // construction; a real resize would need to rebuild it. Out of scope
      // for this single-frame research spike (see the ADR's own
      // "Consequences" section), so this narrows to same-size calls only.
      if (size.width !== currentSize?.width || size.height !== currentSize?.height) {
        throw new Error(
          "createNativeGpuHeadlessRenderer: resize() to a different size is not supported by " +
            "this experimental renderer (single-frame spike scope only). Dispose and construct " +
            "a new renderer at the desired size instead.",
        );
      }
      inner.resize(size);
    },
    dispose(): void {
      inner.dispose();
      headlessTarget?.getLastDrawnTexture()?.destroy();
      device?.destroy();
      device = undefined;
      headlessTarget = undefined;
    },
    async readPixels() {
      if (device === undefined || headlessTarget === undefined || currentSize === undefined) {
        throw new NativeGpuRendererNotInitializedError();
      }
      const texture = headlessTarget.getLastDrawnTexture();
      if (texture === undefined) {
        throw new NativeGpuRendererNotInitializedError();
      }
      const data = await readNativeGpuTexturePixels(device, texture, currentSize);
      return { width: currentSize.width, height: currentSize.height, data };
    },
    get backend() {
      return inner.backend;
    },
    get capabilities() {
      return inner.capabilities;
    },
  };
}

/** Thrown when `readPixels()` (or an internal size-dependent call) runs before `init()` has resolved on a native-GPU headless renderer. */
export class NativeGpuRendererNotInitializedError extends Error {
  constructor() {
    super("createNativeGpuHeadlessRenderer's renderer used before init() resolved.");
    this.name = "NativeGpuRendererNotInitializedError";
  }
}
