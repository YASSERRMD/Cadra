import * as opentype from "opentype.js";

/** One command of a glyph's vector outline, in the same em-normalized, Y-up space every other coordinate this package produces uses. */
export type GlyphPathCommand =
  | { type: "move"; x: number; y: number }
  | { type: "line"; x: number; y: number }
  | { type: "quadratic"; x1: number; y1: number; x: number; y: number }
  | { type: "cubic"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: "close" };

const glyphSourceCache = new Map<string, opentype.Font>();

function getOpentypeFont(bytes: Uint8Array, contentHash: string): opentype.Font {
  const cached = glyphSourceCache.get(contentHash);
  if (cached !== undefined) {
    return cached;
  }
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const font = opentype.parse(arrayBuffer);
  glyphSourceCache.set(contentHash, font);
  return font;
}

/**
 * Extracts a glyph's vector outline by glyph id (not code point - `Font.glyphs.get`
 * is index-based, unlike MSDF atlas generation's code-point-driven loader), for
 * building extruded 3D geometry (Phase 44's optional depth mode).
 *
 * opentype.js's own `Glyph.getPath(x, y, fontSize)` outputs Y-down coordinates
 * (it is designed for drawing onto an HTML5 Canvas 2D context, whose Y axis
 * increases downward), verified empirically against this fixture: a capital
 * letter's bounding box came out almost entirely at negative Y. Every Y
 * ordinate here is negated to match this package's Y-up convention (the one
 * HarfBuzz, fontkit, and `msdfgen-wasm` all use) so a glyph rendered from
 * this path lines up with the same glyph's flat MSDF quad.
 */
export function getGlyphPathCommands(
  bytes: Uint8Array,
  contentHash: string,
  glyphId: number,
): GlyphPathCommand[] {
  const font = getOpentypeFont(bytes, contentHash);
  const glyph = font.glyphs.get(glyphId);
  const path = glyph.getPath(0, 0, 1);

  return path.commands.map((command): GlyphPathCommand => {
    switch (command.type) {
      case "M":
        return { type: "move", x: command.x, y: -command.y };
      case "L":
        return { type: "line", x: command.x, y: -command.y };
      case "Q":
        return { type: "quadratic", x1: command.x1, y1: -command.y1, x: command.x, y: -command.y };
      case "C":
        return {
          type: "cubic",
          x1: command.x1,
          y1: -command.y1,
          x2: command.x2,
          y2: -command.y2,
          x: command.x,
          y: -command.y,
        };
      case "Z":
        return { type: "close" };
    }
  });
}
