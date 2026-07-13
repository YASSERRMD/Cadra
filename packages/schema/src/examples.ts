import type { SceneDocument } from "./envelope.js";

/**
 * The curated example set: a handful of valid, realistic `SceneDocument`s
 * covering the most common authoring patterns, so an agent (or a human)
 * learning the format has real, parseable documents to read alongside the
 * JSON Schema and capability manifest, not just an abstract shape.
 *
 * Deliberately inlined here as plain TypeScript data (compiled straight into
 * this package's `dist/examples.js`), rather than read from the sibling
 * `../examples/*.scene.json` files at runtime: those files exist too (kept
 * byte-for-byte in sync with this module by
 * `examples-data-matches-json-files.test.ts`) as the human-browsable,
 * git-diffable source of truth, and are what `examples.test.ts` and
 * `parse.test.ts` load directly to validate against the generated JSON
 * Schema and `parseScene` independently of this module. But a path like
 * `new URL("../examples/foo.json", import.meta.url)` only resolves correctly
 * because `examples/` happens to sit next to `src/` (and, after a build,
 * next to `dist/`) in this monorepo checkout; this package's own
 * `package.json` `files` field publishes only `dist` to npm, so that
 * sibling directory would not exist for a consumer who installed
 * `@cadra/schema` from the registry rather than working in this repo. A
 * runtime `describeCadraContract()` (`./describe.ts`) needs its `examples`
 * field to work identically for both callers, so the documents live here,
 * as data, with nothing to resolve at runtime at all.
 *
 * Each entry's `name` matches its corresponding file's basename under
 * `../examples/` (e.g. `"title-card"` for `title-card.scene.json`).
 */
export interface NamedSceneDocumentExample {
  /** Short, file-name-like identifier for this example, e.g. `"title-card"`. */
  name: string;
  /** One-sentence description of what this example demonstrates. */
  description: string;
  /** The example's fully-typed, valid `SceneDocument` body. */
  document: SceneDocument;
}

const TITLE_CARD: SceneDocument = {
  schemaVersion: 1,
  project: {
    id: "project-title-card",
    name: "Title Card Example",
    compositions: [
      {
        id: "comp-title-card",
        name: "Main",
        fps: 30,
        durationInFrames: 90,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: "track-title-card",
            name: "Title",
            clips: [
              {
                id: "clip-title-card",
                startFrame: 0,
                durationInFrames: 90,
                node: {
                  id: "root-title-card",
                  kind: "group",
                  name: "Title Card Root",
                  transform: {
                    position: [0, 0, 0],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  children: [
                    {
                      id: "background-plane",
                      kind: "mesh",
                      name: "Background",
                      transform: {
                        position: [0, 0, -1],
                        rotation: [0, 0, 0],
                        scale: [16, 9, 1],
                      },
                      visible: true,
                      geometryRef: "geometry-plane",
                      materialRef: "material-background-navy",
                      children: [],
                    },
                    {
                      id: "title-text",
                      kind: "text",
                      name: "Title",
                      transform: {
                        position: [0, 0, 0],
                        rotation: [0, 0, 0],
                        scale: [1, 1, 1],
                      },
                      visible: true,
                      content: "Cadra",
                      fontRef: "font-inter-bold",
                      fontSize: 1.2,
                      color: [1, 1, 1, 1],
                      children: [],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  },
};

const MOVING_SHAPE: SceneDocument = {
  schemaVersion: 1,
  project: {
    id: "project-moving-shape",
    name: "Moving Shape Example",
    compositions: [
      {
        id: "comp-moving-shape",
        name: "Main",
        fps: 30,
        durationInFrames: 90,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: "track-moving-shape",
            name: "Shape",
            clips: [
              {
                id: "clip-shape-left",
                startFrame: 0,
                durationInFrames: 30,
                node: {
                  id: "shape-left",
                  kind: "mesh",
                  name: "Shape (left)",
                  transform: {
                    position: [-4, 0, 0],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  geometryRef: "geometry-box",
                  materialRef: "material-shape-gold",
                  children: [],
                },
              },
              {
                id: "clip-shape-center",
                startFrame: 30,
                durationInFrames: 30,
                node: {
                  id: "shape-center",
                  kind: "mesh",
                  name: "Shape (center)",
                  transform: {
                    position: [0, 0, 0],
                    rotation: [0, 0.7853981633974483, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  geometryRef: "geometry-box",
                  materialRef: "material-shape-gold",
                  children: [],
                },
              },
              {
                id: "clip-shape-right",
                startFrame: 60,
                durationInFrames: 30,
                node: {
                  id: "shape-right",
                  kind: "mesh",
                  name: "Shape (right)",
                  transform: {
                    position: [4, 0, 0],
                    rotation: [0, 1.5707963267948966, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  geometryRef: "geometry-box",
                  materialRef: "material-shape-gold",
                  children: [],
                },
              },
            ],
          },
        ],
      },
    ],
  },
};

const CAMERA_PAN: SceneDocument = {
  schemaVersion: 1,
  project: {
    id: "project-camera-pan",
    name: "Camera Pan Example",
    compositions: [
      {
        id: "comp-camera-pan",
        name: "Main",
        fps: 30,
        durationInFrames: 120,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: "track-camera-pan",
            name: "Camera",
            clips: [
              {
                id: "clip-camera-start",
                startFrame: 0,
                durationInFrames: 60,
                node: {
                  id: "camera-start",
                  kind: "camera",
                  name: "Camera (start)",
                  transform: {
                    position: [-6, 2, 8],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  fov: 50,
                  near: 0.1,
                  far: 1000,
                  target: [-2, 0, 0],
                  children: [],
                },
              },
              {
                id: "clip-camera-end",
                startFrame: 60,
                durationInFrames: 60,
                node: {
                  id: "camera-end",
                  kind: "camera",
                  name: "Camera (end)",
                  transform: {
                    position: [6, 2, 8],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  fov: 50,
                  near: 0.1,
                  far: 1000,
                  target: [2, 0, 0],
                  children: [],
                },
              },
            ],
          },
          {
            id: "track-camera-pan-subject",
            name: "Subject",
            clips: [
              {
                id: "clip-subject",
                startFrame: 0,
                durationInFrames: 120,
                node: {
                  id: "subject-box",
                  kind: "mesh",
                  name: "Subject",
                  transform: {
                    position: [0, 0, 0],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  geometryRef: "geometry-box",
                  materialRef: "material-shape-gold",
                  children: [],
                },
              },
            ],
          },
          {
            id: "track-camera-pan-light",
            name: "Light",
            clips: [
              {
                id: "clip-light-ambient",
                startFrame: 0,
                durationInFrames: 120,
                node: {
                  id: "light-ambient",
                  kind: "light",
                  name: "Ambient",
                  transform: {
                    position: [0, 0, 0],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  lightType: "ambient",
                  color: [1, 1, 1, 1],
                  intensity: 1.2,
                  children: [],
                },
              },
              {
                id: "clip-light-directional",
                startFrame: 0,
                durationInFrames: 120,
                node: {
                  id: "light-directional",
                  kind: "light",
                  name: "Key",
                  transform: {
                    position: [3, 5, 5],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  lightType: "directional",
                  color: [1, 1, 1, 1],
                  intensity: 2,
                  children: [],
                },
              },
            ],
          },
        ],
        activeCameraTrack: [
          { startFrame: 0, durationInFrames: 60, cameraNodeId: "camera-start" },
          { startFrame: 60, durationInFrames: 60, cameraNodeId: "camera-end" },
        ],
      },
    ],
  },
};

const MULTI_TRACK_TRANSITION: SceneDocument = {
  schemaVersion: 1,
  project: {
    id: "project-multi-track-transition",
    name: "Multi-Track Transition Example",
    compositions: [
      {
        id: "comp-multi-track-transition",
        name: "Main",
        fps: 30,
        durationInFrames: 150,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: "track-background",
            name: "Background Shapes",
            clips: [
              {
                id: "clip-shape-a",
                startFrame: 0,
                durationInFrames: 90,
                node: {
                  id: "shape-a",
                  kind: "mesh",
                  name: "Shape A",
                  transform: {
                    position: [0, 0, 0],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  geometryRef: "geometry-box",
                  materialRef: "material-shape-gold",
                  children: [],
                },
              },
              {
                id: "clip-shape-b",
                startFrame: 90,
                durationInFrames: 60,
                node: {
                  id: "shape-b",
                  kind: "mesh",
                  name: "Shape B",
                  transform: {
                    position: [0, 0, 0],
                    rotation: [0, 0.7853981633974483, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  geometryRef: "geometry-sphere",
                  materialRef: "material-shape-navy",
                  children: [],
                },
                transitionIn: {
                  type: "crossDissolve",
                  durationInFrames: 20,
                },
              },
            ],
          },
          {
            id: "track-lower-third",
            name: "Lower Third",
            clips: [
              {
                id: "clip-lower-third",
                startFrame: 15,
                durationInFrames: 60,
                node: {
                  id: "lower-third-text",
                  kind: "text",
                  name: "Lower Third",
                  transform: {
                    position: [-3.4, -1.8, 0],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  content: "Cadra Multi-Track Demo",
                  fontRef: "font-inter-bold",
                  fontSize: 0.6,
                  color: [1, 1, 1, 1],
                  children: [],
                },
                transitionIn: {
                  type: "fade",
                  durationInFrames: 15,
                },
              },
            ],
          },
        ],
        audioTracks: [
          {
            id: "audio-track-music",
            name: "Background Music",
            clips: [
              {
                id: "clip-music",
                startFrame: 0,
                durationInFrames: 150,
                assetRef: "asset-background-music",
                gain: 0.6,
                fadeIn: { durationInFrames: 30 },
                fadeOut: { durationInFrames: 30 },
              },
            ],
          },
        ],
      },
    ],
  },
};

const KINETIC_TITLE_SEQUENCE: SceneDocument = {
  schemaVersion: 1,
  project: {
    id: "project-kinetic-title-sequence",
    name: "Kinetic Title Sequence Example",
    compositions: [
      {
        id: "comp-kinetic-title-sequence",
        name: "Main",
        fps: 30,
        durationInFrames: 90,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: "track-kinetic-title",
            name: "Title",
            clips: [
              {
                id: "clip-kinetic-title",
                startFrame: 0,
                durationInFrames: 90,
                node: {
                  id: "kinetic-title-text",
                  kind: "text",
                  name: "Kinetic Title",
                  transform: {
                    position: [-1.4, 0, 0],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  content: "CADRA",
                  fontRef: "font-inter-bold",
                  fontSize: 1.5,
                  color: [1, 1, 1, 1],
                  stagger: {
                    preset: "fadeInUp",
                    grouping: "character",
                    startFrame: 0,
                    delayFrames: 3,
                    durationFrames: 18,
                    direction: "forward",
                    easing: "easeOutCubic",
                    distance: 0.6,
                  },
                  glow: {
                    direction: "outer",
                    radius: 0.08,
                    color: [0.4, 0.7, 1, 1],
                    intensity: 0.8,
                  },
                  children: [],
                },
              },
            ],
          },
        ],
      },
    ],
  },
};

const PRODUCT_SHOT_IBL_DOF: SceneDocument = {
  schemaVersion: 1,
  project: {
    id: "project-product-shot-ibl-dof",
    name: "Product Shot (IBL and Depth of Field) Example",
    compositions: [
      {
        id: "comp-product-shot-ibl-dof",
        name: "Main",
        fps: 30,
        durationInFrames: 90,
        width: 1920,
        height: 1080,
        environment: {
          envMapRef: "studio",
          intensity: 1,
          showBackground: false,
        },
        postProcessing: {
          effects: [
            { type: "depthOfField", focusDistance: 6, aperture: 0.03, maxBlur: 1 },
            { type: "sharpen", amount: 0.3 },
          ],
        },
        tracks: [
          {
            id: "track-product-camera",
            name: "Camera",
            clips: [
              {
                id: "clip-product-camera",
                startFrame: 0,
                durationInFrames: 90,
                node: {
                  id: "product-camera",
                  kind: "camera",
                  name: "Camera",
                  transform: {
                    position: [0, 1.5, 6],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  fov: 40,
                  near: 0.1,
                  far: 1000,
                  target: [0, 0, 0],
                  children: [],
                },
              },
            ],
          },
          {
            id: "track-product-shape",
            name: "Product",
            clips: [
              {
                id: "clip-product-shape",
                startFrame: 0,
                durationInFrames: 90,
                node: {
                  id: "product-shape",
                  kind: "mesh",
                  name: "Product",
                  transform: {
                    position: [0, 0, 0],
                    rotation: [0, 0.4, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  geometryRef: "geometry-sphere",
                  materialRef: "material-product-fallback",
                  material: {
                    baseColor: [1, 0.766, 0.336, 1],
                    metalness: 1,
                    roughness: 0.12,
                  },
                  castShadow: true,
                  receiveShadow: true,
                  children: [],
                },
              },
            ],
          },
          {
            id: "track-product-light",
            name: "Key Light",
            clips: [
              {
                id: "clip-product-light",
                startFrame: 0,
                durationInFrames: 90,
                node: {
                  id: "product-key-light",
                  kind: "light",
                  name: "Key Light",
                  transform: {
                    position: [3, 4, 5],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  lightType: "directional",
                  color: [1, 1, 1, 1],
                  intensity: 1.8,
                  castShadow: true,
                  children: [],
                },
              },
            ],
          },
        ],
      },
    ],
  },
};

const RTL_LATIN_LOWER_THIRD: SceneDocument = {
  schemaVersion: 1,
  project: {
    id: "project-rtl-latin-lower-third",
    name: "Arabic and Latin Lower Third Example",
    compositions: [
      {
        id: "comp-rtl-latin-lower-third",
        name: "Main",
        fps: 30,
        durationInFrames: 90,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: "track-lower-third-arabic",
            name: "Lower Third (Arabic)",
            clips: [
              {
                id: "clip-lower-third-arabic",
                startFrame: 0,
                durationInFrames: 90,
                node: {
                  id: "lower-third-arabic-text",
                  kind: "text",
                  name: "Lower Third (Arabic)",
                  transform: {
                    position: [-2.5, -0.8, 0],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  content: "مرحبا بالعالم",
                  fontRef: "font-noto-sans-arabic",
                  fontSize: 0.8,
                  color: [1, 1, 1, 1],
                  stagger: {
                    preset: "fadeInUp",
                    grouping: "word",
                    startFrame: 0,
                    delayFrames: 6,
                    durationFrames: 20,
                    direction: "forward",
                  },
                  children: [],
                },
              },
            ],
          },
          {
            id: "track-lower-third-latin",
            name: "Lower Third (Latin)",
            clips: [
              {
                id: "clip-lower-third-latin",
                startFrame: 10,
                durationInFrames: 80,
                node: {
                  id: "lower-third-latin-text",
                  kind: "text",
                  name: "Lower Third (Latin)",
                  transform: {
                    position: [-2.5, -1.6, 0],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  content: "Hello, World",
                  fontRef: "font-inter-bold",
                  fontSize: 0.5,
                  color: [0.85, 0.85, 0.85, 1],
                  stagger: {
                    preset: "fadeInUp",
                    grouping: "word",
                    startFrame: 0,
                    delayFrames: 6,
                    durationFrames: 20,
                    direction: "forward",
                  },
                  children: [],
                },
              },
            ],
          },
        ],
      },
    ],
  },
};

/**
 * The full curated example set, in the same order the `.scene.json` files
 * were introduced: a title card (a static `group` composed of a background
 * plane and text), a moving shape (three sequential clips walking a mesh
 * across the frame), a camera pan (two sequential `camera` clips), a
 * multi-track composition with transitions (two video tracks, one with a
 * `crossDissolve` between clips and one with a fading-in overlay, plus a
 * background-music audio track), a kinetic title sequence (a staggered,
 * glowing character-by-character reveal), a product shot (a PBR sphere lit
 * by a key light plus a studio IBL environment, with depth of field), and an
 * Arabic-and-Latin animated lower third (two staggered `text` nodes, one
 * right-to-left, one left-to-right, proving bidi content is just ordinary
 * `content` - no special scene-graph shape of its own).
 */
export const EXAMPLE_SCENE_DOCUMENTS: readonly NamedSceneDocumentExample[] = [
  {
    name: "title-card",
    description:
      "A static title card: a background plane and a text node, both under a group root.",
    document: TITLE_CARD,
  },
  {
    name: "moving-shape",
    description: "A single mesh moved and rotated across three sequential clips on one track.",
    document: MOVING_SHAPE,
  },
  {
    name: "camera-pan",
    description: "A camera panned between two positions across two sequential clips on one track.",
    document: CAMERA_PAN,
  },
  {
    name: "multi-track-transition",
    description:
      "Two video tracks (a crossDissolve between clips on one, a fading-in lower third on the " +
      "other) plus a background-music audio track with fades.",
    document: MULTI_TRACK_TRANSITION,
  },
  {
    name: "kinetic-title-sequence",
    description:
      "A kinetic title: one text node revealing character by character with a fadeInUp stagger " +
      "and an outer glow.",
    document: KINETIC_TITLE_SEQUENCE,
  },
  {
    name: "product-shot-ibl-dof",
    description:
      "A product shot: a metallic PBR sphere lit by a key light under a studio image-based-lighting " +
      "environment, with depth-of-field and sharpen post-processing.",
    document: PRODUCT_SHOT_IBL_DOF,
  },
  {
    name: "rtl-latin-lower-third",
    description:
      "An animated lower third pairing right-to-left Arabic and left-to-right Latin text, each " +
      "revealing with its own word-by-word fadeInUp stagger.",
    document: RTL_LATIN_LOWER_THIRD,
  },
];
