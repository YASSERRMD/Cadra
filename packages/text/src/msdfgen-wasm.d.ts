/**
 * `msdfgen-wasm@1.0.0` ships real hand-written `.d.ts` files
 * (`dist/types/*.d.ts`), but its `package.json` `exports` map declares only
 * `require`/`import` conditions with no `types` condition, so a
 * strict-`exports`-respecting resolver (this project's
 * `moduleResolution: "bundler"` included) cannot reach them at all -
 * verified empirically (`tsc` reports `TS7016` even though the `.d.ts`
 * files are sitting right there in `node_modules`). Declared here instead,
 * transcribed faithfully from those real `dist/types/*.d.ts` files rather
 * than guessed.
 */
declare module "msdfgen-wasm" {
  export class Bitmap {
    readonly width: number;
    readonly height: number;
    readonly data: Uint32Array;
    constructor(width: number, height: number, data?: ArrayBuffer);
    blit(source: Bitmap, dx: number, dy: number, rotated: boolean): void;
    get buffer(): ArrayBufferLike;
  }

  export interface MsdfOptions {
    size: number;
    range: number;
    scanline?: boolean;
    edgeColoring?: "simple" | "inktrap" | "distance";
    edgeThresholdAngle?: number;
  }

  /** Mirrors `AtlasOptions extends MaxRectsPackerOptions` from the real (unreachable-via-exports) upstream types: `maxrects-packer`'s own `IOption` fields, inlined rather than imported to keep this ambient shim self-contained. */
  export interface AtlasOptions {
    maxWidth: number;
    maxHeight: number;
    padding: number;
    smart?: boolean;
    pot?: boolean;
    square?: boolean;
    allowRotation?: boolean;
    tag?: boolean;
    exclusiveTag?: boolean;
    border?: number;
  }

  export interface FontMetrics {
    emSize: number;
    ascenderY: number;
    descenderY: number;
    lineHeight: number;
    underlineY: number;
    underlineThickness: number;
    spaceAdvance: number;
    tabAdvance: number;
  }

  export interface Glyph {
    unicode: number;
    index: number;
    advance: number;
    left: number;
    bottom: number;
    right: number;
    top: number;
    kerning: Array<[Glyph, number]>;
  }

  export interface MsdfData {
    scale: number;
    xTranslate: number;
    yTranslate: number;
    range: number;
    edgeColoring: "simple" | "inktrap" | "distance";
    edgeThresholdAngle: number;
    width: number;
    height: number;
    scanline: boolean;
  }

  export interface PackedGlyphRectangle {
    x: number;
    y: number;
    width: number;
    height: number;
    rot: boolean;
    oversized: boolean;
    glyph: Glyph;
    msdfData: MsdfData;
  }

  export interface PackedGlyphsBin {
    width: number;
    height: number;
    rects: PackedGlyphRectangle[];
  }

  export class Msdfgen {
    static create(wasm: ArrayBufferLike): Promise<Msdfgen>;
    private constructor();
    loadFont(data: Uint8Array, characters?: number[]): void;
    computeGlpyhMsdfData(glyph: Glyph, options: MsdfOptions): MsdfData;
    loadGlyphs(characters: number[], options?: { preprocess: boolean }): void;
    generateBitmap(glyph: Glyph, config: MsdfData): Bitmap;
    createPng(bitmap: Bitmap, compressionLevel?: number): Uint8Array;
    packGlyphs(msdfOptions: MsdfOptions, atlasOptions: AtlasOptions, glyphs?: Glyph[]): PackedGlyphsBin[];
    createAtlasImage(bin: PackedGlyphsBin): Uint8Array;
    createGlyphImage(glyph: Glyph, msdfOptions: MsdfOptions): Uint8Array;
    getGlyph(unicode: number): Glyph;
    get glyphs(): readonly Glyph[];
    get metrics(): FontMetrics;
  }
}
