import type { TextNode } from "@cadra/core";
// From the browser-safe entry for consistency with build-text-group.ts;
// this is a type-only import either way (fully erased at build time), but
// see that module's own comment for why the value-importing half of this
// package's text code must not use the bare "@cadra/text" barrel.
import type { TextRenderData } from "@cadra/text/browser";

/** Everything the reconciler needs to build one `TextNode`'s Object3D: laid-out glyphs/atlas pages, plus the source font's own bytes (only actually read for the optional extrusion path). */
export interface TextRenderEntry {
  data: TextRenderData;
  fontBytes: Uint8Array;
  fontContentHash: string;
}

/**
 * Resolves a `TextNode` to its already-prepared `TextRenderEntry` (shaped,
 * atlas-generated, and laid out - see `@cadra/text`'s `prepareTextRenderData`).
 * Resolve-only, mirroring `GeometryRegistry`/`MaterialRegistry`'s own
 * contract (`packages/renderer/src/reconciler/registries.ts`): something
 * else prepares and registers entries ahead of a `reconcile` call (font
 * loading, shaping, and MSDF atlas generation are all async; a reconciler's
 * own `createThreeObject`/`applyNodeProperties` are not), the same "not yet
 * loaded is an expected runtime state, not a programming error" shape
 * `image`/`video` nodes are still waiting on their own asset pipeline wiring
 * to reach.
 */
export interface TextRenderRegistry {
  resolve(cacheKey: string): TextRenderEntry | undefined;
}

/** A `TextRenderRegistry` a caller can also populate. */
export interface MutableTextRenderRegistry extends TextRenderRegistry {
  register(cacheKey: string, entry: TextRenderEntry): void;
}

/**
 * The cache key a `TextRenderRegistry` is keyed by for a given `TextNode`:
 * just its `fontRef` (or `"default"` when omitted) and `content`, since
 * `fontSize` never affects which glyphs are shaped/atlased (glyph layout is
 * computed in font-size-independent em units; see `computeGlyphLayout`).
 * Whatever prepares and registers a node's `TextRenderEntry` ahead of time
 * must derive its registration key with this exact function too.
 */
export function computeTextNodeRenderKey(node: Pick<TextNode, "fontRef" | "content">): string {
  return `${node.fontRef ?? "default"}::${node.content}`;
}

/** A simple in-memory `MutableTextRenderRegistry`, backed by a `Map`. */
export function createInMemoryTextRenderRegistry(): MutableTextRenderRegistry {
  const entries = new Map<string, TextRenderEntry>();

  return {
    resolve(cacheKey: string): TextRenderEntry | undefined {
      return entries.get(cacheKey);
    },
    register(cacheKey: string, entry: TextRenderEntry): void {
      entries.set(cacheKey, entry);
    },
  };
}
