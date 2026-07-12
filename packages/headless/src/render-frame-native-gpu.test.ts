import { describe, expect, it } from "vitest";

import {
  createNativeGpuHeadlessRenderer,
  NativeGpuAdapterUnavailableError,
} from "./render-frame-native-gpu.js";

/**
 * Regression coverage for a real bug: `createNativeGpuHeadlessRenderer`'s
 * `dispose()` used to call the wrapped `ThreeRenderer`'s own `dispose()`
 * unconditionally, even when `init()` failed before ever reaching
 * `inner.init()` (e.g. `NativeGpuAdapterUnavailableError`, the expected
 * outcome on any machine with no usable GPU adapter - undetectable on a
 * machine that always has one, which is exactly why this shipped unnoticed
 * until a real GPU-less CI runner hit it). `ThreeRenderer.dispose()` itself
 * throws `RendererNotInitializedError` ("Renderer used before init()
 * resolved.") when called before its own `init()` resolved, and since that
 * throw came from inside a caller's own `finally` block
 * (`render-frames-tools.ts`'s own `try { await renderer.init() } catch {
 * ... } finally { renderer.dispose() }` pattern), it silently replaced the
 * catch block's already-correctly-computed, actionable error response - a
 * finally block that throws always overrides whatever the try/catch was
 * already returning or throwing.
 *
 * Exercised entirely with `createDevice` injected as a fake that rejects
 * (see `CreateNativeGpuHeadlessRendererOptions.createDevice`'s own doc):
 * no real GPU/native binding needed at all, unlike this module's sibling
 * `render-frame-native-gpu.e2e.test.ts` (which needs a real device and
 * skips cleanly when one is not available) - this test's whole point is to
 * run reliably on every machine, including exactly the GPU-less ones the
 * bug it guards against only ever manifested on.
 */
describe("createNativeGpuHeadlessRenderer: dispose() after a failed init()", () => {
  it("dispose() does not throw when init() itself rejected before reaching the wrapped renderer's own init", async () => {
    const renderer = createNativeGpuHeadlessRenderer({
      createDevice: () => Promise.reject(new NativeGpuAdapterUnavailableError()),
    });

    await expect(renderer.init({} as never, { width: 4, height: 4 })).rejects.toBeInstanceOf(
      NativeGpuAdapterUnavailableError,
    );

    expect(() => renderer.dispose()).not.toThrow();
  });

  it("a caller's own try/catch/finally around init()/dispose() still observes the real NativeGpuAdapterUnavailableError, not a dispose()-time error", async () => {
    // Mirrors render-frames-tools.ts's own exact pattern: init() inside the
    // try, dispose() unconditionally in finally, the caught error is what
    // this test asserts on - proving the finally block's own dispose() call
    // no longer clobbers it.
    const renderer = createNativeGpuHeadlessRenderer({
      createDevice: () => Promise.reject(new NativeGpuAdapterUnavailableError()),
    });

    let caught: unknown;
    try {
      await renderer.init({} as never, { width: 4, height: 4 });
    } catch (error) {
      caught = error;
    } finally {
      renderer.dispose();
    }

    expect(caught).toBeInstanceOf(NativeGpuAdapterUnavailableError);
  });
});

/**
 * The complementary "dispose() still works normally after a real,
 * successful init()" case is not re-proven here with a fake device: a
 * fake minimal enough to unit-test cheaply cannot also satisfy
 * `inner.init()`'s own real `WebGPURenderer` construction, and this
 * module's sibling `render-frame-native-gpu.e2e.test.ts` already covers
 * that exact real-init-then-real-dispose path end to end (skipping cleanly
 * on a machine with no real device, same as this file's own bug report
 * describes for the *un*-guarded caller this fix protects).
 */
