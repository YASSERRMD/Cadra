import type { MeshNode, Project, SceneNode } from "@cadra/core";
import { createFrameContext, resolveSceneAtFrame } from "@cadra/core";
import { buildTextRenderRegistryForProject } from "@cadra/encode";
import { createNativeGpuHeadlessRenderer } from "@cadra/headless";
import { createDefaultGeometryRegistry, createDefaultMaterialRegistry } from "@cadra/renderer";
import { EXAMPLE_SCENE_DOCUMENTS } from "@cadra/schema";
import { describe, expect, it } from "vitest";

/**
 * Every previously-known-broken curated example now renders correctly (see
 * `@cadra/golden-frames`' own `render-raster-scene.e2e.test.ts` for a
 * dedicated `depthOfField` regression test covering the `product-shot-ibl-dof`
 * fix specifically: a freshly built scene pass's own render target started
 * at its 1x1 constructor default, and `depthOfField`'s own node read that
 * *before* the pass had ever actually rendered once to size itself,
 * collapsing its entire internal chain - and so this composition's final
 * output - to a 1x1 black composite; fixed in
 * `post-processing-pipeline.ts`'s own `buildWebGpuPipeline`). Kept as an
 * empty set, not deleted outright, so a future regression has an obvious,
 * named place to be excluded from again rather than needing this whole
 * mechanism re-invented.
 */
const KNOWN_BROKEN_EXAMPLES = new Set<string>([]);

function containsTextNode(node: SceneNode): boolean {
  if (node.kind === "text") {
    return true;
  }
  return node.children.some(containsTextNode);
}

function projectHasTextNode(project: Project): boolean {
  return project.compositions.some((composition) =>
    composition.tracks.some((track) => track.clips.some((clip) => containsTextNode(clip.node))),
  );
}

/** Recursively collects every `MeshNode` in `node`'s own subtree into `out`. */
function collectMeshNodes(node: SceneNode, out: MeshNode[]): void {
  if (node.kind === "mesh") {
    out.push(node);
  }
  for (const child of node.children) {
    collectMeshNodes(child, out);
  }
}

/**
 * The regression `example-scenes-render.e2e.test.ts`'s own render-based
 * checks below cannot catch: an unresolvable `geometryRef`/`materialRef`
 * silently falls back to a documented placeholder (a small grey box -
 * `node-factory.ts`'s own `DEFAULT_MESH_GEOMETRY`/`DEFAULT_MESH_MATERIAL`),
 * still real, still non-blank, still passing every check below - not a
 * crash, and (for a node whose *intended* shape genuinely is a box, e.g.
 * `moving-shape`'s own boxes) not even a visibly different silhouette. A
 * real render is the wrong tool for this; resolving each ref directly
 * against the exact same default registries `render_frames`/`render_scene`
 * actually use, with no GPU involved at all, is both precise (names exactly
 * which node/ref is broken) and immediate.
 */
describe("curated example scenes: every mesh node's own geometryRef/materialRef actually resolves", () => {
  const geometryRegistry = createDefaultGeometryRegistry();
  const materialRegistry = createDefaultMaterialRegistry();

  for (const example of EXAMPLE_SCENE_DOCUMENTS) {
    const meshNodes: MeshNode[] = [];
    for (const composition of example.document.project.compositions) {
      for (const track of composition.tracks) {
        for (const clip of track.clips) {
          collectMeshNodes(clip.node, meshNodes);
        }
      }
    }
    if (meshNodes.length === 0) {
      continue;
    }

    it(`every mesh node in "${example.name}" resolves a real geometryRef, and either a real materialRef or an inline material override`, () => {
      for (const node of meshNodes) {
        expect(geometryRegistry.resolve(node.geometryRef), `${example.name}/${node.id}: geometryRef "${node.geometryRef}"`).toBeDefined();
        // Mirrors node-factory.ts's own resolveMeshNodeMaterial: an inline
        // `material` takes over from `materialRef` entirely when present,
        // so a materialRef that intentionally never resolves (documenting
        // intent only, same as product-shot-ibl-dof's own
        // "material-product-fallback") is not itself a bug.
        const hasResolvableMaterialRef = materialRegistry.resolve(node.materialRef) !== undefined;
        expect(
          hasResolvableMaterialRef || node.material !== undefined,
          `${example.name}/${node.id}: materialRef "${node.materialRef}" does not resolve and no inline material override is set`,
        ).toBe(true);
      }
    });
  }
});

/** Distinct (unquantized) RGB values in a frame - a cheap proxy for "how much real visual detail is here," since MSDF text's anti-aliased glyph edges alone contribute hundreds of intermediate blend colors a flat-shaded background/mesh does not. */
function countDistinctColors(pixels: { data: Uint8ClampedArray | Uint8Array }): number {
  const distinct = new Set<string>();
  for (let i = 0; i < pixels.data.length; i += 4) {
    distinct.add(`${pixels.data[i]},${pixels.data[i + 1]},${pixels.data[i + 2]}`);
  }
  return distinct.size;
}

function isNonBlank(pixels: { data: Uint8ClampedArray | Uint8Array }): boolean {
  for (let i = 0; i < pixels.data.length; i += 4) {
    if (pixels.data[i] !== 0 || pixels.data[i + 1] !== 0 || pixels.data[i + 2] !== 0) {
      return true;
    }
  }
  return false;
}

/**
 * Frames sampled as fractions of a composition's own duration, not fixed
 * frame numbers: several curated examples have tracks/clips that do not
 * span the full composition (e.g. a lower-third clip active only from frame
 * 15 to 74 of a 150-frame composition), so any single fixed sample risks
 * landing in a gap between clips and asserting on a frame nothing was ever
 * meant to occupy. Sampling several spread-out points and taking the best
 * result across all of them is robust to that without needing to know any
 * example's own clip timing.
 */
const DURATION_SAMPLE_FRACTIONS = [0.2, 0.4, 0.6, 0.8];

/**
 * `EXAMPLE_SCENE_DOCUMENTS` (served live through the `cadra://contract` MCP
 * resource) is the primary way an agent learns the Cadra scene format at
 * runtime - a broken example does not just fail silently, it actively
 * teaches every future agent the wrong pattern. `examples-data-matches-json-
 * files.test.ts` (in `@cadra/schema`) only checks that the `.ts`/`.json`
 * mirrors agree and that `parseScene` accepts each document; neither that
 * nor any other existing test actually renders one. This is the coverage
 * gap that let three curated examples (camera-pan, kinetic-title-sequence,
 * rtl-latin-lower-third) ship with content invisible at render time -
 * off-camera text, a title clipped past the frame edge, and (independently)
 * a real MSDF-atlas-generation crash on ink-less glyph sets - none of which
 * `parseScene` or a JSON-diff could ever catch.
 *
 * Text-bearing examples get the stronger `countDistinctColors` check rather
 * than plain non-blank: verified empirically against this exact regression
 * (`multi-track-transition`'s lower third positioned off-camera) that a
 * static background mesh alone keeps a frame technically "non-blank" while
 * the text itself renders nothing at all (2 distinct colors either way) -
 * only once the text is actually visible does the color count jump by two
 * orders of magnitude (523, measured against that same example fixed).
 * Non-text examples fall back to plain non-blank: verified empirically
 * (`moving-shape`, which has no text at all) that a legitimately-correct,
 * simple flat-shaded scene can have as few as 3-5 distinct colors across
 * its own full duration, too close to a genuinely-broken frame's 1-2 to
 * threshold reliably - for those, "was anything at all drawn" (which is
 * exactly what the original `camera-pan` bug violated: an inert scene with
 * two cameras, neither ever activated) is the honest bar.
 *
 * Known blind spot, also verified empirically: this does not catch a title
 * *partially* clipped past the frame edge (`kinetic-title-sequence`'s own
 * original bug - the last of 5 characters entirely off-screen) - even 4
 * anti-aliased characters alone clear the color-count threshold. It reliably
 * catches complete invisibility and crashes, not partial framing mistakes;
 * that gap is still meaningfully narrower than "no rendering check at all."
 */
describe("curated example scenes render for real", () => {
  for (const example of EXAMPLE_SCENE_DOCUMENTS.filter((e) => !KNOWN_BROKEN_EXAMPLES.has(e.name))) {
    it(
      `renders "${example.name}" without crashing, with real visible content across its duration`,
      async () => {
        const project = example.document.project;
        const composition = project.compositions[0];
        expect(composition).toBeDefined();
        if (composition === undefined) {
          return;
        }
        const hasText = projectHasTextNode(project);

        const textRenderRegistry = await buildTextRenderRegistryForProject(project);
        const renderer = createNativeGpuHeadlessRenderer({ textRenderRegistry });
        try {
          await renderer.init({}, { width: composition.width, height: composition.height });

          let bestDistinctColors = 0;
          let anyNonBlank = false;
          const sampledFrames = new Set(
            DURATION_SAMPLE_FRACTIONS.map((fraction) =>
              Math.min(composition.durationInFrames - 1, Math.floor(composition.durationInFrames * fraction)),
            ),
          );
          for (const frame of sampledFrames) {
            const sceneState = resolveSceneAtFrame(project, composition.id, frame);
            const frameContext = createFrameContext({
              frame,
              fps: composition.fps,
              durationInFrames: composition.durationInFrames,
              seed: `example-scenes-render-test-${example.name}`,
            });

            renderer.renderFrame(sceneState, frameContext);
            const pixels = await renderer.readPixels();
            anyNonBlank = anyNonBlank || isNonBlank(pixels);
            bestDistinctColors = Math.max(bestDistinctColors, countDistinctColors(pixels));
          }

          if (hasText) {
            // 15 gives generous margin above the ~2 colors a fully-invisible
            // text node's own static background alone produces, and well
            // below the 500+ colors real anti-aliased glyphs produce.
            expect(bestDistinctColors).toBeGreaterThan(15);
          } else {
            expect(anyNonBlank).toBe(true);
          }
        } finally {
          renderer.dispose();
        }
      },
      30_000,
    );
  }
});
