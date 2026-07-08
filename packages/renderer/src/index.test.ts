import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createBestAvailableRenderer,
  createRenderer,
  createWorkerRenderer,
  defaultThreeRendererDependencies,
  PACKAGE_NAME,
  ThreeRenderer,
  VERSION,
} from "./index.js";

describe("@cadra/renderer package identity", () => {
  it("exports the expected VERSION", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("exports the expected PACKAGE_NAME", () => {
    expect(PACKAGE_NAME).toBe("@cadra/renderer");
  });
});

describe("@cadra/renderer public surface", () => {
  it("exposes a usable createRenderer from the package entry point", () => {
    const renderer = createRenderer();
    expect(typeof renderer.init).toBe("function");
    expect(typeof renderer.renderFrame).toBe("function");
    expect(typeof renderer.resize).toBe("function");
    expect(typeof renderer.dispose).toBe("function");
  });

  it("exposes a usable createWorkerRenderer from the package entry point", () => {
    const renderer = createWorkerRenderer({ createWorker: () => ({}) as never });
    expect(typeof renderer.init).toBe("function");
    expect(typeof renderer.renderFrame).toBe("function");
    expect(typeof renderer.resize).toBe("function");
    expect(typeof renderer.dispose).toBe("function");
  });

  it("exposes a usable createBestAvailableRenderer from the package entry point, falling back to the direct renderer in this environment", () => {
    // No real OffscreenCanvas in this Node/Vitest environment, so this
    // exercises createBestAvailableRenderer's real default detector too,
    // not just an injected override.
    const renderer = createBestAvailableRenderer();
    expect(typeof renderer.init).toBe("function");
    expect(typeof renderer.renderFrame).toBe("function");
    expect(typeof renderer.resize).toBe("function");
    expect(typeof renderer.dispose).toBe("function");
  });

  it("exposes a constructible ThreeRenderer plus its default dependency set from the package entry point (Phase 24's injection seam for @cadra/headless's experimental native-GPU path)", () => {
    const renderer = new ThreeRenderer(defaultThreeRendererDependencies);
    expect(typeof renderer.init).toBe("function");
    expect(typeof renderer.renderFrame).toBe("function");
    expect(typeof renderer.resize).toBe("function");
    expect(typeof renderer.dispose).toBe("function");
  });
});

/**
 * Guards against Three.js leaking into the `Renderer`-facing part of this
 * package's public surface (`Renderer`, `SceneState`, `createRenderer`, and
 * friends). Deliberately does not cover `./reconciler`: that module is
 * additive, separate, and exists specifically to expose real `THREE.Object3D`
 * types, so scanning it for "no Three.js" would contradict its own purpose
 * (see `./reconciler/index.ts`'s module doc).
 *
 * `three-renderer.ts` is excluded for the same reason, as of Phase 24:
 * `index.ts` now additively exports `ThreeRenderer`/`ThreeRendererDependencies`/
 * `defaultThreeRendererDependencies` specifically so a caller (namely
 * `@cadra/headless`'s experimental native-GPU headless render path) can
 * construct a `ThreeRenderer` with its own substituted `createWebGpuRenderer`
 * factory. `ThreeRendererFactory`'s own signature already only takes/returns
 * plain `RenderTarget`/`RenderSize`/`ThreeRendererLike`-shaped values (no
 * `three` type crosses that boundary; see `three-renderer.ts`'s own
 * `ThreeRendererLike` comment), so this export intentionally exposes the
 * *class* and its *dependency-injection seam*, not a `three` type on any
 * exported signature; scanning this file's imports for "no Three.js" would
 * contradict that this is exactly the file whose whole purpose is
 * constructing real Three.js renderers.
 *
 * `gizmo/attach-transform-gizmo.ts` and `picking/pick-node-at-point.ts` are
 * excluded for the same reason, as of Phase 40: they additively export
 * `attachTransformGizmo` and `pickNodeAtPoint`, whose own declared signatures
 * are already entirely free of Three.js types (each takes the plain
 * `Renderer`, and hands back/receives only plain `@cadra/core`/primitive
 * values), but whose *implementations* import `three` (and, for the gizmo,
 * `three/addons/controls/TransformControls.js`) directly to do the real
 * work, exactly like `three-renderer.ts` itself does. Scanning either file's
 * own imports for "no Three.js" would again contradict that raycasting/
 * constructing a real Three.js gizmo is each module's entire purpose; what
 * actually matters (each *exported signature* staying Three.js-free) is
 * enforced by their own `.test.ts` files asserting on those modules' actual
 * exported types, not by a source-text scan here.
 *
 * `assets/gltf-loader.ts` is excluded for the same reason, as of Phase 69:
 * `createDefaultParseGltf`'s own declared signature (`(): ParseGltf`, where
 * `ParseGltf = (bytes: Uint8Array) => Promise<GltfAsset>` and `GltfAsset` is
 * the deliberately opaque `object`) is already entirely free of Three.js
 * types, but its *implementation* imports three.js's own `GLTFLoader`
 * (`three/addons/loaders/GLTFLoader.js`) directly to do the real parsing,
 * exactly like `three-renderer.ts`/the gizmo/picking modules above.
 *
 * What this proves: none of the source files that make up the `Renderer`-facing
 * export graph (`index.ts` itself, plus every local module it re-exports
 * types or values from, excluding `./reconciler/*`, `three-renderer.ts`,
 * `gizmo/attach-transform-gizmo.ts`, `picking/pick-node-at-point.ts`, and
 * `assets/gltf-loader.ts`) contain a `from "three"` or `from "three/*"`
 * import. Since those are
 * exactly the files whose declared export shapes become that part of
 * `@cadra/renderer`'s public `.d.ts` surface, this rules out a `three` type
 * reaching an exported `Renderer`-facing signature through any *other* file.
 *
 * What this does not prove: it does not catch a `three` type smuggled in
 * through a type-only re-export several modules deep that this list doesn't
 * name, and it is a text-based check, not a structural/type-level one. The
 * stronger version of this guarantee is enforced by design (see
 * `three-renderer.ts`'s `ThreeRendererLike` comment) and by the fact that
 * `createRenderer`'s public parameter and return types are built entirely
 * from types declared in the files this test scans.
 */
describe("@cadra/renderer Renderer-facing surface has no Three.js leakage", () => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // Every source file reachable from index.ts's export statements. Extend
  // this list if index.ts starts re-exporting from a new local module.
  const publicSurfaceFiles = [
    "index.ts",
    "renderer.ts",
    "create-renderer.ts",
    "capability-detection.ts",
    "assets/asset-loader-orchestrator.ts",
    "assets/audio-loader.ts",
    "assets/font-loader.ts",
    "assets/image-loader.ts",
    "assets/render-when-ready.ts",
    "assets/types.ts",
    "assets/video-loader.ts",
    "worker/index.ts",
    "worker/offscreen-detection.ts",
    "worker/scene-state-diff.ts",
    "worker/worker-host.ts",
    "worker/worker-protocol.ts",
    "worker/worker-renderer.ts",
  ];
  const threeImportPattern = /from\s+["']three(\/[^"']*)?["']/;

  it.each(publicSurfaceFiles)("%s contains no import from three", (fileName) => {
    const contents = readFileSync(join(currentDir, fileName), "utf-8");
    expect(contents).not.toMatch(threeImportPattern);
  });
});
