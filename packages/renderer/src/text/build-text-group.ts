import type {
  ColorRGBA,
  ResolvedTextFill,
  ResolvedTextGlow,
  ResolvedTextOutline,
  ResolvedTextShadow,
  WhiteBalanceGain,
} from "@cadra/core";
// From the browser-safe entry, not the bare "@cadra/text" barrel: this
// module is part of packages/renderer's own code path that
// packages/headless bundles into the browser-executed render page (via
// esbuild); the main "." entry pulls in fontkit/harfbuzzjs/msdfgen-wasm/
// subset-font, none of which resolve for a browser target. See
// @cadra/text's own browser.ts module doc for the full explanation.
import { getGlyphPathCommands, type GlyphPathCommand, type PositionedGlyph, type TextRenderData } from "@cadra/text/browser";
import * as THREE from "three";

import { resolveSceneColor } from "../color/resolve-scene-color.js";
import { createMsdfTextMaterial, type MsdfMaterialConfig, type MsdfTextMaterialHandle } from "./msdf-material.js";

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
   * than mutating `materials` directly. For a gradient `fill` specifically,
   * this sets the *solid* base color that a texture/video fill still falls
   * back to (see `TextFill`'s own doc); use `setFill` for the gradient
   * itself.
   */
  setColor: (r: number, g: number, b: number, a: number) => void;
  /** Present only when `BuildTextGroupOptions.fill` was a gradient at build time (a structural, build-time-only choice - see `msdf-material.ts`). */
  setFill?: (fill: ResolvedTextFill) => void;
  /** Present only when `BuildTextGroupOptions.outline` was set at build time. */
  setOutline?: (outline: ResolvedTextOutline) => void;
  /** Present only when `BuildTextGroupOptions.glow` was set at build time. */
  setGlow?: (glow: ResolvedTextGlow) => void;
  /** Present only when `BuildTextGroupOptions.shadow` was set at build time. Cannot change `steps` (how many duplicate shadow meshes exist is fixed at build time); updates every other field on the already-built set. */
  setShadow?: (shadow: ResolvedTextShadow) => void;
}

/** A font's raw bytes plus its own content hash, the minimum `buildTextGroup` needs to extrude real glyph outlines. */
export interface ExtrusionFontSource {
  bytes: Uint8Array;
  contentHash: string;
}

export interface BuildTextGroupOptions {
  color: ColorRGBA;
  /**
   * This composition's own white-balance correction gain (see
   * `resolveSceneColor`), applied to every color this function resolves
   * into a Three.js color/uniform - `color` itself, every glyph's own
   * inline-style override, and every `fill`/`outline`/`glow`/`shadow`
   * color. Captured once here, at build time (a structural, build-time-only
   * choice, same as `perGlyphMaterial`): a composition's own `colorGrading`
   * is not itself frame-dependent (see `Composition.colorGrading`'s own
   * doc), so there is nothing to re-resolve per frame. Defaults to a no-op
   * `(1, 1, 1)` gain when omitted, matching every other optional field on
   * this same options object.
   */
  whiteBalanceGain?: WhiteBalanceGain;
  /** Extrusion depth in em units (the same units `TextRenderData`'s glyph positions are already in). `0`, `undefined`, or no `font` renders flat MSDF quads instead. */
  extrudeDepth?: number;
  font?: ExtrusionFontSource;
  /**
   * Gives every glyph its own material instance instead of sharing one per
   * `(atlas page, resolved color)` (flat path) or per resolved color
   * (extrusion path). A `TextNode` with a `stagger` config needs this: a
   * per-unit staggered opacity fade (`apply-text-stagger.ts`) sets
   * `material.opacity` directly, which would otherwise bleed across every
   * other glyph sharing that same material regardless of which stagger
   * unit it belongs to. `setColor` still updates every base-color material
   * uniformly either way, just across more distinct instances. Defaults to
   * `false` (the shared-material optimization), since most `TextNode`s
   * never stagger and gain nothing from paying this cost.
   */
  perGlyphMaterial?: boolean;
  /**
   * A richer fill than a flat `color`, for the flat MSDF rendering path
   * only (the extruded path always uses a plain `THREE.MeshStandardMaterial`
   * lit by scene lights, which has no analogous notion of a 2D gradient
   * fill). A `"texture"`/`"video"` fill (real per-pixel sampling not yet
   * wired anywhere in this renderer - see `TextFill`'s own doc) falls back
   * to plain `color`, matching `ImageNode`/`VideoNode`'s own existing
   * placeholder precedent. Omitted means a plain solid fill using `color`.
   */
  fill?: ResolvedTextFill;
  outline?: ResolvedTextOutline;
  glow?: ResolvedTextGlow;
  shadow?: ResolvedTextShadow;
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

  /** Converts one authored `ColorRGBA` into this composition's own linear, white-balanced working color - see `resolveSceneColor`'s own doc. The single point every color this function touches passes through. */
  const whiteBalanceGain = options.whiteBalanceGain ?? [1, 1, 1];
  const toScene = (color: ColorRGBA) => resolveSceneColor(color, whiteBalanceGain);

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
      let material = options.perGlyphMaterial === true ? undefined : materialsByColorKey.get(key);
      if (material === undefined) {
        const [r, g, b, a] = toScene(color);
        material = new THREE.MeshStandardMaterial({
          // No color-space argument: toScene's own output is already in
          // this renderer's linear working space, not sRGB-encoded.
          color: new THREE.Color().setRGB(r, g, b),
          transparent: a < 1,
          opacity: a,
        });
        if (options.perGlyphMaterial !== true) {
          materialsByColorKey.set(key, material);
        }
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
      mesh.userData["basePosition"] = mesh.position.clone();
      // A classic (non-TSL) material: unlike the flat MSDF path's
      // `MeshBasicNodeMaterial`, `.opacity` is a plain property here, so
      // this closure needs no TSL uniform indirection.
      mesh.userData["setOpacity"] = (a: number) => {
        material.opacity = a;
        material.transparent = a < 1;
      };
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
        const [sr, sg, sb, sa] = toScene([r, g, b, a]);
        for (const material of baseMaterials) {
          material.color.setRGB(sr, sg, sb);
          material.opacity = sa;
          material.transparent = sa < 1;
        }
      },
    };
  }

  const texturesByPage = data.atlasPages.map((page) => {
    const texture = new THREE.DataTexture(page.pixels, page.width, page.height, THREE.RGBAFormat);
    texture.flipY = false;
    // Explicit (matching the already-default value), not implicit: an MSDF
    // atlas page's own RGB channels encode a signed distance field, not
    // real color, so there is nothing here for the sRGB-to-linear
    // conversion `THREE.SRGBColorSpace` would trigger to apply to at all.
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    textures.push(texture);
    return texture;
  });

  const blockBounds = computeBlockBounds(data.glyphs);
  const msdfMaterialConfig = resolveMsdfMaterialConfig(options);

  const materialHandlesByKey = new Map<string, MsdfTextMaterialHandle>();
  const baseMaterialHandles = new Set<MsdfTextMaterialHandle>();

  function initializeMaterialHandle(handle: MsdfTextMaterialHandle, color: ColorRGBA): void {
    const fill = options.fill;
    if (fill !== undefined && (fill.type === "linearGradient" || fill.type === "radialGradient")) {
      handle.setGradient(
        fill.type === "linearGradient" ? fill.angle : 0,
        fill.stops.map((stop) => toScene(stop.color)),
      );
    } else {
      handle.setColor(...toScene(color));
    }
    if (options.outline !== undefined) {
      handle.setOutline(options.outline.width, ...toScene(options.outline.color));
    }
    if (options.glow !== undefined) {
      const [r, g, b, a] = toScene(options.glow.color);
      handle.setGlow(options.glow.radius, r, g, b, a, options.glow.intensity);
    }
  }

  function getMsdfMaterialHandle(page: number, color: ColorRGBA, isBaseColor: boolean): MsdfTextMaterialHandle | undefined {
    const texture = texturesByPage[page];
    if (texture === undefined) {
      return undefined;
    }
    const key = `${page}:${colorKey(color)}`;
    let handle = options.perGlyphMaterial === true ? undefined : materialHandlesByKey.get(key);
    if (handle === undefined) {
      handle = createMsdfTextMaterial(texture, msdfMaterialConfig);
      initializeMaterialHandle(handle, color);
      materials.push(handle.material);
      if (options.perGlyphMaterial !== true) {
        materialHandlesByKey.set(key, handle);
      }
    }
    if (isBaseColor) {
      baseMaterialHandles.add(handle);
    }
    return handle;
  }

  const shadowMaterialsByPage = new Map<number, MsdfTextMaterialHandle>();
  const shadowMeshes: { mesh: THREE.Mesh; step: number }[] = [];

  function getShadowMaterialHandle(page: number): MsdfTextMaterialHandle | undefined {
    const texture = texturesByPage[page];
    const shadow = options.shadow;
    if (texture === undefined || shadow === undefined) {
      return undefined;
    }
    let handle = shadowMaterialsByPage.get(page);
    if (handle === undefined) {
      handle = createMsdfTextMaterial(texture);
      handle.setColor(...toScene(shadow.color));
      handle.setBlur(shadow.blur);
      materials.push(handle.material);
      shadowMaterialsByPage.set(page, handle);
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
    applyGlyphMsdfAttributes(geometry, glyph, blockBounds);
    geometries.push(geometry);

    const mesh = new THREE.Mesh(geometry, handle.material);
    mesh.name = `glyph-${glyph.cluster}-${glyph.glyphId}`;
    mesh.position.set(
      (glyph.quad.left + glyph.quad.right) / 2,
      (glyph.quad.bottom + glyph.quad.top) / 2,
      0,
    );
    mesh.userData["basePosition"] = mesh.position.clone();
    // The flat path's material holds opacity in a TSL uniform (see
    // `msdf-material.ts`), not the classic `.opacity` property, hence
    // routing through the handle's own `setOpacity` rather than touching
    // `mesh.material` directly.
    mesh.userData["setOpacity"] = (a: number) => {
      handle.setOpacity(a);
    };
    getWordGroup(glyph.lineIndex, glyph.wordIndex).add(mesh);

    if (options.shadow !== undefined) {
      const shadowHandle = getShadowMaterialHandle(glyph.page);
      if (shadowHandle !== undefined) {
        for (let step = 1; step <= options.shadow.steps; step += 1) {
          // Reuses this same glyph's own geometry (same UV rect, same
          // msdfRange attribute) rather than sampling the atlas at an
          // offset UV within one mesh: offsetting the *position* of a
          // whole duplicate mesh can never bleed into a neighboring
          // glyph's own packed atlas rect the way offsetting a sample
          // coordinate within a single tight quad could.
          const shadowMesh = new THREE.Mesh(geometry, shadowHandle.material);
          shadowMesh.name = `glyph-shadow-${glyph.cluster}-${glyph.glyphId}-${step}`;
          shadowMesh.renderOrder = -1;
          shadowMesh.position.set(
            mesh.position.x + options.shadow.offsetX * step,
            mesh.position.y + options.shadow.offsetY * step,
            mesh.position.z,
          );
          shadowMesh.userData["basePosition"] = mesh.userData["basePosition"];
          getWordGroup(glyph.lineIndex, glyph.wordIndex).add(shadowMesh);
          shadowMeshes.push({ mesh: shadowMesh, step });
        }
      }
    }
  }

  return {
    group,
    geometries,
    materials,
    textures,
    setColor: (r, g, b, a) => {
      const sceneColor = toScene([r, g, b, a]);
      for (const handle of baseMaterialHandles) {
        handle.setColor(...sceneColor);
      }
    },
    ...(msdfMaterialConfig.fillType !== "solid" && {
      setFill: (fill: ResolvedTextFill) => {
        if (fill.type !== "linearGradient" && fill.type !== "radialGradient") {
          return;
        }
        for (const handle of baseMaterialHandles) {
          handle.setGradient(fill.type === "linearGradient" ? fill.angle : 0, fill.stops.map((stop) => toScene(stop.color)));
        }
      },
    }),
    ...(options.outline !== undefined && {
      setOutline: (outline: ResolvedTextOutline) => {
        for (const handle of baseMaterialHandles) {
          handle.setOutline(outline.width, ...toScene(outline.color));
        }
      },
    }),
    ...(options.glow !== undefined && {
      setGlow: (glow: ResolvedTextGlow) => {
        const [r, g, b, a] = toScene(glow.color);
        for (const handle of baseMaterialHandles) {
          handle.setGlow(glow.radius, r, g, b, a, glow.intensity);
        }
      },
    }),
    ...(options.shadow !== undefined && {
      setShadow: (shadow: ResolvedTextShadow) => {
        const sceneColor = toScene(shadow.color);
        for (const handle of shadowMaterialsByPage.values()) {
          handle.setColor(...sceneColor);
          handle.setBlur(shadow.blur);
        }
        for (const entry of shadowMeshes) {
          const basePosition = entry.mesh.userData["basePosition"] as THREE.Vector3;
          entry.mesh.position.set(
            basePosition.x + shadow.offsetX * entry.step,
            basePosition.y + shadow.offsetY * entry.step,
            basePosition.z,
          );
        }
      },
    }),
  };
}

/** Resolves `options.fill`/`options.outline`/`options.glow` into the structural, build-time-only shape `createMsdfTextMaterial` needs. `"texture"`/`"video"` fills (and no fill at all) map to `"solid"` - see `BuildTextGroupOptions.fill`'s own doc on why. */
function resolveMsdfMaterialConfig(options: BuildTextGroupOptions): MsdfMaterialConfig {
  const fill = options.fill;
  if (fill !== undefined && (fill.type === "linearGradient" || fill.type === "radialGradient")) {
    return {
      fillType: fill.type,
      gradientStopOffsets: fill.stops.map((stop) => stop.offset),
      outline: options.outline !== undefined,
      glow: options.glow?.direction,
    };
  }
  return {
    fillType: "solid",
    outline: options.outline !== undefined,
    glow: options.glow?.direction,
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
    uvRect.v0,
    uvRect.u1,
    uvRect.v0,
    uvRect.u0,
    uvRect.v1,
    uvRect.u1,
    uvRect.v1,
  ]);
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/** The whole rendered text block's own bounding box (every glyph's own `quad` together), used only to give a gradient fill continuous, cross-glyph coordinates (`blockUV` below) rather than each glyph independently re-starting its own 0-1 gradient. */
interface BlockBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function computeBlockBounds(glyphs: readonly PositionedGlyph[]): BlockBounds {
  if (glyphs.length === 0) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const glyph of glyphs) {
    if (glyph.quad.left < minX) minX = glyph.quad.left;
    if (glyph.quad.bottom < minY) minY = glyph.quad.bottom;
    if (glyph.quad.right > maxX) maxX = glyph.quad.right;
    if (glyph.quad.top > maxY) maxY = glyph.quad.top;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Bakes two custom per-vertex attributes `msdf-material.ts` reads:
 * `msdfRange` (this glyph's own MSDF distance-field range, in em units -
 * see `PositionedGlyph.range`'s own doc on why a shader needs this at all)
 * and `blockUV` (this vertex's own fraction of the *whole text block's*
 * bounding box, `blockBounds` - only actually sampled by the shader for a
 * gradient fill, but harmless to always bake: a handful of extra floats
 * per glyph, never read otherwise).
 */
function applyGlyphMsdfAttributes(
  geometry: THREE.PlaneGeometry,
  glyph: PositionedGlyph,
  blockBounds: BlockBounds,
): void {
  const range = new Float32Array([glyph.range, glyph.range, glyph.range, glyph.range]);
  geometry.setAttribute("msdfRange", new THREE.BufferAttribute(range, 1));

  const blockWidth = blockBounds.maxX - blockBounds.minX;
  const blockHeight = blockBounds.maxY - blockBounds.minY;
  const fractionX = (x: number) => (blockWidth === 0 ? 0 : (x - blockBounds.minX) / blockWidth);
  const fractionY = (y: number) => (blockHeight === 0 ? 0 : (y - blockBounds.minY) / blockHeight);

  // Same 4-vertex order as applyGlyphUv: bottom-left, bottom-right, top-left, top-right.
  const blockUv = new Float32Array([
    fractionX(glyph.quad.left),
    fractionY(glyph.quad.bottom),
    fractionX(glyph.quad.right),
    fractionY(glyph.quad.bottom),
    fractionX(glyph.quad.left),
    fractionY(glyph.quad.top),
    fractionX(glyph.quad.right),
    fractionY(glyph.quad.top),
  ]);
  geometry.setAttribute("blockUV", new THREE.BufferAttribute(blockUv, 2));
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
