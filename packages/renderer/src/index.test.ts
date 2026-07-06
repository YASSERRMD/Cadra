import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createRenderer, PACKAGE_NAME, VERSION } from "./index.js";

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
});

/**
 * Guards against Three.js leaking into the `Renderer`-facing part of this
 * package's public surface (`Renderer`, `SceneState`, `createRenderer`, and
 * friends). Deliberately does not cover `./reconciler`: that module is
 * additive, separate, and exists specifically to expose real `THREE.Object3D`
 * types, so scanning it for "no Three.js" would contradict its own purpose
 * (see `./reconciler/index.ts`'s module doc).
 *
 * What this proves: none of the source files that make up the `Renderer`-facing
 * export graph (`index.ts` itself, plus every local module it re-exports
 * types or values from, excluding `./reconciler/*`) contain a `from "three"`
 * or `from "three/*"` import. Since those are exactly the files whose
 * declared export shapes become that part of `@cadra/renderer`'s public
 * `.d.ts` surface, this rules out a `three` type reaching an exported
 * `Renderer`-facing signature.
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
    "assets/gltf-loader.ts",
    "assets/image-loader.ts",
    "assets/render-when-ready.ts",
    "assets/types.ts",
    "assets/video-loader.ts",
  ];
  const threeImportPattern = /from\s+["']three(\/[^"']*)?["']/;

  it.each(publicSurfaceFiles)("%s contains no import from three", (fileName) => {
    const contents = readFileSync(join(currentDir, fileName), "utf-8");
    expect(contents).not.toMatch(threeImportPattern);
  });
});
