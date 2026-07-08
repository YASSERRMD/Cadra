/**
 * Phase 72 task 3: `add_text_node`, the one-step MCP tool that constructs a
 * rich `TextNode` (`@cadra/core`'s `Text()` builder) - content, font, color,
 * and any of the kinetic-typography/effect configs (`stagger`/`physics`/
 * `path`/`morph`/`fill`/`outline`/`glow`/`shadow`/`variationAxes`) - wraps it
 * in a new `Clip`, and inserts it onto an existing scene's timeline, all in
 * one call. Before this tool existed, authoring any of these effects meant
 * hand-writing the full `TextNode` JSON via `update_scene`'s `addNode`
 * patch operation.
 *
 * Mirrors `add_generated_clip`'s own "read, validate, mutate, re-validate,
 * persist" shape (`./generation-clip-tools.ts`) and reuses its exact
 * track-selector semantics (`./track-insertion.ts`).
 *
 * Phase 73's own `typePreset` parameter names one of `@cadra/core`'s
 * `TYPE_PRESETS` (`"title"`/`"lowerThird"`/`"caption"`/`"kineticWordReveal"`)
 * as this call's own starting point for `transform`/`fontSize`/`extrudeDepth`/
 * `stagger`/`physics`/`path`/`morph`/`fill`/`outline`/`glow`/`shadow`: any of
 * those fields this call *also* passes explicitly overrides that one field
 * from the preset, exactly like spreading and overriding `TYPE_PRESETS` in
 * TypeScript directly (`{ ...TYPE_PRESETS.title, fontSize: 120 }`) - the
 * MCP-reachable equivalent, since an agent has no way to `import` that
 * constant itself.
 */
import { Text, TYPE_PRESETS } from "@cadra/core";
import {
  colorRgbaSchema,
  parseScene,
  type SceneDocument,
  textFillSchema,
  textGlowConfigSchema,
  textMorphConfigSchema,
  textOutlineConfigSchema,
  textPathConfigSchema,
  textPhysicsConfigSchema,
  textShadowConfigSchema,
  textStaggerConfigSchema,
  transformSchema,
} from "@cadra/schema";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CadraMcpServerConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { projectContainsNodeId } from "./scene-patch.js";
import { readSceneFile, sanitizeSceneId, writeSceneDocument } from "./scene-store.js";
import {
  insertClipOntoTrack,
  resolveTrackSelector,
  singleDiagnosticFailure,
  type TrackInsertionFailurePayload,
  trackSelectorShape,
} from "./track-insertion.js";

/** Registered tool name for the one-step rich-text-authoring tool. */
export const ADD_TEXT_NODE_TOOL_NAME = "add_text_node";

/** `add_text_node`'s success payload: the new clip/node/track ids and the updated (persisted) scene document. */
interface AddTextNodeSuccessPayload {
  success: true;
  clipId: string;
  textNodeId: string;
  trackId: string;
  document: SceneDocument;
}

/** Wraps a JSON-serializable payload as a single-text-block MCP tool result, matching every other tool in this package. */
function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * Registers `add_text_node` on `server`, persisting through the same
 * `scene-store.ts` primitives every other scene-writing tool in this
 * package uses.
 */
export function registerCadraTextNodeTools(
  server: McpServer,
  config: CadraMcpServerConfig,
  logger: Logger,
): RegisteredTool {
  const toolLogger = logger.child("text-node-tools");

  return server.registerTool(
    ADD_TEXT_NODE_TOOL_NAME,
    {
      title: "Add text node",
      description:
        "Constructs a rich TextNode (content, font, color, and any of stagger/physics/path/morph/" +
        "fill/outline/glow/shadow/variationAxes), wraps it in a new Clip, and inserts it onto an " +
        "existing scene's timeline, in one step - the one-call alternative to hand-writing the " +
        "full TextNode JSON via update_scene. Every field here is a plain (non-keyframed) value; " +
        "keyframe any of them afterward via update_scene if the effect itself needs to change " +
        "over time. Pass typePreset to start from one of @cadra/core's curated TYPE_PRESETS " +
        "(title/lowerThird/caption/kineticWordReveal); any other field passed alongside it " +
        "overrides that one field from the preset.",
      inputSchema: {
        sceneId: z.string().describe("Id of the persisted scene to add the text node to."),
        compositionId: z.string().describe("Id of the composition, within that scene, to add the text node to."),
        ...trackSelectorShape,
        clipId: z.string().describe("Unique id for the new clip within the project."),
        textNodeId: z.string().describe("Unique id for the new TextNode within the project."),
        startFrame: z
          .number()
          .int()
          .min(0)
          .describe("The frame, relative to the start of the composition, the new clip begins on."),
        durationInFrames: z
          .number()
          .int()
          .positive()
          .describe("How many frames the new clip is visible for."),
        typePreset: z
          .enum(Object.keys(TYPE_PRESETS) as [string, ...string[]])
          .optional()
          .describe(
            "Starts from one of @cadra/core's curated TYPE_PRESETS (a tasteful fontSize/transform/" +
              "stagger/outline/glow/shadow combination for a common on-screen role). Any other field " +
              "passed alongside it overrides that one field from the preset.",
          ),
        transform: transformSchema
          .optional()
          .describe("Position/rotation/scale for the new text node. Defaults to identity (origin, no rotation, unit scale), or typePreset's own if given."),
        content: z.string().describe("The text to render."),
        fontRef: z
          .string()
          .optional()
          .describe("Id of a registered font asset. Omitted means the renderer's default."),
        fontSize: z.number().optional().describe("Em size, in world units. Defaults to 24."),
        color: colorRgbaSchema.optional().describe("Base fill color. Defaults to opaque white."),
        extrudeDepth: z
          .number()
          .optional()
          .describe("Extrudes real 3D glyph geometry this far along local Z, instead of flat MSDF quads. Omitted or 0 means flat."),
        stagger: textStaggerConfigSchema
          .optional()
          .describe("A deterministic per-unit staggered reveal animation (typewriter/fadeInUp/lineReveal/wave)."),
        physics: textPhysicsConfigSchema
          .optional()
          .describe("Expressive per-glyph animation (spring/jitter/wave/scramble/countUp), composable with stagger."),
        path: textPathConfigSchema.optional().describe("Places the glyphs along a curve instead of a flat line."),
        morph: textMorphConfigSchema.optional().describe("Crossfade-morphs from another string onto content."),
        fill: textFillSchema.optional().describe("A richer fill than a flat color: gradient, texture, or video."),
        outline: textOutlineConfigSchema.optional().describe("An MSDF-based outline around each glyph."),
        glow: textGlowConfigSchema.optional().describe("A soft glow around each glyph."),
        shadow: textShadowConfigSchema.optional().describe("A drop (or long) shadow behind each glyph."),
        variationAxes: z
          .record(z.string(), z.number())
          .optional()
          .describe("Variable-font axis coordinates (e.g. { wght: 700 }). Omitted means the font's own default instance."),
      },
    },
    async ({
      sceneId,
      compositionId,
      existingTrackId,
      newTrackId,
      newTrackName,
      clipId,
      textNodeId,
      startFrame,
      durationInFrames,
      typePreset,
      transform,
      content,
      fontRef,
      fontSize,
      color,
      extrudeDepth,
      stagger,
      physics,
      path,
      morph,
      fill,
      outline,
      glow,
      shadow,
      variationAxes,
    }) => {
      const idValidation = sanitizeSceneId(sceneId);
      if (!idValidation.valid) {
        return jsonResult(singleDiagnosticFailure("sceneId", idValidation.reason, "INVALID_SCENE_ID"));
      }

      const file = await readSceneFile(config.workspaceRoot, idValidation.sceneId);
      if (file === undefined) {
        return jsonResult(
          singleDiagnosticFailure(
            "sceneId",
            `No scene with id "${idValidation.sceneId}" was found in this workspace.`,
            "SCENE_NOT_FOUND",
            "Call list_scenes to see every scene id currently persisted in this workspace, or " +
              "create_scene to create it first.",
          ),
        );
      }

      const parsed = parseScene(file.raw);
      if (!parsed.success) {
        toolLogger.warn("add_text_node found a persisted scene that no longer validates", {
          sceneId: idValidation.sceneId,
          diagnosticCount: parsed.diagnostics.length,
        });
        return jsonResult({
          success: false,
          diagnostics: parsed.diagnostics,
        } satisfies TrackInsertionFailurePayload);
      }

      const composition = parsed.document.project.compositions.find((c) => c.id === compositionId);
      if (composition === undefined) {
        const availableIds = parsed.document.project.compositions.map((c) => c.id);
        return jsonResult(
          singleDiagnosticFailure(
            "compositionId",
            `Scene "${idValidation.sceneId}" has no composition with id "${compositionId}". ` +
              `Available composition ids: ${availableIds.length > 0 ? availableIds.join(", ") : "(none)"}.`,
            "COMPOSITION_NOT_FOUND",
          ),
        );
      }

      const trackResolution = resolveTrackSelector(composition, existingTrackId, newTrackId);
      if (!trackResolution.ok) {
        return jsonResult(trackResolution.failure);
      }

      if (projectContainsNodeId(parsed.document.project, textNodeId)) {
        return jsonResult(
          singleDiagnosticFailure(
            "textNodeId",
            `A scene node with id "${textNodeId}" already exists in this project. Choose a different id.`,
            "DUPLICATE_NODE_ID",
          ),
        );
      }

      if (
        parsed.document.project.compositions.some((c) =>
          c.tracks.some((track) => track.clips.some((clip) => clip.id === clipId)),
        )
      ) {
        return jsonResult(
          singleDiagnosticFailure(
            "clipId",
            `A clip with id "${clipId}" already exists in this project. Choose a different id.`,
            "DUPLICATE_CLIP_ID",
          ),
        );
      }

      // typePreset supplies the starting value for each field it defines;
      // any of this call's own explicit fields still overrides that one
      // field, exactly like spreading and overriding TYPE_PRESETS directly
      // in TypeScript (`{ ...TYPE_PRESETS.title, fontSize: 120 }`).
      const preset = typePreset !== undefined ? TYPE_PRESETS[typePreset] : undefined;
      const effectiveTransform = transform ?? preset?.transform;
      const effectiveFontSize = fontSize ?? preset?.fontSize;
      const effectiveExtrudeDepth = extrudeDepth ?? preset?.extrudeDepth;
      const effectiveStagger = stagger ?? preset?.stagger;
      const effectivePhysics = physics ?? preset?.physics;
      const effectivePath = path ?? preset?.path;
      const effectiveMorph = morph ?? preset?.morph;
      const effectiveFill = fill ?? preset?.fill;
      const effectiveOutline = outline ?? preset?.outline;
      const effectiveGlow = glow ?? preset?.glow;
      const effectiveShadow = shadow ?? preset?.shadow;

      const textNode = Text({
        id: textNodeId,
        ...(effectiveTransform !== undefined && { transform: effectiveTransform }),
        content,
        ...(fontRef !== undefined && { fontRef }),
        ...(effectiveFontSize !== undefined && { fontSize: effectiveFontSize }),
        ...(color !== undefined && { color }),
        ...(effectiveExtrudeDepth !== undefined && { extrudeDepth: effectiveExtrudeDepth }),
        ...(effectiveStagger !== undefined && { stagger: effectiveStagger }),
        ...(effectivePhysics !== undefined && { physics: effectivePhysics }),
        ...(effectivePath !== undefined && { path: effectivePath }),
        ...(effectiveMorph !== undefined && { morph: effectiveMorph }),
        ...(effectiveFill !== undefined && { fill: effectiveFill }),
        ...(effectiveOutline !== undefined && { outline: effectiveOutline }),
        ...(effectiveGlow !== undefined && { glow: effectiveGlow }),
        ...(effectiveShadow !== undefined && { shadow: effectiveShadow }),
        ...(variationAxes !== undefined && { variationAxes }),
      });

      const updatedProject = insertClipOntoTrack(
        parsed.document.project,
        compositionId,
        trackResolution.trackId,
        trackResolution.createNew,
        newTrackName,
        { id: clipId, startFrame, durationInFrames, node: textNode },
      );

      const candidate = { schemaVersion: parsed.document.schemaVersion, project: updatedProject };
      const revalidated = parseScene(candidate);
      if (!revalidated.success) {
        toolLogger.debug("add_text_node produced an invalid document", {
          sceneId: idValidation.sceneId,
          diagnosticCount: revalidated.diagnostics.length,
        });
        return jsonResult({
          success: false,
          diagnostics: revalidated.diagnostics,
        } satisfies TrackInsertionFailurePayload);
      }

      await writeSceneDocument(config.workspaceRoot, idValidation.sceneId, revalidated.document);
      toolLogger.info("add_text_node inserted a new text node", {
        sceneId: idValidation.sceneId,
        compositionId,
        trackId: trackResolution.trackId,
        clipId,
        textNodeId,
      });

      return jsonResult({
        success: true,
        clipId,
        textNodeId,
        trackId: trackResolution.trackId,
        document: revalidated.document,
      } satisfies AddTextNodeSuccessPayload);
    },
  );
}
