/**
 * @cadra/text/browser
 *
 * The subset of this package's surface that is safe to bundle into a
 * browser-executed context (the headless render page `packages/encode`'s
 * `browser-headless-render-entry.ts` bundles via esbuild, and `packages/renderer`
 * consumes from there): pure data types plus `getGlyphPathCommands`
 * (backed by `opentype.js`, which unlike `fontkit`/`harfbuzzjs`/
 * `msdfgen-wasm`/`subset-font` has no Node-specific (`fs`/`module`/
 * `createRequire`) code path.
 *
 * Shaping (`shapeText`, `harfbuzzjs`) and MSDF atlas generation
 * (`generateMsdfAtlas`, `msdfgen-wasm`) are deliberately not re-exported
 * here even though some of their own dependencies (`harfbuzzjs`) do run in
 * a browser in principle: verified empirically that bundling them via
 * esbuild (this package's main "." entry pulls in `fontkit`'s Node
 * `Buffer` usage, `msdfgen-wasm`'s `createRequire`, and `subset-font`'s
 * `fs`/`fontverter`, none of which resolve for a browser target) breaks
 * `packages/headless`'s existing `bundleBrowserEntry`. This is also the
 * intended architecture regardless: shaping and atlas generation are meant
 * to run once, ahead of time (wherever `prepareTextRenderData` is called,
 * e.g. server-side), with the result handed to the renderer as plain
 * `TextRenderData` through `TextRenderRegistry` - the render page itself
 * only ever needs to consume that data, plus (for the optional extrusion
 * path) real glyph outlines by id.
 */
export type { GlyphLayoutOptions, GlyphLayoutResult, PositionedGlyph } from "./glyph-layout.js";
export { computeGlyphLayout } from "./glyph-layout.js";
export type { GlyphPathCommand } from "./glyph-path.js";
export { getGlyphPathCommands } from "./glyph-path.js";
export type {
  MsdfAtlas,
  MsdfAtlasOptions,
  MsdfAtlasPage,
  MsdfFontMetrics,
  MsdfGlyphPlacement,
} from "./msdf-atlas.js";
// Type-only, same as every other re-export here: the paragraph layout
// engine's own value exports (layoutParagraphLines, harfbuzzjs-backed;
// prepareParagraphRenderData, msdfgen-wasm-backed) stay out of this browser
// entry for the same reason shapeText/generateMsdfAtlas do (see this
// module's own doc), but ParagraphRenderData's shape is a superset of
// TextRenderData's (adds per-line metrics; each glyph's resolved style is
// already PositionedGlyph's own optional `color`), so a renderer can type
// against it without pulling in either Node-only implementation.
export type { ParagraphLineMetrics } from "./paragraph-layout.js";
export type { ParagraphRenderData } from "./paragraph-render-data.js";
export type { FontParseBackend, ParsedFont } from "./parsed-font.js";
export type { ShapedGlyph, ShapedTextRun } from "./shaped-run.js";
export type { PrepareTextRenderDataOptions, TextRenderData } from "./text-render-data.js";
