import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Msdfgen as MsdfgenClass } from "msdfgen-wasm";

/**
 * `msdfgen-wasm@1.0.0`'s published ESM build (`dist/esm/index.js`) re-exports
 * its sibling modules with extensionless specifiers (`export * from
 * "./Msdfgen"`), which Node's ESM loader rejects outright
 * (`ERR_MODULE_NOT_FOUND`) since it requires explicit file extensions for
 * relative imports; only bundlers tolerate that. Verified empirically: a
 * plain `import "msdfgen-wasm"` throws immediately under Node, while
 * `require("msdfgen-wasm")` (its CJS build) works. `createRequire` is the
 * standard, documented way to reach a CJS module's `require` from ESM, used
 * here specifically to route around this upstream bug rather than to avoid
 * ESM in general.
 */
const require = createRequire(import.meta.url);
const Msdfgen = (require("msdfgen-wasm") as { Msdfgen: typeof MsdfgenClass }).Msdfgen;

let cachedInstance: Promise<MsdfgenClass> | undefined;

/**
 * Lazily instantiates the shared `msdfgen-wasm` module (parsing and
 * compiling its wasm binary once per process). `Msdfgen` holds exactly one
 * font's glyphs loaded at a time, so callers reload via `loadFont`/
 * `loadGlyphs` per font rather than expecting multiple fonts to be
 * concurrently resident; that reload is comparatively cheap next to the
 * expensive per-glyph MSDF bitmap generation this module gates access to.
 */
export function getMsdfgenInstance(): Promise<MsdfgenClass> {
  let instance = cachedInstance;
  if (instance === undefined) {
    const wasmPath = require.resolve("msdfgen-wasm/wasm");
    const wasmBytes = readFileSync(wasmPath);
    const wasmArrayBuffer = wasmBytes.buffer.slice(
      wasmBytes.byteOffset,
      wasmBytes.byteOffset + wasmBytes.byteLength,
    );
    instance = Msdfgen.create(wasmArrayBuffer);
    cachedInstance = instance;
  }
  return instance;
}
