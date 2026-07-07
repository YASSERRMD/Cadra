import * as THREE from "three";
import {
  attribute,
  clamp,
  cos,
  float,
  Fn,
  fwidth,
  length,
  max,
  min,
  mix,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
} from "three/tsl";
import { MeshBasicNodeMaterial, type Node } from "three/webgpu";

/** Which fill this material's own color comes from - fixed at build time (switching between them, or changing gradient stop count, needs a new material, exactly like `perGlyphMaterial`/`useExtrusion` are also build-time-only choices elsewhere in this same rendering path). */
export type MsdfFillType = "solid" | "linearGradient" | "radialGradient";

/**
 * Structural choices baked into this material's own shader graph shape:
 * whether it has a gradient fill at all (and how many stops, and their own
 * fixed `offset`s - only stop *colors* are updatable afterward, see
 * `setGradient`), whether it has an outline/glow stage at all, and (for
 * glow) which direction. None of this can change without building a new
 * material, matching every other structural material decision in this
 * rendering path.
 */
export interface MsdfMaterialConfig {
  /** Defaults to `"solid"`. */
  fillType?: MsdfFillType;
  /** Required (and only meaningful) for a gradient `fillType`: each stop's own fixed position (`0` to `1`), ascending. */
  gradientStopOffsets?: readonly number[];
  outline?: boolean;
  glow?: "outer" | "inner";
}

/**
 * A material plus the live uniform handles to mutate it per frame, since
 * TSL node materials build their shader graph once; updating a uniform's
 * own `.value` (rather than reassigning `colorNode`) is how a per-frame
 * color/opacity change reaches the GPU without rebuilding that graph.
 */
export interface MsdfTextMaterialHandle {
  material: THREE.Material;
  /** Sets the base/solid fill's own color. Meaningless (silently ignored) if this material was built with a gradient `fillType`; use `setGradient` instead. */
  setColor(r: number, g: number, b: number, a: number): void;
  /** Updates only this material's own overall opacity uniform, leaving color/gradient/outline/glow untouched - multiplies through the *entire* composited result (fill, outline, and glow together), so a stagger/physics fade dims the whole glyph uniformly regardless of which effects are configured. */
  setOpacity(a: number): void;
  /** Only meaningful (and only callable without throwing) if this material was built with a gradient `fillType`: `stopColors` must have exactly as many entries, in the same order, as `gradientStopOffsets` did at build time. */
  setGradient(angleDegrees: number, stopColors: readonly [number, number, number, number][]): void;
  /** Only meaningful if this material was built with `outline: true`. */
  setOutline(width: number, r: number, g: number, b: number, a: number): void;
  /** Only meaningful if this material was built with a `glow` direction. */
  setGlow(radius: number, r: number, g: number, b: number, a: number, intensity: number): void;
  /** Widens this glyph's own edge anti-aliasing band by an additional em-unit amount, softening its silhouette - always available (unlike the other setters, not gated behind a build-time config), defaulting to `0` (no-op). */
  setBlur(amount: number): void;
}

/**
 * Builds the standard MSDF (multi-channel signed distance field) alpha test:
 * sample the atlas, take the median of its three channels (msdfgen's own
 * encoding - the true signed distance is whichever of the three channels is
 * *not* the extremum, which `median(r, g, b)` recovers), and anti-alias the
 * `0` edge with `fwidth`-based screen-space derivatives rather than the
 * atlas's own fixed pixel range, so the same atlas stays crisp whether a
 * glyph fills the screen or is shrunk to a few pixels.
 *
 * The raw `median(...).sub(0.5)` value is in the atlas's own normalized
 * `[-0.5, 0.5]`-ish encoded space, not em units; multiplying it by this
 * glyph's own `msdfRange` vertex attribute (baked at build time from
 * `PositionedGlyph.range` - see that field's own doc) converts it into the
 * same em-unit space every other per-glyph quantity (`quad`, `origin`) is
 * already in, so an outline's own `width`/a glow's own `radius` (both
 * authored in em units) can be compared against it directly, with no
 * further unit conversion at the call site.
 *
 * Outline and (both directions of) glow reuse this exact same signed
 * distance, extending or blending around the base fill's own coverage
 * rather than needing separate geometry or a second atlas sample - the
 * classic cheap MSDF technique. Both are necessarily bounded by how far
 * beyond a glyph's own edge the atlas actually encodes valid distance data
 * (`MsdfAtlasOptions.range`, the atlas's own packing padding) and by the
 * glyph's own tight quad geometry (`build-text-group.ts` does not pad it);
 * a very large `width`/`radius` simply saturates at whatever the atlas
 * encodes rather than growing indefinitely. A drop/long shadow (which
 * genuinely needs to extend *beyond* a glyph's own tight quad, unlike a
 * thin outline or fringe-sized glow) is deliberately not built here at
 * all: `build-text-group.ts` instead renders it as a separate, offset-
 * positioned duplicate mesh reusing this same atlas sample unmodified, so
 * it never risks sampling into a neighboring glyph's own packed atlas
 * rect.
 *
 * A gradient fill's own cross-glyph continuity comes from `blockUV`, a
 * second vertex attribute `build-text-group.ts` bakes from each glyph's own
 * quad position relative to the *whole text block's* bounding box (not
 * this glyph's own atlas-sample `uv`, which only ever spans this one
 * glyph's own small atlas rect) - see that module's own doc.
 *
 * Built with `three/tsl` (not a raw `THREE.ShaderMaterial`/GLSL) so it
 * compiles correctly under both backends `packages/renderer` supports
 * (`WebGPURenderer` and the `WebGLRenderer` fallback): TSL compiles to
 * WGSL or GLSL depending on which is active, where a hand-written GLSL
 * `ShaderMaterial` would only ever run on the WebGL2 path.
 */
export function createMsdfTextMaterial(
  atlasTexture: THREE.Texture,
  config: MsdfMaterialConfig = {},
): MsdfTextMaterialHandle {
  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;

  const colorUniform = uniform(new THREE.Color(1, 1, 1));
  const opacityUniform = uniform(1);

  const median = Fn(([r, g, b]: [Node<"float">, Node<"float">, Node<"float">]) => {
    return max(min(r, g), min(max(r, g), b));
  });

  const sample = texture(atlasTexture, uv());
  const signedDistanceNormalized = median(sample.r, sample.g, sample.b).sub(0.5);
  const msdfRange = attribute<"float">("msdfRange", "float");
  const signedDistance = signedDistanceNormalized.mul(msdfRange);
  // Widening the natural (sub-pixel) anti-aliasing band by an additional,
  // explicit em-unit amount is exactly a Gaussian-ish soft blur of this
  // glyph's own silhouette - reused by build-text-group.ts's own shadow
  // duplicate mesh (a `TextShadowConfig.blur` > 0 sets this), left at its
  // default `0` (a no-op addition) for every other use of this material.
  const blurUniform = uniform(0);
  const edgeWidth = fwidth(signedDistance).add(blurUniform);
  const fillCoverage = smoothstep(edgeWidth.negate(), edgeWidth, signedDistance);

  let fillColorRgb: Node<"vec3"> = colorUniform.rgb;
  let fillOwnAlpha: Node<"float"> = float(1);
  let setGradient: MsdfTextMaterialHandle["setGradient"] = () => {
    throw new Error("createMsdfTextMaterial: setGradient called on a material not built with a gradient fillType.");
  };

  if (config.fillType === "linearGradient" || config.fillType === "radialGradient") {
    const offsets = config.gradientStopOffsets ?? [];
    if (offsets.length < 2) {
      throw new Error(
        "createMsdfTextMaterial: a gradient fillType needs at least 2 gradientStopOffsets.",
      );
    }
    const angleUniform = uniform(0);
    const stopUniforms = offsets.map(() => uniform(new THREE.Vector4(1, 1, 1, 1)));
    type StopUniform = (typeof stopUniforms)[number];

    const blockUv = attribute<"vec2">("blockUV", "vec2");
    const angleRadians = angleUniform.mul(Math.PI / 180);
    const gradientT: Node<"float"> =
      config.fillType === "linearGradient"
        ? blockUv.x.mul(cos(angleRadians)).add(blockUv.y.mul(sin(angleRadians)))
        : length(blockUv.sub(vec2(0.5, 0.5))).div(0.70710678);

    const firstStop = stopUniforms[0] as StopUniform;
    let rgb: Node<"vec3"> = firstStop.xyz;
    let alpha: Node<"float"> = firstStop.w;
    for (let i = 1; i < offsets.length; i += 1) {
      const stopUniform = stopUniforms[i] as StopUniform;
      const stopFactor = smoothstep(offsets[i - 1] as number, offsets[i] as number, gradientT);
      rgb = mix(rgb, stopUniform.xyz, stopFactor);
      alpha = mix(alpha, stopUniform.w, stopFactor);
    }
    fillColorRgb = rgb;
    fillOwnAlpha = alpha;

    setGradient = (angleDegrees, stopColors) => {
      if (stopColors.length !== stopUniforms.length) {
        throw new Error(
          `createMsdfTextMaterial: setGradient expected exactly ${stopUniforms.length} stop colors (matching gradientStopOffsets), got ${stopColors.length}.`,
        );
      }
      angleUniform.value = angleDegrees;
      stopUniforms.forEach((stopUniform, i) => {
        const [r, g, b, a] = stopColors[i] as [number, number, number, number];
        stopUniform.value.set(r, g, b, a);
      });
    };
  }

  let finalColor: Node<"vec3"> = fillColorRgb;
  let finalCoverage: Node<"float"> = fillCoverage.mul(fillOwnAlpha);
  let setOutline: MsdfTextMaterialHandle["setOutline"] = () => {
    throw new Error("createMsdfTextMaterial: setOutline called on a material not built with outline: true.");
  };

  if (config.outline === true) {
    const outlineWidthUniform = uniform(0);
    const outlineColorUniform = uniform(new THREE.Vector4(0, 0, 0, 1));
    const outlineCoverage = smoothstep(
      edgeWidth.negate(),
      edgeWidth,
      signedDistance.add(outlineWidthUniform),
    );
    finalColor = mix(outlineColorUniform.xyz, finalColor, fillCoverage);
    finalCoverage = max(finalCoverage, outlineCoverage.mul(outlineColorUniform.w));

    setOutline = (width, r, g, b, a) => {
      outlineWidthUniform.value = width;
      outlineColorUniform.value.set(r, g, b, a);
    };
  }

  let setGlow: MsdfTextMaterialHandle["setGlow"] = () => {
    throw new Error("createMsdfTextMaterial: setGlow called on a material not built with a glow direction.");
  };

  if (config.glow !== undefined) {
    const glowRadiusUniform = uniform(0.001);
    const glowColorUniform = uniform(new THREE.Vector4(1, 1, 1, 1));
    const glowIntensityUniform = uniform(1);
    const glowDistance: Node<"float"> = config.glow === "outer" ? signedDistance.negate() : signedDistance;
    const glowFalloff = clamp(float(1).sub(glowDistance.div(glowRadiusUniform)), 0, 1);
    const glowAlpha = glowFalloff.mul(glowColorUniform.w).mul(glowIntensityUniform);

    if (config.glow === "outer") {
      // Outer glow only shows through where the composited shape so far
      // (fill plus outline) is not already opaque, so it never tints or
      // replaces the solid glyph body itself, only the halo around it.
      finalColor = mix(finalColor, glowColorUniform.xyz, glowAlpha.mul(float(1).sub(finalCoverage)));
      finalCoverage = max(finalCoverage, glowAlpha);
    } else {
      // Inner glow blends into the already-covered glyph body itself
      // (strongest right at the edge, fading toward the center), so it is
      // gated by the shape's own coverage rather than by "not yet covered".
      finalColor = mix(finalColor, glowColorUniform.xyz, glowAlpha.mul(finalCoverage));
    }

    setGlow = (radius, r, g, b, a, intensity) => {
      glowRadiusUniform.value = radius;
      glowColorUniform.value.set(r, g, b, a);
      glowIntensityUniform.value = intensity;
    };
  }

  material.colorNode = finalColor;
  material.opacityNode = finalCoverage.mul(opacityUniform);

  return {
    material,
    setColor(r: number, g: number, b: number, a: number): void {
      colorUniform.value.setRGB(r, g, b);
      opacityUniform.value = a;
    },
    setOpacity(a: number): void {
      opacityUniform.value = a;
    },
    setGradient,
    setOutline,
    setGlow,
    setBlur(amount: number): void {
      blurUniform.value = amount;
    },
  };
}
