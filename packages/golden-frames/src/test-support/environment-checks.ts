import { readFileSync } from "node:fs";

import { createNativeGpuDevice } from "@cadra/headless";
import { chromium } from "playwright";

/**
 * Whether a real native WebGPU device can actually be acquired on this
 * machine, checked by attempting the real acquisition itself (there is no
 * cheap synchronous pre-check for this, unlike `isRealChromiumAvailable`):
 * a fresh clone without the `webgpu` package's prebuilt native binary for
 * its OS/arch, or a sandboxed CI runner with no GPU/software-Vulkan path at
 * all, both fail here. Mirrors `render-frame-native-gpu.e2e.test.ts`'s own
 * per-test try/catch convention (`@cadra/headless`), shared here across
 * this package's several e2e test files rather than duplicated in each,
 * since they all need the exact same check.
 */
export async function isNativeGpuAvailable(): Promise<boolean> {
  try {
    const device = await createNativeGpuDevice();
    device.destroy();
    return true;
  } catch (error) {
    console.log(
      `@cadra/golden-frames e2e test: skipping, a real native WebGPU device could not be acquired on this machine (${String(error)}).`,
    );
    return false;
  }
}

/**
 * Whether real Chromium is available in this environment, checked
 * synchronously via Playwright's own `chromium.executablePath()` (the exact
 * path Playwright itself would try to launch) plus a filesystem existence
 * check, without actually attempting a launch. Mirrors `@cadra/encode`'s
 * own `isRealChromiumAvailable` (duplicated per-file there; shared here for
 * the same reason as `isNativeGpuAvailable` above).
 */
export function isRealChromiumAvailable(): boolean {
  try {
    const executablePath = chromium.executablePath();
    readFileSync(executablePath);
    return true;
  } catch (error) {
    console.log(
      `@cadra/golden-frames e2e test: skipping, real Chromium was not found on this machine (${String(error)}).`,
    );
    return false;
  }
}
