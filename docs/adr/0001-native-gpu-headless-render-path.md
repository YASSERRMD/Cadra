# ADR-0001: Native GPU headless render path (Chromium-free)

**Status:** Accepted (as an experimental, opt-in path; not a replacement for the default Playwright path)
**Date:** 2026-07-06
**Deciders:** Cadra maintainers

## Context

Cadra's server-side render path (Phase 23, `renderCompositionHeadlessServer`)
launches real headless Chromium via Playwright, bundles the whole
render/capture/encode/mux pipeline into a browser-side script, and injects
it into a page. This works, and it is the default, but it carries a real,
recurring cost: every render pays for a full Chromium process tree (browser
process, GPU process, renderer process, utility process) on top of whatever
work the render itself does. At the scale a hosted rendering service
operates at, that per-render Chromium overhead (both wall-clock startup
latency and standing memory) is a direct, compounding cost against
Remotion's own Chromium-based architecture, not a differentiator from it.

The premise of this phase: if Cadra could render without a browser process
at all, driving the GPU directly from Node, the fixed per-render overhead
drops substantially, which is a genuine, structural cost advantage over a
Chromium-based competitor, not just an incremental optimization.

This phase is explicitly a **research spike plus a documented design**, not
a production replacement. The task was to research the real, currently
available options for headless GPU access outside a browser, prototype the
most promising one against this codebase's actual `Renderer`/
`PixelReadableRenderer` abstraction, benchmark it honestly against the
existing browser path, and document determinism implications, before
recommending a target path and its risks.

### Environment this spike was built and verified on

Everything in this ADR (the prototype, the benchmarks, the specific errors
quoted) was run on exactly one machine:

- Apple MacBook Air, Apple M4 chip (arm64)
- macOS 26.5.2 (Darwin kernel 25.5.0)
- Node v24.11.1
- `three@0.185.1`, `webgpu@0.4.0`

No other GPU vendor, driver, or OS was available to test against. Every
cross-vendor/cross-platform claim in this document (see "Determinism
differences between GPU vendors and normalization strategies", below) is
therefore a researched/documented discussion grounded in well-known,
publicly-documented sources of GPU non-determinism, not something
empirically reproduced on a second machine in this exercise.

## Decision

**Adopt the `webgpu` npm package (Dawn-backed native WebGPU bindings for
Node) as the target native GPU backend**, gated behind an explicit,
separately-named, clearly-marked-experimental opt-in
(`createNativeGpuHeadlessRenderer`, exported from `@cadra/headless`
alongside, not instead of, the existing `renderComposition`/
`renderCompositionHeadlessServer` browser path). The existing Playwright
path remains the default with no behavior change.

This is not a "someday" recommendation: a working, end-to-end, non-blank,
pixel-verified render through this exact path was built and is checked into
this phase (`packages/headless/src/render-frame-native-gpu.ts` and its
`*.e2e.test.ts`), reusing this codebase's own `ThreeRenderer` and reconciler
verbatim via a newly, additively exported dependency-injection seam on
`@cadra/renderer` (`ThreeRendererDependencies`), not a parallel,
disconnected rendering pipeline.

### Why `webgpu` over the other real, installable options

Of the options genuinely available and installable today (see "Alternatives
considered" below for the full survey), `webgpu` is the only one that is
simultaneously: (a) real and installable via `npm install webgpu` today,
(b) targets this exact codebase's runtime (Node, not Deno), and (c) exposes
a standards-shaped `GPUDevice`/`GPUAdapter` API that Three.js's own
`WebGPURenderer` already has an injection seam for (`parameters.device`).
Every other genuinely-available, non-browser option either targets a
different runtime entirely (Deno) or is a lower-level graphics API (EGL/
ANGLE/Vulkan via Mesa or SwiftShader) that would require writing an entire
WebGPU-to-that-API translation layer from scratch, work Dawn (the engine
`webgpu` wraps) has already done and this spike can reuse directly.

## What the prototype actually achieved (be specific)

**Full success, not a partial one.** A real Three.js scene (a box mesh,
this codebase's own scene graph/reconciler/`SceneState` walk, unmodified)
rendered through a real native `GPUDevice` acquired from the `webgpu`
package, with the drawn frame's pixels read back and verified non-blank, all
inside a plain Node/Vitest process. No Playwright import exists anywhere in
the call path. This is checked in and passes as part of `pnpm -w test`
(guarded to skip cleanly, not fail the suite, if the native binding cannot
initialize on a given machine; see "Risks" below).

Getting there required working around **four real, distinct platform/
library gaps**, each discovered by hitting a real, verbatim error and
diagnosing it, not by assumption:

1. **Plain Node defines none of the WebGPU spec's ambient globals a browser
   provides for free.** Not just `GPUDevice`/`GPUAdapter` (the values this
   module actually holds references to), but also constant-bag globals real
   WebGPU code reads as bare identifiers: `GPUTextureUsage`, `GPUBufferUsage`,
   `GPUMapMode`, `GPUShaderStage`, `GPUColorWrite`. Three.js's
   `WebGPUBackend` reads `GPUTextureUsage` directly (not through the
   injected `device`) deep inside its own texture-creation path. Omitting
   these produces a plain `ReferenceError: GPUTextureUsage is not defined`,
   not a WebGPU-specific error. Fix: the `webgpu` package's own `globals`
   export, installed via `Object.assign(globalThis, globals)`, exactly as
   its README documents as required usage.

2. **Even with a real `device` injected directly into `WebGPURenderer`'s
   constructor, Three.js still reads the global `navigator.gpu` directly**
   for one specific call: `WebGPUUtils.getPreferredCanvasFormat()` calls
   `navigator.gpu.getPreferredCanvasFormat()` as a bare reference, entirely
   independent of the injected device. Omitting a real global `navigator.gpu`
   produces `TypeError: Cannot read properties of undefined (reading
   'getPreferredCanvasFormat')`. Fix: install a real `navigator.gpu`
   pointing at the same root the device came from. This also surfaced a
   smaller, genuinely new-to-this-codebase wrinkle: Node v22+ (and later
   Node v20 minor versions) define a built-in `navigator` global as a
   getter-only accessor property, so a plain `globalThis.navigator = ...`
   assignment throws (`TypeError: Cannot set property navigator of #<Object>
   which has only a getter`); `Object.defineProperty` with `configurable:
   true` is required instead.

3. **Three.js's `WebGPURenderer` unconditionally starts an internal
   `Animation` loop at the end of every `init()` call**, and that loop's
   `requestAnimationFrame` source defaults to the global `self`
   (`typeof self === "undefined"` in plain Node), not anything derived from
   the injected device/canvas. Omitting this produces `TypeError: Cannot
   read properties of null (reading 'requestAnimationFrame')`. Fix: a
   minimal `self`/`requestAnimationFrame`/`cancelAnimationFrame` polyfill.
   This loop's own scheduled callback is never wired up to anything
   observable by this render path (only manual `render()` calls ever draw),
   so the polyfilled scheduler firing or not has zero effect on rendering
   correctness or determinism.

4. **The `webgpu` npm package provides no `GPUCanvasContext` implementation
   at all.** Its own README states this plainly: "It also doesn't provide a
   way to render to an `HTMLCanvasElement`... What you can do is render to
   textures and then read them back." This is the one gap that could not be
   polyfilled with a one-line shim: `WebGPUBackend`'s canvas-target render
   path calls `context.configure(descriptor)` once and
   `context.getCurrentTexture()` once per frame, and no installable package
   provides either off a native `GPUDevice`. Fix: a small, hand-written
   polyfill (`createHeadlessGpuCanvasTarget` in
   `render-frame-native-gpu.ts`) implementing exactly those two methods
   (plus a no-op `unconfigure`), backed by a manually-managed `GPUTexture`
   recreated on every `getCurrentTexture()` call (mirroring a real
   swapchain's "fresh backbuffer each frame" contract), with `COPY_SRC`
   usage added specifically so the drawn texture can be read back afterward
   (a real, compositor-consumed swapchain texture never needs this).

None of these four are exotic; all four are the direct, mechanical
consequence of "a browser API surface implemented for a browser, pointed at
a device that did not come from a browser." Each is narrow, each is
documented in the shipped module's own doc comments with the exact verbatim
error it was diagnosed from, and none of them required forking Three.js or
the `webgpu` package itself.

## Benchmark

Same scene (one seeded box mesh, no lights, 640x360, 30 frames, this
codebase's real `@cadra/core` scene graph via `resolveSceneAtFrame`)
rendered both ways on the machine described above. Numbers below are the
range across 5 runs each (`packages/headless/scripts/benchmark-native-vs-browser.mjs`,
checked into this phase, is what produced them; re-run it to reproduce, but
expect the exact numbers, not the general shape, to vary by machine):

| Metric | Native (`webgpu` package) | Browser (Playwright/Chromium) |
| --- | --- | --- |
| Renderer/context init time | 18-31 ms | 20-44 ms (in-page) |
| Total 30-frame render loop | 91-158 ms | 330-470 ms (in-page) |
| Average per-frame time | 3.6-4.1 ms | 12.9-15.9 ms |
| **Total wall time (whole process)** | **95-157 ms** | **760-1,309 ms** |
| Orchestrating process RSS delta | 49-55 MB | -30 to +31 MB (noisy; see note) |
| Separate browser process tree | **none** | **~391-393 MB across 4 Chromium processes** |

**Total wall time: native was 7-11x faster than the browser path across
these runs**, and it entirely avoided spawning the ~391-393 MB, 4-process
Chromium tree (browser process, GPU process, renderer process, utility
process) the browser path pays every single render. The browser path's own
orchestrating-Node-process RSS delta reads as noisy (occasionally negative)
because that process's own memory fluctuates with garbage collection
between measurement points and is a small fraction of the total cost
anyway; the real, dominant, consistent memory cost on the browser path is
the separate Chromium process tree, which the native path does not have at
all. The native path's own larger, more consistent RSS delta (49-55 MB) is
Dawn's native GPU driver overhead loading in-process, a real cost, just one
paid once per render process rather than four times across a spawned
Chromium tree.

These are small-scene, single-machine numbers from a spike, not a
production capacity-planning benchmark; they are however a genuine,
reproducible, order-of-magnitude signal in the direction this phase set out
to investigate, not a marginal one.

## Determinism differences between GPU vendors and normalization strategies

This section is a researched, documented discussion: only one real GPU/
driver (Apple M4, Metal backend) was available to test against in this
spike, so the vendor-to-vendor claims below are grounded in well-known,
publicly documented sources of cross-vendor GPU non-determinism, not
something empirically reproduced against a second vendor in this exercise.

### Known real sources of cross-vendor non-determinism

- **Floating-point rounding and fused-multiply-add (FMA) differences.**
  IEEE 754 leaves some rounding behavior implementation-defined, and GPU
  shader compilers frequently fuse a multiply-then-add into a single FMA
  instruction when the target hardware supports it (extra rounding
  precision, computed differently than two separate rounded operations).
  Whether a given compiler fuses a given expression depends on the vendor's
  own shader compiler and optimization level, not just the GPU architecture,
  so the exact same WGSL/GLSL source can legitimately produce different
  last-bit pixel values on an AMD GPU vs. an NVIDIA GPU vs. Apple Silicon's
  own Metal-backed WebGPU implementation, even at identical requested
  precision.
- **Texture and mipmap filtering/compression differences.** Anisotropic
  filtering algorithms, mipmap generation (box filter vs. a vendor's own
  proprietary filter), and block-compressed texture formats (BCn, ASTC,
  ETC2) each have vendor- and driver-specific implementations with no single
  mandated bit-exact algorithm in the WebGPU/OpenGL/Vulkan specs; the same
  compressed texture asset can decode to slightly different sampled values
  across GPUs.
- **Multisample anti-aliasing (MSAA) resolve differences.** How a GPU
  resolves multiple per-pixel samples down to one final color (a simple
  average vs. a vendor-specific weighted resolve, and how partial-coverage
  edge pixels are handled) is not bit-exact-specified across
  implementations.
- **Shader compiler optimization differences.** Beyond FMA fusion above,
  general compiler optimization (constant folding order, instruction
  scheduling, register allocation affecting intermediate precision on
  hardware with mixed 16-/32-bit paths) differs by vendor and even by driver
  version from the same vendor, since WGSL/SPIR-V compilation to a specific
  GPU's native ISA is each vendor's own black box.

### Concrete normalization strategies this codebase could adopt

- **Prefer a software rasterizer (SwiftShader or Mesa's `llvmpipe`/lavapipe)
  specifically because it is bit-identical across machines regardless of
  the host's real GPU.** This is not a new idea for this codebase: Phase 23's
  own `DEFAULT_GPU_LAUNCH_ARGS` already forces `--use-angle=swiftshader` for
  exactly this reason (see `browser-launcher.ts`'s own extensive doc on this
  trade-off). The same principle applies to a native path: `webgpu` (Dawn)
  can itself be pointed at a software Vulkan implementation (lavapipe) as an
  alternative backend on Linux (see the `webgpu` package's own README,
  "Software GPU" section, linking to Dawn's own documentation of this), at
  the same real-GPU-speed-versus-cross-machine-determinism trade-off this
  codebase already accepts for the browser path.
- **Avoid vendor-specific extensions.** WebGPU's own spec deliberately
  gates optional hardware capabilities behind explicit, opt-in feature
  strings (e.g. `shader-f16`, `texture-compression-bc`, `subgroups`; several
  of which this exact M4/Metal adapter reported as available in this
  spike's own adapter probe). Never requesting an optional feature a render
  does not strictly need keeps the requested feature set (and therefore the
  code path a shader compiler takes) identical across machines with
  different optional-feature support.
- **Pin shader precision qualifiers explicitly** rather than relying on a
  shader language's own default precision (GLSL ES's `mediump` default in
  particular varies materially by implementation); requesting the highest
  precision a shader stage supports removes one axis of legitimate
  cross-vendor variance at the cost of some throughput.
- **Compare renders with a perceptual/structural similarity threshold, not
  bit-exact byte equality, for anything that must tolerate a real GPU
  backend at all.** Byte-exact reproducibility is realistically only a
  property of the *same* software rasterizer build running the *same*
  shader compilation; the moment a real, vendor-specific GPU is allowed into
  the render path (native or browser), the correct normalization target is
  "visually indistinguishable," not "identical bytes."

## Risks and consequences

- **This is genuinely experimental and single-frame-scoped.** The shipped
  `createNativeGpuHeadlessRenderer` explicitly does not support `resize()`
  to a different size after `init()` (throws a clear error naming this as
  spike-scope-only); a real multi-resolution production path would need
  this built out.
- **No native WebGL2 fallback exists for this path.** `detectWebGpuSupport`
  is hardcoded to always report `true` for this experimental renderer, since
  there is no equivalent "native WebGL2 for Node with no browser" option to
  fall back to today; a machine where native WebGPU device acquisition
  itself fails has no automatic degraded-but-working path the way the
  browser path's WebGPU-to-WebGL2 fallback does.
- **Platform/driver risk is real and largely unknown beyond this one
  machine.** This spike verified success on exactly one configuration
  (Apple Silicon, Metal backend). The `webgpu` npm package ships prebuilt
  native binaries per OS/architecture (its own README documents building for
  win64/macOS-intel/macOS-arm/linux); a machine without a matching prebuilt
  binary, or one whose only available GPU/driver Dawn cannot bind to at all,
  would fail at the `requestAdapter()`/`requestDevice()` step, before
  rendering anything. This is exactly why the shipped e2e test
  (`render-frame-native-gpu.e2e.test.ts`) attempts real device acquisition
  inside a `try`/`catch` and skips cleanly (not `it.skip`, an early `return`
  inside a passing test, mirroring `@cadra/encode`'s own real-browser e2e
  test convention) rather than failing `pnpm -w test` outright when
  acquisition itself fails.
- **A native Node addon (Dawn's `dawn.node`) is a materially different
  operational profile than a browser binary.** Chromium's own headless mode
  is an extremely well-trodden, widely-deployed deployment target (this
  codebase already deploys it in Phase 23); a native GPU Node addon in a
  containerized/serverless render fleet is a much less common pattern today,
  with correspondingly less operational precedent for issues like GPU driver
  availability inside a container, or crash isolation (a native addon crash
  can take down the whole Node process, unlike an isolated, independently
  restartable Chromium renderer process).
- **What becomes easier:** a materially faster, lower-memory render path
  becomes possible for the specific case of "one machine, one real (or
  software) GPU, rendering one composition," which is a direct, structural
  cost lever against a Chromium-based competitor at scale.
- **What becomes harder:** operating two genuinely different render
  backends (browser-based and native) means the "renders identically
  everywhere" guarantee this codebase's README states as a goal now has two
  independent code paths that must be kept honest against each other, not
  one.
- **What this phase deliberately does not resolve:** production
  resize/multi-frame-batch support for the native path, audio, a native
  WebGL2 (or equivalent) fallback, and empirical cross-vendor determinism
  testing (only one real vendor/driver was available to test in this
  exercise). All are legitimate, scoped follow-ups, not blockers to this
  ADR's decision to adopt `webgpu` as the recommended target for further
  investment, since the spike proved the core approach works end to end and
  the fallback (the existing, unaffected Playwright default) remains
  available regardless.

## Alternatives considered

### Node WebGPU bindings: the `webgpu` npm package (chosen)

Real, installable today (`npm view webgpu versions` lists 43 published
versions, latest `0.4.0`), Dawn-backed (the same WebGPU implementation
Chromium itself uses internally), targets this codebase's actual runtime
(Node), and exposes a standards-shaped `GPUDevice`/`GPUAdapter` that
Three.js's own `WebGPURenderer` already accepts via injection. Verified to
successfully acquire a real adapter and device, and (after the four
workarounds documented above) drive a full, correct, non-blank render on
this machine. This is the only option in this survey that is simultaneously
real, Node-targeted, and standards-API-shaped enough to plug into this
codebase's existing `Renderer` abstraction with a bounded amount of glue
code rather than a from-scratch translation layer.

Trade-offs against the chosen path: no canvas/context implementation
(worked around, see above), single-vendor-tested in this exercise, no
native WebGL2 fallback story, and a materially newer/less-operationally-
proven deployment pattern than headless Chromium.

### Deno WebGPU (`navigator.gpu` is built into the Deno runtime)

Deno ships `navigator.gpu` as a built-in, standards-compliant WebGPU
implementation with no separate npm package to install at all, which is a
genuinely simpler starting point than a Node native addon for a project
built on Deno from the start. This is a real, documented, currently
shipping capability of the Deno runtime, and is fairly named here as a
legitimate alternative.

It was not chosen because **this repository is a Node-based pnpm/Turborepo
monorepo**, and migrating any part of it to Deno is out of scope for this
phase (and was not asked for): doing so would mean rewriting this
workspace's entire build/test/lint tooling (`pnpm`, `turbo`, `vitest`,
`tsc` project references) onto a different runtime and module system, a
project-wide migration decision far larger than "how does headless GPU
rendering work," not a drop-in swap for one render path. If Cadra's tooling
ever migrates to Deno wholesale, this option would deserve a fresh look with
a much simpler on-ramp than the four workarounds this ADR's chosen path
required; today, it simply is not available to a Node process.

### ANGLE or EGL offscreen contexts

ANGLE (Almost Native Graphics Layer Engine, Google's GL-on-native-backend
translation layer) and raw EGL offscreen/pbuffer contexts are genuine,
real technologies (Chromium itself uses ANGLE internally, including for the
`--use-angle=swiftshader`/`--use-gl=angle` flags Phase 23's own
`browser-launcher.ts` already sets), but neither is a standalone, directly
`npm install`-able Node binding for "headless GPU rendering with no
browser" the way `webgpu` is. Using either directly from Node would mean
either writing native bindings against ANGLE's own C/C++ library API (a
substantial undertaking with no existing, maintained npm package providing
it, as of the research done for this phase) or reaching for a
lower-level, non-npm `node-gyp`-built native addon most projects would need
to author themselves. Named here as a real, conceptually valid alternative
worth tracking, not one with a currently-installable path this phase could
have prototyped the way it did `webgpu`.

### Mesa/SwiftShader for CPU/software-GPU fallback

Both are real: SwiftShader (Google's software rasterizer, already used by
Phase 23's own browser path via Chromium's `--use-angle=swiftshader` flag)
and Mesa's `llvmpipe`/lavapipe (software Vulkan/OpenGL implementations)
exist and are genuinely useful, specifically for the determinism-
normalization reason documented above: bit-identical output across any
host machine, regardless of its real GPU. Neither is, by itself, a
complete "headless GPU render path" the way `webgpu` is; they are backends
a GPU API implementation (ANGLE, Dawn, or a browser) can be pointed at.
Dawn's own documentation (linked from the `webgpu` package's own README)
describes running with a software Vulkan implementation as a supported
configuration option, meaning the `webgpu` package chosen above already has
a documented path to this exact fallback if a future phase needs it, rather
than this being a wholly separate technology to integrate.

## Action items

1. [ ] If native GPU headless rendering is pursued beyond this spike, add
   `resize()` support to `createNativeGpuHeadlessRenderer` (currently spike-
   scoped to a fixed size for the renderer's lifetime).
2. [ ] Test `webgpu` package device acquisition on at least one additional
   OS/GPU vendor combination (this spike verified only Apple Silicon/Metal)
   before considering this path for any production traffic.
3. [ ] Investigate wiring `webgpu`/Dawn to a software Vulkan backend
   (lavapipe) as this native path's own determinism-normalization option,
   mirroring Phase 23's existing SwiftShader default for the browser path.
4. [ ] Decide whether a native WebGL2-equivalent fallback is worth building
   for machines where native WebGPU device acquisition fails, or whether
   "fall back to the existing browser path" is an acceptable degraded mode
   instead.
