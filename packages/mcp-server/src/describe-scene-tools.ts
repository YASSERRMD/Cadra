/**
 * `describe_scene`: a compact structural outline of one persisted scene -
 * every composition, track, clip, and the node kind/id/name shape of each
 * clip's own node subtree - without any of the bulky per-property data
 * (transforms, materials, colors, keyframe tracks, ...) `get_scene`'s full
 * document dump necessarily carries. For an agent that only needs to know
 * "what's in this scene and how is it organized" (e.g. before deciding
 * which node id to target with an update_scene patch), this is a much
 * smaller, easier-to-reason-about read than the full JSON.
 */
import type { Clip, Composition, Project, SceneNode, Track } from "@cadra/core";
import { parseScene } from "@cadra/schema";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CadraMcpServerConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { readSceneFile, sanitizeSceneId } from "./scene-store.js";

/** Registered tool name for the compact scene structural summary. */
export const DESCRIBE_SCENE_TOOL_NAME = "describe_scene";

/** A node's own compact outline: identity plus its children's outlines, recursively - never any other field. */
export interface NodeOutline {
  id: string;
  kind: SceneNode["kind"];
  name?: string;
  children: NodeOutline[];
}

function describeNode(node: SceneNode): NodeOutline {
  return {
    id: node.id,
    kind: node.kind,
    ...(node.name !== undefined && { name: node.name }),
    children: node.children.map(describeNode),
  };
}

/** One clip's own compact outline. */
export interface ClipOutline {
  id: string;
  startFrame: number;
  durationInFrames: number;
  hasTransition: boolean;
  node: NodeOutline;
}

function describeClip(clip: Clip): ClipOutline {
  return {
    id: clip.id,
    startFrame: clip.startFrame,
    durationInFrames: clip.durationInFrames,
    hasTransition: clip.transitionIn !== undefined,
    node: describeNode(clip.node),
  };
}

/** One track's own compact outline. */
export interface TrackOutline {
  id: string;
  name?: string;
  clips: ClipOutline[];
}

function describeTrack(track: Track): TrackOutline {
  return {
    id: track.id,
    ...(track.name !== undefined && { name: track.name }),
    clips: track.clips.map(describeClip),
  };
}

/** One composition's own compact outline. */
export interface CompositionOutline {
  id: string;
  name: string;
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
  renderMode?: Composition["renderMode"];
  hasActiveCameraTrack: boolean;
  audioTrackCount: number;
  tracks: TrackOutline[];
}

function describeComposition(composition: Composition): CompositionOutline {
  return {
    id: composition.id,
    name: composition.name,
    fps: composition.fps,
    durationInFrames: composition.durationInFrames,
    width: composition.width,
    height: composition.height,
    ...(composition.renderMode !== undefined && { renderMode: composition.renderMode }),
    hasActiveCameraTrack: (composition.activeCameraTrack?.length ?? 0) > 0,
    audioTrackCount: composition.audioTracks?.length ?? 0,
    tracks: composition.tracks.map(describeTrack),
  };
}

/** A full scene document's own compact outline - `describe_scene`'s actual return shape. */
export interface SceneOutline {
  sceneId: string;
  name: string;
  schemaVersion: number;
  compositions: CompositionOutline[];
}

/** Builds `sceneId`'s full compact outline from an already-parsed `project`. Exported for reuse/unit testing independent of the MCP tool wrapper. */
export function describeScene(sceneId: string, schemaVersion: number, project: Project): SceneOutline {
  return {
    sceneId,
    name: project.name,
    schemaVersion,
    compositions: project.compositions.map(describeComposition),
  };
}

interface DescribeSceneFailurePayload {
  success: false;
  message: string;
}

interface DescribeSceneSuccessPayload extends SceneOutline {
  success: true;
}

function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * Registers `describe_scene` on `server`. Read-only, never mutates or
 * persists anything.
 */
export function registerCadraDescribeSceneTools(
  server: McpServer,
  config: CadraMcpServerConfig,
  _logger: Logger,
): RegisteredTool[] {
  const describeSceneTool = server.registerTool(
    DESCRIBE_SCENE_TOOL_NAME,
    {
      title: "Describe scene",
      description:
        "Returns a compact structural outline of a persisted scene: every composition, track, " +
        "clip, and each clip's own node subtree (id/kind/name only, recursively) - everything you " +
        "need to know what's in a scene and which node id to target next, without get_scene's full " +
        "per-property JSON (transforms, materials, colors, keyframe tracks, ...).",
      inputSchema: {
        sceneId: z.string().describe("Id of the scene (as persisted by create_scene/update_scene) to describe."),
      },
    },
    async ({ sceneId }) => {
      const idValidation = sanitizeSceneId(sceneId);
      if (!idValidation.valid) {
        return jsonResult({ success: false, message: idValidation.reason } satisfies DescribeSceneFailurePayload);
      }

      const file = await readSceneFile(config.workspaceRoot, idValidation.sceneId);
      if (file === undefined) {
        return jsonResult({
          success: false,
          message:
            `No scene with id "${idValidation.sceneId}" was found in this workspace. Call ` +
            "list_scenes to see every scene id currently persisted, or create_scene to create it first.",
        } satisfies DescribeSceneFailurePayload);
      }

      const parsed = parseScene(file.raw);
      if (!parsed.success) {
        return jsonResult({
          success: false,
          message:
            `Scene "${idValidation.sceneId}" is persisted but no longer validates against the ` +
            "current scene schema; call get_scene or validate_scene for full diagnostics.",
        } satisfies DescribeSceneFailurePayload);
      }

      const outline = describeScene(idValidation.sceneId, parsed.document.schemaVersion, parsed.document.project);
      return jsonResult({ success: true, ...outline } satisfies DescribeSceneSuccessPayload);
    },
  );

  return [describeSceneTool];
}
