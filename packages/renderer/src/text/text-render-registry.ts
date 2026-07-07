import { resolveVariationAxesProperty, type TextNode } from "@cadra/core";
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
 * The cache key a `TextRenderRegistry` is keyed by for a given `TextNode`
 * at a given `frame`: `fontRef` (or `"default"` when omitted), `content`,
 * and `node.variationAxes` resolved at that frame. `fontSize` never
 * contributes (glyph layout is computed in font-size-independent em units;
 * see `computeGlyphLayout`), and neither does anything else `frame`-varying
 * on a `TextNode` (`stagger`/`physics`/`path` are all applied to
 * already-shaped glyphs per frame, not something shaping itself needs to
 * redo - see `apply-text-effects.ts`) - `variationAxes` is the one
 * exception, and the only reason this key needs `frame` at all now: unlike
 * every other keyframeable `TextNode` field, animating it smoothly means a
 * genuinely different resolved instance (different glyph *outlines*, not
 * just a different advance width - see `variationAxes`'s own doc in
 * `@cadra/core`) at each distinct sampled frame, so whatever prepares and
 * registers a node's `TextRenderEntry` ahead of time must derive one entry
 * per distinct resolved value, the same "ahead of a `reconcile` call, not
 * during one" cost `content` itself would already pay if it were keyframed.
 *
 * A plain `JSON.stringify` (not a content hash): all three fields are
 * already small, directly-comparable data, so there is nothing a hash
 * would buy over a direct string encoding - mirroring
 * `computeSatoriLayerRenderKey`'s own identical reasoning.
 */
export function computeTextNodeRenderKey(
  node: Pick<TextNode, "fontRef" | "content" | "variationAxes">,
  frame: number,
): string {
  return JSON.stringify({
    fontRef: node.fontRef ?? "default",
    content: node.content,
    variationAxes: node.variationAxes !== undefined ? resolveVariationAxesProperty(node.variationAxes, frame) : null,
  });
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
