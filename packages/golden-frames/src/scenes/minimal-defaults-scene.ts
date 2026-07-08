import { Camera, Shape, Text, TYPE_PRESETS } from "@cadra/core";

import type { GoldenScene, GoldenSceneTextRequirement } from "./golden-scene.js";
import { buildSingleTrackProject } from "./shared.js";

const FPS = 10;
const DURATION_IN_FRAMES = 1;
const WIDTH = 256;
const HEIGHT = 256;
const CONTENT = "CADRA";

/**
 * Phase 73's own task 6 deliverable: a scene with only a `mesh` and a
 * `text` node - no `light` node, no `postProcessing`, no `colorGrading`, no
 * `environment` - proving this codebase's own quality defaults alone
 * (`docs/quality-defaults.md`) already render a professional-looking
 * result with zero tuning:
 *
 * - The sphere has an explicit but entirely empty `material: {}`, so every
 *   channel resolves through `resolveMeshMaterial`'s own cinematic defaults
 *   (a neutral 70% gray `baseColor`, `0.5` `roughness`, `0` `metalness`;
 *   see that function's own doc in `@cadra/core`).
 * - Neither node authors any light, and the composition sets no
 *   `environment`, so `@cadra/renderer`'s `applyDefaultLightingIfNeeded`
 *   (`three-renderer.ts`) adds `DEFAULT_LIGHTING_RIG` - a three-point key/
 *   fill/rim rig - directly to the render, never to this document itself.
 * - The title text starts from `TYPE_PRESETS.title` (fontSize overridden
 *   down from that preset's own large-composition-scale `96` to fit this
 *   harness's small 256x256 convention - see `TYPE_PRESETS`'s own doc for
 *   why `transform`/`fontSize` are meant to be overridden per scene), so
 *   this scene also exercises its own word-grouped `fadeInUp` stagger and
 *   glow, resolved at the frame both are fully settled.
 *
 * `fontSize`/`transform.position` follow `text-scene.ts`'s own established
 * scale convention for this harness (roughly unit-scale text at a camera
 * distance of 6), not `TYPE_PRESETS.title`'s own large-composition
 * convention verbatim.
 *
 * `backdrop` is the one node here that is *not* left at bare defaults: an
 * explicit near-black `baseColor`. This composition otherwise has a fully
 * transparent background (nothing here sets `Composition.environment` or
 * an opaque full-frame element), and the render genuinely looks
 * professional against it once alpha is composited the way a real video
 * encoder would (verified directly while authoring this scene: white text
 * plus a mid-gray sphere over a transparent background, flattened onto
 * black); a plain PNG viewer showing that same transparency as white
 * instead makes the text read as hollow, which would make a future
 * reviewer opening `references/minimal-defaults.png` directly reasonably
 * suspect a real bug. `backdrop`'s own dark color is a directorial choice
 * every title-card scene needs to make one way or another (same category
 * of decision as camera placement), not a claim about what
 * `resolveMeshMaterial`'s own defaults resolve to - that claim is made by
 * `hero-sphere` alone, which keeps `material: {}` untouched.
 */
function buildProject() {
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const backdrop = Shape({
    id: "backdrop",
    geometryRef: "box",
    transform: { position: [0, 0, -5], rotation: [0, 0, 0], scale: [20, 20, 0.1] },
    material: { baseColor: [0.03, 0.03, 0.04, 1], roughness: 1, metalness: 0 },
  });
  const sphere = Shape({
    id: "hero-sphere",
    geometryRef: "sphere",
    transform: { position: [0, -0.8, 0], rotation: [0, 0, 0], scale: [1.3, 1.3, 1.3] },
    material: {},
    castShadow: true,
    receiveShadow: true,
  });
  const title = Text({
    id: "title",
    ...TYPE_PRESETS.title,
    fontSize: 1,
    transform: { position: [-1.3, 1.4, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    content: CONTENT,
    stagger: {
      ...TYPE_PRESETS.title!.stagger!,
      // Resolved at frame 0 (this scene's own single frame, below): every
      // unit's own reveal must have already finished by then, so this
      // proves the *settled* look, not a mid-reveal one.
      startFrame: -60,
    },
  });

  return buildSingleTrackProject({
    projectId: "p-minimal-defaults",
    compositionId: "comp-minimal-defaults",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: WIDTH,
    height: HEIGHT,
    nodes: [camera, backdrop, sphere, title],
    activeCameraNodeId: "camera-1",
  });
}

/** `computeTextNodeRenderKey` only reads `fontRef`/`content`/`variationAxes`; this node has neither `fontRef` nor `variationAxes`. */
const TEXT_REQUIREMENT_NODE: GoldenSceneTextRequirement["node"] = { content: CONTENT };

export const minimalDefaultsScene: GoldenScene = {
  name: "minimal-defaults",
  driver: "nativeGpuHeadless",
  buildProject,
  compositionId: "comp-minimal-defaults",
  frame: 0,
  width: WIDTH,
  height: HEIGHT,
  seed: "golden-minimal-defaults",
  textRequirements: [
    { node: TEXT_REQUIREMENT_NODE, fontFixtureFileName: "Inter-Variable.ttf", backend: "opentype" },
  ],
};
