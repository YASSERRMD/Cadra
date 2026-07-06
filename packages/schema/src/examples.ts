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
                      fontSize: 96,
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
                    position: [-5, -3, 1],
                    rotation: [0, 0, 0],
                    scale: [1, 1, 1],
                  },
                  visible: true,
                  content: "Cadra Multi-Track Demo",
                  fontRef: "font-inter-bold",
                  fontSize: 48,
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

/**
 * The full curated example set, in the same order the `.scene.json` files
 * were introduced: a title card (a static `group` composed of a background
 * plane and text), a moving shape (three sequential clips walking a mesh
 * across the frame), a camera pan (two sequential `camera` clips), and a
 * multi-track composition with transitions (two video tracks, one with a
 * `crossDissolve` between clips and one with a fading-in overlay, plus a
 * background-music audio track).
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
];
