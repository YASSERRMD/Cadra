import type { ColorRGBA } from "@cadra/core";
// From the browser-safe entry, not the bare "@cadra/text" barrel: this
// module is part of packages/renderer's own code path that
// packages/headless bundles into the browser-executed render page (via
// esbuild); the main "." entry pulls in fontkit/harfbuzzjs/msdfgen-wasm/
// subset-font, none of which resolve for a browser target. See
// @cadra/text's own browser.ts module doc for the full explanation.
import { getGlyphPathCommands, type GlyphPathCommand, type TextRenderData } from "@cadra/text/browser";
import * as THREE from "three";

import { createMsdfTextMaterial, type MsdfTextMaterialHandle } from "./msdf-material.js";

/** Everything `buildTextGroup` allocated, so the reconciler can dispose exactly these resources (and no shared/pooled ones) when a text node's content changes or is removed. */
export interface TextGroupResources {
  group: THREE.Group;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  textures: THREE.Texture[];
  /**
   * Updates every material this group uses to a new color, whichever
   * rendering path built them: the flat path's `MeshBasicNodeMaterial`s
   * hold their color in a TSL uniform node (see `msdf-material.ts`), not
   * the classic `.color` property, so a caller must go through this rather
   * than mutating `materials` directly.
   */
  setColor: (r: number, g: number, b: number, a: number) => void;
}

/** A font's raw bytes plus its own content hash, the minimum `buildTextGroup` needs to extrude real glyph outlines. */
export interface ExtrusionFontSource {
  bytes: Uint8Array;
  contentHash: string;
}

export interface BuildTextGroupOptions {
  color: ColorRGBA;
  /** Extrusion depth in em units (the same units `TextRenderData`'s glyph positions are already in). `0`, `undefined`, or no `font` renders flat MSDF quads instead. */
  extrudeDepth?: number;
  font?: ExtrusionFontSource;
}

/**
 * Builds the `Group(line) -> Group(word) -> Mesh(glyph)` hierarchy for one
 * text node's already-prepared `TextRenderData`, in em space (the caller
 * scales the returned root `group` by the node's own `fontSize` and applies
 * its authored transform on top, same as every other node kind).
 *
 * Two independent rendering paths: flat MSDF-textured quads (the default -
 * crisp at any scale, one material per atlas page, shared across every
 * glyph sampling that page) or, when `options.extrudeDepth` is positive and
 * a font source is given, real solid `THREE.ExtrudeGeometry` built from the
 * font's own outlines (`getGlyphPathCommands`) - lit and shadowed like any
 * other mesh, unlike the unlit flat quads.
 */
export function buildTextGroup(
  data: TextRenderData,
  options: BuildTextGroupOptions,
): TextGroupResources {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];

  const extrudeDepth = options.extrudeDepth ?? 0;
  const useExtrusion = extrudeDepth > 0 && options.font !== undefined;

  const lineGroups = new Map<number, THREE.Group>();
  const wordGroups = new Map<string, THREE.Group>();

  function getLineGroup(lineIndex: number): THREE.Group {
    let lineGroup = lineGroups.get(lineIndex);
    if (lineGroup === undefined) {
      lineGroup = new THREE.Group();
      lineGroup.name = `line-${lineIndex}`;
      group.add(lineGroup);
      lineGroups.set(lineIndex, lineGroup);
    }
    return lineGroup;
  }

  function getWordGroup(lineIndex: number, wordIndex: number): THREE.Group {
    const key = `${lineIndex}:${wordIndex}`;
    let wordGroup = wordGroups.get(key);
    if (wordGroup === undefined) {
      wordGroup = new THREE.Group();
      wordGroup.name = `word-${key}`;
      getLineGroup(lineIndex).add(wordGroup);
      wordGroups.set(key, wordGroup);
    }
    return wordGroup;
  }

  if (useExtrusion) {
    const font = options.font as ExtrusionFontSource;
    const materialsByColorKey = new Map<string, THREE.MeshStandardMaterial>();
    // Every glyph resolving to the node's own base color (no inline-style
    // override) shares one tracked material, so setColor can still update
    // it live without rebuilding geometry; a glyph with its own resolved
    // color (Phase 45's inline style spans, see PositionedGlyph.color's own
    // doc) gets its own material instead, fixed at that color regardless
    // of the node's own animated color.
    const baseMaterials = new Set<THREE.MeshStandardMaterial>();

    function getExtrusionMaterial(color: ColorRGBA, isBaseColor: boolean): THREE.MeshStandardMaterial {
      const key = colorKey(color);
      let material = materialsByColorKey.get(key);
      if (material === undefined) {
        material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(color[0], color[1], color[2]),
          transparent: color[3] < 1,
          opacity: color[3],
        });
        materialsByColorKey.set(key, material);
        materials.push(material);
      }
      if (isBaseColor) {
        baseMaterials.add(material);
      }
      return material;
    }

    for (const glyph of data.glyphs) {
      const commands = getGlyphPathCommands(font.bytes, font.contentHash, glyph.glyphId);
      const shape = pathCommandsToShapes(commands);
      if (shape.length === 0) {
        continue;
      }
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: extrudeDepth, bevelEnabled: false });
      geometries.push(geometry);
      const material = getExtrusionMaterial(glyph.color ?? options.color, glyph.color === undefined);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `glyph-${glyph.cluster}-${glyph.glyphId}`;
      mesh.position.set(glyph.origin.x, glyph.origin.y, -extrudeDepth / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      getWordGroup(glyph.lineIndex, glyph.wordIndex).add(mesh);
    }
    return {
      group,
      geometries,
      materials,
      textures,
      setColor: (r, g, b, a) => {
        for (const material of baseMaterials) {
          material.color.setRGB(r, g, b);
          material.opacity = a;
          material.transparent = a < 1;
        }
      },
    };
  }

  const texturesByPage = data.atlasPages.map((page) => {
    const texture = new THREE.DataTexture(page.pixels, page.width, page.height, THREE.RGBAFormat);
    texture.flipY = false;
    texture.needsUpdate = true;
    textures.push(texture);
    return texture;
  });

  const materialHandlesByKey = new Map<string, MsdfTextMaterialHandle>();
  const baseMaterialHandles = new Set<MsdfTextMaterialHandle>();

  function getMsdfMaterialHandle(page: number, color: ColorRGBA, isBaseColor: boolean): MsdfTextMaterialHandle | undefined {
    const texture = texturesByPage[page];
    if (texture === undefined) {
      return undefined;
    }
    const key = `${page}:${colorKey(color)}`;
    let handle = materialHandlesByKey.get(key);
    if (handle === undefined) {
      handle = createMsdfTextMaterial(texture);
      handle.setColor(color[0], color[1], color[2], color[3]);
      materials.push(handle.material);
      materialHandlesByKey.set(key, handle);
    }
    if (isBaseColor) {
      baseMaterialHandles.add(handle);
    }
    return handle;
  }

  for (const glyph of data.glyphs) {
    const handle = getMsdfMaterialHandle(glyph.page, glyph.color ?? options.color, glyph.color === undefined);
    if (handle === undefined) {
      continue;
    }
    const width = glyph.quad.right - glyph.quad.left;
    const height = glyph.quad.top - glyph.quad.bottom;
    const geometry = new THREE.PlaneGeometry(width, height);
    applyGlyphUv(geometry, glyph.uv);
    geometries.push(geometry);

    const mesh = new THREE.Mesh(geometry, handle.material);
    mesh.name = `glyph-${glyph.cluster}-${glyph.glyphId}`;
    mesh.position.set(
      (glyph.quad.left + glyph.quad.right) / 2,
      (glyph.quad.bottom + glyph.quad.top) / 2,
      0,
    );
    getWordGroup(glyph.lineIndex, glyph.wordIndex).add(mesh);
  }

  return {
    group,
    geometries,
    materials,
    textures,
    setColor: (r, g, b, a) => {
      for (const handle of baseMaterialHandles) {
        handle.setColor(r, g, b, a);
      }
    },
  };
}

/** A stable string key for a color, so glyphs resolving to the same color (whether both defaulting to the node's own base color, or coincidentally equal overrides) correctly share one material instead of each allocating its own. */
function colorKey(color: ColorRGBA): string {
  return color.join(",");
}

/** Rewrites a `PlaneGeometry`'s default full-`[0,1]` UVs to sample exactly one glyph's rectangle in the atlas. */
function applyGlyphUv(
  geometry: THREE.PlaneGeometry,
  uvRect: { u0: number; v0: number; u1: number; v1: number },
): void {
  // THREE.PlaneGeometry's 4 vertices are ordered bottom-left, bottom-right,
  // top-left, top-right; its default uv attribute is [0,0, 1,0, 0,1, 1,1].
  const uv = new Float32Array([
    uvRect.u0,
    uvRect.v1,
    uvRect.u1,
    uvRect.v1,
    uvRect.u0,
    uvRect.v0,
    uvRect.u1,
    uvRect.v0,
  ]);
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/** Replays one contour's commands onto any `THREE.Path`-shaped target (both `THREE.Path` and `THREE.Shape` support the same drawing calls, `Shape` being a `Path` subclass). */
function drawContour(target: THREE.Path, commands: readonly GlyphPathCommand[]): void {
  for (const command of commands) {
    switch (command.type) {
      case "move":
        target.moveTo(command.x, command.y);
        break;
      case "line":
        target.lineTo(command.x, command.y);
        break;
      case "quadratic":
        target.quadraticCurveTo(command.x1, command.y1, command.x, command.y);
        break;
      case "cubic":
        target.bezierCurveTo(command.x1, command.y1, command.x2, command.y2, command.x, command.y);
        break;
      case "close":
        target.closePath();
        break;
    }
  }
}

interface ContourBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boundsOf(points: readonly THREE.Vector2[]): ContourBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

function boundsArea(bounds: ContourBounds): number {
  return (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
}

function fullyContains(outer: ContourBounds, inner: ContourBounds): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  );
}

/**
 * Converts a glyph's path commands (see `getGlyphPathCommands`) into
 * `THREE.Shape`s, correctly distinguishing outer contours from holes (a
 * letter like "O", "A", or "e" has a hole for its counter, "B"/"8" have
 * two) rather than treating every contour as its own independent solid,
 * which would extrude a hole as a second overlapping solid instead of a
 * cutout.
 *
 * Determined by bounding-box containment (a contour is a hole of the
 * smallest other contour whose bounding box fully contains it; a contour
 * contained by no other is its own outer shape), not contour winding
 * direction/signed area: verified empirically against this codebase's own
 * fixture font that outer-vs-hole winding is not consistently one
 * direction across glyphs (e.g. "A"'s outer contour and its triangular
 * counter/hole wind the same direction, while "O"'s wind oppositely), so a
 * signed-area-based rule silently produces a wrong (non-cutout) result for
 * some letters. Containment correctly handles both holes and multi-part
 * glyphs (e.g. "i"'s dot, ":"'s two dots) without depending on winding at all.
 */
function pathCommandsToShapes(commands: readonly GlyphPathCommand[]): THREE.Shape[] {
  const contours: GlyphPathCommand[][] = [];
  for (const command of commands) {
    if (command.type === "move") {
      contours.push([command]);
    } else {
      contours[contours.length - 1]?.push(command);
    }
  }
  if (contours.length === 0) {
    return [];
  }

  const bounds = contours.map((contour) => {
    const probe = new THREE.Path();
    drawContour(probe, contour);
    return boundsOf(probe.getPoints());
  });

  // For each contour, its container is the smallest-area other contour
  // whose bounds fully contain it, if any.
  const containerIndex: (number | undefined)[] = contours.map((_, index) => {
    let best: number | undefined;
    let bestArea = Infinity;
    for (let candidate = 0; candidate < contours.length; candidate += 1) {
      if (candidate === index) {
        continue;
      }
      const candidateBounds = bounds[candidate] as ContourBounds;
      if (fullyContains(candidateBounds, bounds[index] as ContourBounds)) {
        const area = boundsArea(candidateBounds);
        if (area < bestArea) {
          bestArea = area;
          best = candidate;
        }
      }
    }
    return best;
  });

  const shapesByContourIndex = new Map<number, THREE.Shape>();
  contours.forEach((contour, index) => {
    if (containerIndex[index] === undefined) {
      const shape = new THREE.Shape();
      drawContour(shape, contour);
      shapesByContourIndex.set(index, shape);
    }
  });
  contours.forEach((contour, index) => {
    const container = containerIndex[index];
    if (container !== undefined) {
      const hole = new THREE.Path();
      drawContour(hole, contour);
      shapesByContourIndex.get(container)?.holes.push(hole);
    }
  });

  return Array.from(shapesByContourIndex.values());
}
