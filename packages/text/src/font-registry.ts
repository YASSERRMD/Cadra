import {
  type AssetRegistry,
  type ContentHash,
  createInMemoryAssetRegistry,
  hashAssetBytes,
  type Pending,
} from "@cadra/core";

import { parseFontWithFontkit } from "./font-parser-fontkit.js";
import { parseFontWithOpentype } from "./font-parser-opentype.js";
import type { FontParseBackend, ParsedFont } from "./parsed-font.js";

/**
 * Content-hashed font registry integrating with base Phase 12's asset
 * pipeline: every registration exposes a `ready` promise shaped exactly
 * like core's `Pending`, so a caller can pass `fontRegistry.pendingRegistrations()`
 * straight into `waitForAssets`/`renderWhenAssetsReady` to gate a render
 * until every referenced font has finished loading and parsing. Keyed by
 * content hash (not url or family name): the same font bytes registered
 * twice, however they were reached, resolve to the exact same `ParsedFont`
 * and are only parsed once.
 */

export interface FontRegistryOptions {
  /** Which backend parses this font. Defaults to the registry's own default (see `createFontRegistry`). */
  backend?: FontParseBackend;
}

export interface FontRegistration {
  readonly ready: Promise<ParsedFont>;
}

export interface FontRegistry {
  /** Registers a font whose bytes are already fully loaded; parses and registers synchronously. */
  registerBytes(bytes: Uint8Array, options?: FontRegistryOptions): FontRegistration;
  /** Registers a font whose bytes are still loading; parses and registers once `bytesReady` resolves. */
  registerPending(bytesReady: Promise<Uint8Array>, options?: FontRegistryOptions): FontRegistration;
  /** Looks up an already-registered, already-resolved font by its content hash. */
  resolve(contentHash: ContentHash): ParsedFont | undefined;
  has(contentHash: ContentHash): boolean;
  /** Every registration made so far, shaped for `waitForAssets`/`renderWhenAssetsReady`. */
  pendingRegistrations(): readonly Pending[];
}

function parseWithBackend(bytes: Uint8Array, backend: FontParseBackend): ParsedFont {
  return backend === "fontkit" ? parseFontWithFontkit(bytes) : parseFontWithOpentype(bytes);
}

/**
 * Creates an empty font registry. `defaultBackend` picks which parser new
 * registrations use unless a call site overrides it per-font; pass
 * `"opentype"` (the default) for registries that must also work inside a
 * browser-bundled render page, or `"fontkit"` for Node-only contexts that
 * want its richer variable-font introspection.
 */
export function createFontRegistry(defaultBackend: FontParseBackend = "opentype"): FontRegistry {
  const registry: AssetRegistry<ParsedFont> = createInMemoryAssetRegistry<ParsedFont>();
  const registrations: Pending[] = [];

  function registerBytes(bytes: Uint8Array, options: FontRegistryOptions = {}): FontRegistration {
    const contentHash = hashAssetBytes(bytes);
    const existing = registry.resolve(contentHash);
    if (existing !== undefined) {
      const ready = Promise.resolve(existing);
      registrations.push({ ready });
      return { ready };
    }

    const parsed = parseWithBackend(bytes, options.backend ?? defaultBackend);
    registry.register(parsed.contentHash, parsed);
    const ready = Promise.resolve(parsed);
    registrations.push({ ready });
    return { ready };
  }

  function registerPending(
    bytesReady: Promise<Uint8Array>,
    options: FontRegistryOptions = {},
  ): FontRegistration {
    const ready = bytesReady.then((bytes) => {
      const contentHash = hashAssetBytes(bytes);
      const existing = registry.resolve(contentHash);
      if (existing !== undefined) {
        return existing;
      }
      const parsed = parseWithBackend(bytes, options.backend ?? defaultBackend);
      registry.register(parsed.contentHash, parsed);
      return parsed;
    });
    registrations.push({ ready });
    return { ready };
  }

  return {
    registerBytes,
    registerPending,
    resolve: (contentHash) => registry.resolve(contentHash),
    has: (contentHash) => registry.has(contentHash),
    pendingRegistrations: () => registrations.slice(),
  };
}
