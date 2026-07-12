/**
 * `scene_lint`: a static-analysis check on a persisted scene's composition,
 * catching the exact production lesson memory already encodes ("reveal-only
 * stagger animation reads as 'no animation' to viewers; needs dense camera
 * drift + ambient particles + animated props") before an agent ever renders
 * anything. No pixels are read; every check here works purely from the
 * scene document.
 *
 * Motion density (this module's core metric) is deliberately time-aware,
 * not just "does this node have some keyframe somewhere": a text node whose
 * only animation is a stagger reveal finishing at frame 30 of a 300-frame
 * clip is still flagged, because frames 30-299 have nothing changing.
 * "Active" ranges come from three sources: (1) an authored `KeyframeTrack`
 * with at least two keyframes whose values actually differ (a track with
 * every keyframe pinned to the same value produces no visible motion
 * despite technically having "keyframes"), counted active only between its
 * first and last differing keyframe; (2) continuous per-frame systems with
 * no discrete keyframe list of their own - a non-`"fixed"` `rigidBody`, any
 * `"particles"` node, or a text node's `stagger`/`physics`/`path`/`morph` -
 * treated as active for their whole clip's own duration; (3) recursively,
 * every descendant of a clip's root node, since a static parent can still
 * contain an animated child.
 */
import type {
  Clip,
  Composition,
  KeyframeTrack,
  Project,
  SceneNode,
  Track,
} from "@cadra/core";
import { parseScene } from "@cadra/schema";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CadraMcpServerConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { readSceneFile, sanitizeSceneId } from "./scene-store.js";

/** Registered tool name for the scene motion/static-hold linter. */
export const SCENE_LINT_TOOL_NAME = "scene_lint";

/**
 * Below this fraction of a clip's own duration counted as "motion-active",
 * a clip's visible subject is flagged as a static hold. 15%, not near-zero:
 * a scene that is only, say, 5% active across its own duration still reads
 * as "nothing is happening" to a viewer for the overwhelming majority of
 * its runtime, matching the "reveal-only reads as no animation" lesson
 * this tool exists to catch, not just the zero-motion extreme.
 */
export const STATIC_HOLD_DENSITY_THRESHOLD = 0.15;

/** Below this many frames, a clip is too brief for a static hold to be a meaningful viewer-facing problem; skipped regardless of its own density. */
export const STATIC_HOLD_MIN_DURATION_FRAMES = 15;

/** Node kinds a static-hold warning is worth surfacing for: the "visible subject" kinds. A perfectly still camera or light is normal and not itself a lint concern (though its own animated properties still count toward overallMotionDensity below). */
const STATIC_HOLD_RELEVANT_KINDS: ReadonlySet<SceneNode["kind"]> = new Set([
  "mesh",
  "text",
  "image",
  "video",
  "particles",
  "satori",
  "model",
  "volume",
  "group",
  "compositionRef",
]);

/** A local (clip-relative) frame range, inclusive of both ends, during which something is actively changing. */
interface ActiveFrameRange {
  start: number;
  end: number;
}

function isKeyframeTrack(value: unknown): value is KeyframeTrack<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "keyframeTrack" &&
    Array.isArray((value as { keyframes?: unknown }).keyframes)
  );
}

/**
 * The `[firstDifferingFrame, lastDifferingFrame]` range across `track`'s own
 * keyframes, or `undefined` if fewer than two keyframes exist or every
 * keyframe shares the exact same value (JSON-equal, sufficient for the
 * plain-data value types every animatable property uses).
 */
function activeRangeOfKeyframeTrack(track: KeyframeTrack<unknown>): ActiveFrameRange | undefined {
  const sorted = [...track.keyframes].sort((a, b) => a.frame - b.frame);
  if (sorted.length < 2) {
    return undefined;
  }

  let firstChangeFrame: number | undefined;
  let lastChangeFrame: number | undefined;
  for (let i = 1; i < sorted.length; i += 1) {
    const previousValue = JSON.stringify(sorted[i - 1]!.value);
    const currentValue = JSON.stringify(sorted[i]!.value);
    if (previousValue !== currentValue) {
      firstChangeFrame ??= sorted[i - 1]!.frame;
      lastChangeFrame = sorted[i]!.frame;
    }
  }

  if (firstChangeFrame === undefined || lastChangeFrame === undefined) {
    return undefined;
  }
  return { start: firstChangeFrame, end: lastChangeFrame };
}

/** Recursively finds every `KeyframeTrack` anywhere within `value` (arbitrary nesting - transforms, material params, effect configs, ...) and pushes its active range, if any, onto `ranges`. Does not need to know any node kind's specific field shape: any object matching `KeyframeTrack`'s own discriminant is found, regardless of which field it sits under. */
function collectActiveRangesFromValue(value: unknown, ranges: ActiveFrameRange[]): void {
  if (isKeyframeTrack(value)) {
    const range = activeRangeOfKeyframeTrack(value);
    if (range !== undefined) {
      ranges.push(range);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectActiveRangesFromValue(item, ranges);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const fieldValue of Object.values(value)) {
      collectActiveRangesFromValue(fieldValue, ranges);
    }
  }
}

/** A mesh node's own `rigidBody`, narrowed to just the one field this module reads. */
interface RigidBodyBearing {
  rigidBody?: { bodyType: "dynamic" | "fixed" | "kinematic" };
}

/** A text node's own continuous per-glyph effect fields, narrowed to just presence checks this module needs. */
interface TextEffectBearing {
  stagger?: unknown;
  physics?: unknown;
  path?: unknown;
  morph?: unknown;
}

/**
 * Collects every active range from `node`'s own fields only (never
 * descending into `node.children` - see `collectSubtreeActiveRanges` for
 * that), including continuous systems with no explicit keyframe list of
 * their own: a non-`"fixed"` `rigidBody`, a `"particles"` node (particles
 * are inherently in motion by construction), or a text node's
 * `stagger`/`physics`/`path`/`morph`, each treated as active for the
 * clip's entire own duration.
 */
function collectNodeOwnActiveRanges(node: SceneNode, clipDurationInFrames: number): ActiveFrameRange[] {
  const ranges: ActiveFrameRange[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "children" || key === "id" || key === "kind") {
      continue;
    }
    collectActiveRangesFromValue(value, ranges);
  }

  const wholeClipRange: ActiveFrameRange = { start: 0, end: Math.max(0, clipDurationInFrames - 1) };

  if (node.kind === "mesh") {
    const rigidBody = (node as unknown as RigidBodyBearing).rigidBody;
    if (rigidBody !== undefined && rigidBody.bodyType !== "fixed") {
      ranges.push(wholeClipRange);
    }
  }
  if (node.kind === "particles") {
    ranges.push(wholeClipRange);
  }
  if (node.kind === "text") {
    const effects = node as unknown as TextEffectBearing;
    if (
      effects.stagger !== undefined ||
      effects.physics !== undefined ||
      effects.path !== undefined ||
      effects.morph !== undefined
    ) {
      ranges.push(wholeClipRange);
    }
  }

  return ranges;
}

/** `collectNodeOwnActiveRanges`, recursively across `node` and every descendant: a static parent can still contain an animated child, and the child's own motion still counts toward this clip's overall density. */
function collectSubtreeActiveRanges(node: SceneNode, clipDurationInFrames: number): ActiveFrameRange[] {
  const ranges = collectNodeOwnActiveRanges(node, clipDurationInFrames);
  for (const child of node.children) {
    ranges.push(...collectSubtreeActiveRanges(child, clipDurationInFrames));
  }
  return ranges;
}

/** Unions `ranges` (each already local to `[0, durationInFrames)`, clamped) into a single active-frame count. */
function countUnionedActiveFrames(ranges: readonly ActiveFrameRange[], durationInFrames: number): number {
  if (ranges.length === 0 || durationInFrames <= 0) {
    return 0;
  }
  const active = new Uint8Array(durationInFrames);
  for (const range of ranges) {
    const start = Math.max(0, Math.min(range.start, durationInFrames - 1));
    const end = Math.max(0, Math.min(range.end, durationInFrames - 1));
    for (let frame = start; frame <= end; frame += 1) {
      active[frame] = 1;
    }
  }
  let count = 0;
  for (let i = 0; i < active.length; i += 1) {
    if (active[i] === 1) {
      count += 1;
    }
  }
  return count;
}

/** One clip's own motion analysis: how many (and what fraction) of its own frames have something actively changing anywhere in its node subtree. */
export interface ClipMotionReport {
  trackId: string;
  clipId: string;
  nodeId: string;
  nodeKind: SceneNode["kind"];
  durationInFrames: number;
  activeFrameCount: number;
  motionDensity: number;
}

function analyzeClipMotion(track: Track, clip: Clip): ClipMotionReport {
  const ranges = collectSubtreeActiveRanges(clip.node, clip.durationInFrames);
  const activeFrameCount = countUnionedActiveFrames(ranges, clip.durationInFrames);
  return {
    trackId: track.id,
    clipId: clip.id,
    nodeId: clip.node.id,
    nodeKind: clip.node.kind,
    durationInFrames: clip.durationInFrames,
    activeFrameCount,
    motionDensity: clip.durationInFrames > 0 ? activeFrameCount / clip.durationInFrames : 0,
  };
}

/** A clip flagged as a static hold: its own visible subject barely (or never) changes across a non-trivial duration. */
export interface StaticHoldWarning {
  trackId: string;
  clipId: string;
  nodeId: string;
  nodeKind: SceneNode["kind"];
  durationInFrames: number;
  motionDensity: number;
  message: string;
}

/** `scene_lint`'s full result for one composition. */
export interface SceneLintReport {
  compositionId: string;
  durationInFrames: number;
  /** Fraction of total clip-frame-time (summed across every clip) with something actively changing. 1 means every clip is active for its entire own duration; 0 means nothing in the whole composition ever changes. */
  overallMotionDensity: number;
  staticHolds: StaticHoldWarning[];
}

/** Runs every `scene_lint` check against `composition`, returning a full report (never throws on a "clean" scene - an empty `staticHolds` array is the pass case). */
export function lintComposition(composition: Composition): SceneLintReport {
  const clipReports: ClipMotionReport[] = [];
  for (const track of composition.tracks) {
    for (const clip of track.clips) {
      clipReports.push(analyzeClipMotion(track, clip));
    }
  }

  const totalActiveFrames = clipReports.reduce((sum, report) => sum + report.activeFrameCount, 0);
  const totalClipFrames = clipReports.reduce((sum, report) => sum + report.durationInFrames, 0);
  const overallMotionDensity = totalClipFrames > 0 ? totalActiveFrames / totalClipFrames : 0;

  const staticHolds: StaticHoldWarning[] = clipReports
    .filter(
      (report) =>
        STATIC_HOLD_RELEVANT_KINDS.has(report.nodeKind) &&
        report.durationInFrames >= STATIC_HOLD_MIN_DURATION_FRAMES &&
        report.motionDensity < STATIC_HOLD_DENSITY_THRESHOLD,
    )
    .map((report) => ({
      trackId: report.trackId,
      clipId: report.clipId,
      nodeId: report.nodeId,
      nodeKind: report.nodeKind,
      durationInFrames: report.durationInFrames,
      motionDensity: report.motionDensity,
      message:
        `Clip "${report.clipId}" (${report.nodeKind} node "${report.nodeId}") is only ` +
        `${Math.round(report.motionDensity * 100)}% motion-active across its own ` +
        `${report.durationInFrames} frames - it likely reads as static to a viewer for most of its ` +
        "own duration. Consider continuous motion (camera drift, ambient particles, a looping " +
        "prop animation) rather than a one-time reveal alone.",
    }));

  return {
    compositionId: composition.id,
    durationInFrames: composition.durationInFrames,
    overallMotionDensity,
    staticHolds,
  };
}

/** A `{ success: false, message }` tool result payload, matching every other tool module's own established shape. */
interface SceneLintFailurePayload {
  success: false;
  message: string;
}

/** `scene_lint`'s success payload. */
interface SceneLintSuccessPayload extends SceneLintReport {
  success: true;
}

/** Wraps a JSON-serializable payload as a single-text-block MCP tool result, matching every other tool module's own established convention. */
function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * Registers `scene_lint` on `server`: loads a persisted scene, runs
 * `lintComposition` against one of its compositions, and returns the full
 * report. Read-only - never mutates or persists anything.
 */
export function registerCadraSceneLintTools(
  server: McpServer,
  config: CadraMcpServerConfig,
  _logger: Logger,
): RegisteredTool[] {
  const sceneLintTool = server.registerTool(
    SCENE_LINT_TOOL_NAME,
    {
      title: "Scene lint",
      description:
        "Static-analysis check on a scene's composition, catching the 'reveal-only animation " +
        "reads as no animation' problem before you ever render anything: computes a time-aware " +
        "motion-density score (what fraction of each clip's own duration has something actually " +
        "changing, not just 'does it have some keyframe somewhere') and flags visible-subject " +
        "clips (mesh/text/image/video/particles/...) that hold static for most of a non-trivial " +
        "duration. A camera orbit, rigidBody, particles node, or text stagger/physics/path/morph " +
        "all count as motion; a keyframe track whose values never actually change does not.",
      inputSchema: {
        sceneId: z.string().describe("Id of the scene (as persisted by create_scene/update_scene) to lint."),
        compositionId: z.string().describe("Id of the composition, within that scene, to lint."),
      },
    },
    async ({ sceneId, compositionId }) => {
      const idValidation = sanitizeSceneId(sceneId);
      if (!idValidation.valid) {
        return jsonResult({ success: false, message: idValidation.reason } satisfies SceneLintFailurePayload);
      }

      const file = await readSceneFile(config.workspaceRoot, idValidation.sceneId);
      if (file === undefined) {
        return jsonResult({
          success: false,
          message:
            `No scene with id "${idValidation.sceneId}" was found in this workspace. Call ` +
            "list_scenes to see every scene id currently persisted, or create_scene to create it first.",
        } satisfies SceneLintFailurePayload);
      }

      const parsed = parseScene(file.raw);
      if (!parsed.success) {
        return jsonResult({
          success: false,
          message:
            `Scene "${idValidation.sceneId}" is persisted but no longer validates against the ` +
            "current scene schema; call get_scene or validate_scene for full diagnostics.",
        } satisfies SceneLintFailurePayload);
      }

      const project: Project = parsed.document.project;
      const composition = project.compositions.find((c) => c.id === compositionId);
      if (composition === undefined) {
        const availableIds = project.compositions.map((c) => c.id);
        return jsonResult({
          success: false,
          message:
            `Scene "${idValidation.sceneId}" has no composition with id "${compositionId}". ` +
            `Available composition ids: ${availableIds.length > 0 ? availableIds.join(", ") : "(none)"}.`,
        } satisfies SceneLintFailurePayload);
      }

      const report = lintComposition(composition);
      return jsonResult({ success: true, ...report } satisfies SceneLintSuccessPayload);
    },
  );

  return [sceneLintTool];
}
