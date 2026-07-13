import type { Glyph as MsdfGlyph } from "msdfgen-wasm";

import { Bitmap, getMsdfgenInstance } from "./msdfgen-instance.js";
import type { ParsedFont } from "./parsed-font.js";

/** Where one glyph landed in the packed atlas, plus the MSDF parameters needed to sample it correctly. */
export interface MsdfGlyphPlacement {
  glyphId: number;
  /** Index into `MsdfAtlas.pages` this glyph was packed into. */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotated: boolean;
  /** MSDF distance-field range, in the same normalized em units as `MsdfAtlas.metrics`. */
  range: number;
  /** Glyph-space to atlas-pixel-space scale factor. */
  scale: number;
  xTranslate: number;
  yTranslate: number;
}

/** One packed atlas texture: an RGBA multi-channel signed distance field, deterministic for the same inputs. */
export interface MsdfAtlasPage {
  width: number;
  height: number;
  /** Raw RGBA8 pixels, row-major, top-to-bottom, `width * height * 4` bytes: the direct GPU texture upload path, needing no image decoder in any environment. */
  pixels: Uint8Array;
  /** The same pixels, PNG-encoded, for on-disk caching or debugging. */
  png: Uint8Array;
}

/** Font metrics in the same normalized em-unit space `MsdfGlyphPlacement`'s translate/scale values use. */
export interface MsdfFontMetrics {
  emSize: number;
  ascenderY: number;
  descenderY: number;
  lineHeight: number;
  underlineY: number;
  underlineThickness: number;
  spaceAdvance: number;
  tabAdvance: number;
}

export interface MsdfAtlas {
  pages: readonly MsdfAtlasPage[];
  glyphs: readonly MsdfGlyphPlacement[];
  /**
   * Requested glyph ids this font has no code point for in its own
   * `characterSet` (see the module doc on this driving-by-codepoint
   * limitation), so no placement could be generated for them.
   */
  missingGlyphIds: readonly number[];
  metrics: MsdfFontMetrics;
}

export interface MsdfAtlasOptions {
  /** MSDF pixel size per em (glyph height in the generated bitmap, roughly). Defaults to 42. */
  fontSize?: number;
  /** Distance field range in pixels. Defaults to 4. */
  range?: number;
  maxWidth?: number;
  maxHeight?: number;
  padding?: number;
}

const DEFAULT_FONT_SIZE = 42;
const DEFAULT_RANGE = 4;
const DEFAULT_MAX_ATLAS_DIMENSION = 2048;
const DEFAULT_PADDING = 2;

/**
 * Generates an MSDF (multi-channel signed distance field) atlas containing
 * exactly the glyphs in `usedGlyphIds` (driven by Phase 42's shaped runs),
 * so unused glyphs never cost atlas space or generation time.
 *
 * `msdfgen-wasm`'s glyph loader resolves glyphs by Unicode code point (via
 * the font's own `cmap`), not by arbitrary glyph id - there is no published
 * API to load an arbitrary glyph id directly. This drives loading from the
 * font's own `characterSet` (every code point it has a `cmap` entry for),
 * then filters down to exactly the requested glyph ids by cross-referencing
 * each resolved glyph's own `.index` (a font-intrinsic, tool-independent
 * numbering: the same glyph index HarfBuzz's shaped output uses, verified
 * empirically against a shared fixture font). The (cheap) code-point-to-index
 * resolution pass touches the whole character set; the (expensive) MSDF
 * bitmap generation pass, via `packGlyphs`'s own `glyphs` override, only
 * ever runs over the filtered, actually-used subset. Known limitation: a
 * glyph reachable only through GSUB substitution (some ligatures, some
 * Arabic contextual forms) and not through any code point in the font's own
 * `characterSet` cannot be resolved this way and is reported in
 * `missingGlyphIds` instead of silently omitted.
 */
export async function generateMsdfAtlas(
  font: ParsedFont,
  usedGlyphIds: ReadonlySet<number>,
  options: MsdfAtlasOptions = {},
): Promise<MsdfAtlas> {
  const msdfgen = await getMsdfgenInstance();
  msdfgen.loadFont(font.bytes);
  msdfgen.loadGlyphs(Array.from(font.characterSet));

  const resolvedByIndex = new Map<number, MsdfGlyph>();
  for (const glyph of msdfgen.glyphs) {
    resolvedByIndex.set(glyph.index, glyph);
  }

  // A resolved glyph with a degenerate (zero-area) bounding box - a space,
  // a zero-width joiner, most control characters - has no ink to pack.
  // Handing even one of these to `packGlyphs` below is safe in isolation
  // (msdfgen-wasm's own maxrects-packer just gives it a 0x0 rect), but
  // handing it a `glyphsToPack` that ends up *entirely* ink-less corrupts
  // this cached `Msdfgen` instance's internal glyph state: the packed bin
  // comes back 0x0 (harmless on its own), but the *next* `loadFont` call on
  // this same instance then crashes inside its own native `unloadGlyphs`
  // cleanup with a WASM "memory access out of bounds" fault - verified
  // empirically (isolated repro: pack only a space character, then pack
  // anything else on the same instance). Filtering these out here, before
  // they ever reach `packGlyphs`, sidesteps the corruption outright rather
  // than working around its symptom. This is safe to skip unconditionally
  // (not just when it would otherwise produce an all-empty bin): a glyph
  // that never gets a placement is already exactly how `placeGlyphQuad`
  // (glyph-layout.ts) treats a placement with `width<=0 || height<=0` -
  // skip the quad, still advance the pen from the shaped run's own advance.
  const glyphsToPack: MsdfGlyph[] = [];
  const missingGlyphIds: number[] = [];
  for (const glyphId of usedGlyphIds) {
    const resolved = resolvedByIndex.get(glyphId);
    if (resolved === undefined) {
      missingGlyphIds.push(glyphId);
    } else if (resolved.right > resolved.left && resolved.top > resolved.bottom) {
      glyphsToPack.push(resolved);
    }
  }

  const bins = msdfgen.packGlyphs(
    { size: options.fontSize ?? DEFAULT_FONT_SIZE, range: options.range ?? DEFAULT_RANGE },
    {
      maxWidth: options.maxWidth ?? DEFAULT_MAX_ATLAS_DIMENSION,
      maxHeight: options.maxHeight ?? DEFAULT_MAX_ATLAS_DIMENSION,
      padding: options.padding ?? DEFAULT_PADDING,
    },
    glyphsToPack,
  );

  const pages: MsdfAtlasPage[] = [];
  const glyphs: MsdfGlyphPlacement[] = [];
  bins.forEach((bin, page) => {
    // Composite this bin's glyphs onto one Bitmap ourselves (mirroring
    // msdfgen-wasm's own createAtlasImage) so the raw RGBA pixels are
    // available directly, not only reachable by decoding a PNG back.
    //
    // A bin comes back 0x0 when every glyph packed into it has no ink (e.g.
    // the only used glyph is a space, or every requested glyph fell back to
    // .notdef and got filtered into missingGlyphIds upstream) - geometrically
    // a bin can only be smaller than some glyph it contains if that glyph
    // itself has zero width/height, so a 0x0 bin means every rect in it is
    // 0x0 too. `placeGlyphQuad` (glyph-layout.ts) already skips any glyph
    // with width<=0 or height<=0, so no real glyph quad ever samples this
    // page's texture - substitute a trivial 1x1 transparent bitmap so the
    // page stays a valid GPU texture downstream; msdfgen's own `createPng`
    // rejects a literal 0x0 image outright.
    const pageWidth = bin.width > 0 ? bin.width : 1;
    const pageHeight = bin.height > 0 ? bin.height : 1;
    const composited = new Bitmap(pageWidth, pageHeight);
    for (const rect of bin.rects) {
      if (rect.width > 0 && rect.height > 0) {
        const glyphBitmap = msdfgen.generateBitmap(rect.glyph, rect.msdfData);
        composited.blit(glyphBitmap, rect.x, rect.y, rect.rot);
      }
    }
    pages.push({
      width: pageWidth,
      height: pageHeight,
      pixels: new Uint8Array(composited.buffer),
      png: msdfgen.createPng(composited, 9),
    });
    for (const rect of bin.rects) {
      glyphs.push({
        glyphId: rect.glyph.index,
        page,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        rotated: rect.rot,
        range: rect.msdfData.range,
        scale: rect.msdfData.scale,
        xTranslate: rect.msdfData.xTranslate,
        yTranslate: rect.msdfData.yTranslate,
      });
    }
  });

  return { pages, glyphs, missingGlyphIds, metrics: msdfgen.metrics };
}
