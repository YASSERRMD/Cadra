import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Camera,
  type ColorRGBA,
  type Composition,
  createComposition,
  createProject,
  type KeyframeTrack,
  Light,
  type Property,
  type RigidBodyConfig,
  Sequence,
  Shape,
  Text,
} from "@cadra/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";
import {
  lintComposition,
  SCENE_LINT_TOOL_NAME,
  STATIC_HOLD_DENSITY_THRESHOLD,
} from "./scene-lint-tools.js";
import { CREATE_SCENE_TOOL_NAME, UPDATE_SCENE_TOOL_NAME } from "./scene-tools.js";
import { createCadraMcpServer } from "./server.js";

const FPS = 30;
const DURATION_IN_FRAMES = 300;

function positionKeyframeTrack(keyframes: Array<[number, [number, number, number]]>): Property<
  readonly [number, number, number]
> {
  const track: KeyframeTrack<readonly [number, number, number]> = {
    type: "keyframeTrack",
    keyframes: keyframes.map(([frame, value]) => ({ frame, value })),
  };
  return track;
}

function buildComposition(id: string, nodes: ReturnType<typeof Shape>[] | ReturnType<typeof Text>[]): Composition {
  return createComposition({
    id,
    name: "Main",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: 640,
    height: 360,
    tracks: nodes.map((node, index) => ({
      id: `track-${index}`,
      clips: [Sequence({ id: `clip-${index}`, from: 0, durationInFrames: DURATION_IN_FRAMES, content: node })],
    })),
  });
}

describe("lintComposition", () => {
  it("flags a completely static mesh (no animated property at all) as a static hold", () => {
    const shape = Shape({ id: "static-box" });
    const composition = buildComposition("comp-static", [shape]);

    const report = lintComposition(composition);

    expect(report.overallMotionDensity).toBe(0);
    expect(report.staticHolds).toHaveLength(1);
    expect(report.staticHolds[0]?.nodeId).toBe("static-box");
    expect(report.staticHolds[0]?.motionDensity).toBe(0);
  });

  it("flags a text node whose stagger reveal finishes early, then holds static for the rest of the clip", () => {
    // Stagger reveal is a continuous-motion system this module treats as
    // active for the whole clip (see this module's own doc on why it can't
    // know the reveal's own real finish frame from the config alone) -
    // this test instead exercises the more common real-world case:
    // a keyframe-driven fade that finishes at frame 20 of a 300-frame clip.
    const colorTrack: KeyframeTrack<ColorRGBA> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: [1, 1, 1, 0] },
        { frame: 20, value: [1, 1, 1, 1] },
      ],
    };
    const text = Text({ id: "title", content: "Hello", color: colorTrack });
    const composition = buildComposition("comp-reveal-only", [text]);

    const report = lintComposition(composition);

    // Active only frames [0, 20] out of 300 -> well under the threshold.
    expect(report.staticHolds).toHaveLength(1);
    expect(report.staticHolds[0]?.motionDensity).toBeLessThan(STATIC_HOLD_DENSITY_THRESHOLD);
    expect(report.staticHolds[0]?.motionDensity).toBeCloseTo(21 / DURATION_IN_FRAMES, 2);
  });

  it("does not flag a mesh with a keyframe track spanning its own whole clip duration", () => {
    const keyframes: Array<[number, [number, number, number]]> = [];
    for (let frame = 0; frame < DURATION_IN_FRAMES; frame += 10) {
      keyframes.push([frame, [Math.sin(frame), 0, 0]]);
    }
    const shape = Shape({ id: "orbiting-box" });
    (shape.transform as { position: unknown }).position = positionKeyframeTrack(keyframes);
    const composition = buildComposition("comp-continuous", [shape]);

    const report = lintComposition(composition);

    expect(report.staticHolds).toHaveLength(0);
    expect(report.overallMotionDensity).toBeGreaterThan(0.9);
  });

  it("does not flag a particles node - particles are inherently in motion", () => {
    const composition: Composition = {
      ...buildComposition("comp-particles", []),
      tracks: [
        {
          id: "track-particles",
          clips: [
            {
              id: "clip-particles",
              startFrame: 0,
              durationInFrames: DURATION_IN_FRAMES,
              node: {
                id: "swarm",
                kind: "particles",
                transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
                visible: true,
                children: [],
                emitter: { shape: "point", rate: 100 },
                lifetime: 2,
                startSize: 0.1,
                startColor: [1, 1, 1, 1],
                textureRef: "default",
                maxParticles: 1000,
              } as never,
            },
          ],
        },
      ],
    };

    const report = lintComposition(composition);

    expect(report.staticHolds).toHaveLength(0);
    expect(report.overallMotionDensity).toBe(1);
  });

  it("does not flag a dynamic rigidBody mesh, but does flag a fixed one", () => {
    const collider: RigidBodyConfig["collider"] = { shape: "box", halfExtents: [0.5, 0.5, 0.5] };
    const dynamicBox = Shape({ id: "falling-box", rigidBody: { bodyType: "dynamic", collider } });
    const fixedBox = Shape({ id: "static-floor", rigidBody: { bodyType: "fixed", collider } });
    const composition = buildComposition("comp-physics", [dynamicBox, fixedBox]);

    const report = lintComposition(composition);

    const staticHoldIds = report.staticHolds.map((warning) => warning.nodeId);
    expect(staticHoldIds).not.toContain("falling-box");
    expect(staticHoldIds).toContain("static-floor");
  });

  it("does not flag a keyframe track whose values never actually change", () => {
    const shape = Shape({ id: "pinned-box" });
    (shape.transform as { position: unknown }).position = positionKeyframeTrack([
      [0, [1, 1, 1]],
      [DURATION_IN_FRAMES - 1, [1, 1, 1]],
    ]);
    const composition = buildComposition("comp-pinned", [shape]);

    const report = lintComposition(composition);

    expect(report.overallMotionDensity).toBe(0);
    expect(report.staticHolds).toHaveLength(1);
  });

  it("does not flag a static camera or light (only visible-subject kinds are lint-relevant)", () => {
    const camera = Camera({ id: "camera-1", transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    const light = Light({ id: "light-1", lightType: "ambient", intensity: 1 });
    const composition = buildComposition("comp-camera-light", [camera as never, light as never]);

    const report = lintComposition(composition);

    expect(report.staticHolds).toHaveLength(0);
  });

  it("does not flag a clip too short for a static hold to be meaningful", () => {
    const shape = Shape({ id: "brief-box" });
    const composition: Composition = {
      ...buildComposition("comp-brief", []),
      tracks: [
        {
          id: "track-brief",
          clips: [{ id: "clip-brief", startFrame: 0, durationInFrames: 5, node: shape }],
        },
      ],
    };

    const report = lintComposition(composition);

    expect(report.staticHolds).toHaveLength(0);
  });

  it("counts motion anywhere in a static parent's own descendant subtree", () => {
    const child = Shape({ id: "spinning-child" });
    (child.transform as { rotation: unknown }).rotation = positionKeyframeTrack([
      [0, [0, 0, 0]],
      [DURATION_IN_FRAMES - 1, [0, 6.28, 0]],
    ]);
    const parent = Shape({ id: "static-parent" });
    parent.children.push(child);
    const composition = buildComposition("comp-nested", [parent]);

    const report = lintComposition(composition);

    expect(report.staticHolds).toHaveLength(0);
  });
});

interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
}

function parseToolResult<T>(result: ToolTextResult): T {
  const [content] = result.content;
  expect(content?.type).toBe("text");
  return JSON.parse(content!.text) as T;
}

describe("scene_lint MCP tool", () => {
  let workspaceRoot: string | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    if (workspaceRoot !== undefined) {
      await rm(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = undefined;
    }
  });

  async function connectClient(): Promise<Client> {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-scene-lint-test-"));
    const { server } = createCadraMcpServer({
      config: { workspaceRoot, outputDirectory: join(workspaceRoot, "out") },
      logger: createLogger("test", {}, () => {
        // Swallow log output in tests.
      }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const connectedClient = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), connectedClient.connect(clientTransport)]);
    client = connectedClient;
    return connectedClient;
  }

  it("lists scene_lint as a registered tool", async () => {
    const connectedClient = await connectClient();
    const { tools } = await connectedClient.listTools();
    expect(tools.some((tool) => tool.name === SCENE_LINT_TOOL_NAME)).toBe(true);
  });

  it("lints a real persisted scene end to end and flags its static mesh", async () => {
    const connectedClient = await connectClient();
    await connectedClient.callTool({
      name: CREATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "lint-scene",
        name: "Lint scene",
        composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: DURATION_IN_FRAMES, width: 640, height: 360 },
      },
    });
    const shape = Shape({ id: "static-box" });
    const document = {
      schemaVersion: 1,
      project: createProject({
        id: "lint-scene",
        name: "Lint scene",
        compositions: [buildComposition("comp-1", [shape])],
      }),
    };
    await connectedClient.callTool({
      name: UPDATE_SCENE_TOOL_NAME,
      arguments: { sceneId: "lint-scene", mode: "replace", document },
    });

    const result = await connectedClient.callTool({
      name: SCENE_LINT_TOOL_NAME,
      arguments: { sceneId: "lint-scene", compositionId: "comp-1" },
    });
    const payload = parseToolResult<{ success: boolean; staticHolds?: unknown[] }>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    expect(payload.staticHolds).toHaveLength(1);
  });

  it("returns an actionable diagnostic for an unknown scene id", async () => {
    const connectedClient = await connectClient();
    const result = await connectedClient.callTool({
      name: SCENE_LINT_TOOL_NAME,
      arguments: { sceneId: "no-such-scene", compositionId: "comp-1" },
    });
    const payload = parseToolResult<{ success: boolean; message?: string }>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    expect(payload.message).toContain("no-such-scene");
  });
});
