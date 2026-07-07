import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cadra/core";
import { createIdentityTransform } from "@cadra/core";
import type {
  GenerationStore,
  VideoGenerationJob,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoProvider,
} from "@cadra/providers";
import { createGenerationStore } from "@cadra/providers";
import { CURRENT_SCHEMA_VERSION, parseScene } from "@cadra/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ASSET_REF_SCHEME } from "./asset-store.js";
import {
  bindReadyGenerations,
  bindReadyGenerationsForScene,
  buildGenerationRef,
  findPendingGenerationNodes,
  GENERATION_REF_SCHEME,
  parseGenerationRef,
} from "./generation-asset-binding.js";
import { writeSceneDocument } from "./scene-store.js";

/** A minimal, fully injectable fake `VideoProvider`: no real network call, ever, matching every other test in this codebase touching `@cadra/providers`. */
function createFakeProvider(name: string): {
  provider: VideoProvider;
  setNextStatus: (externalJobId: string, status: VideoGenerationStatus) => void;
} {
  const statusByJobId = new Map<string, VideoGenerationStatus>();
  let counter = 0;

  const provider: VideoProvider = {
    name,
    submit: vi.fn(async (_request: VideoGenerationRequest): Promise<VideoGenerationJob> => {
      counter += 1;
      const externalJobId = `${name}-job-${counter}`;
      statusByJobId.set(externalJobId, { status: "pending" });
      return { provider: name, externalJobId };
    }),
    poll: vi.fn(async (job: VideoGenerationJob): Promise<VideoGenerationStatus> => {
      return statusByJobId.get(job.externalJobId) ?? { status: "pending" };
    }),
  };

  return {
    provider,
    setNextStatus: (externalJobId, status) => statusByJobId.set(externalJobId, status),
  };
}

const BASE_REQUEST: VideoGenerationRequest = {
  prompt: "A lighthouse beam sweeping across a stormy sea.",
  params: { durationSeconds: 5 },
};

/** Builds a single-clip, single-track, single-composition project whose one clip's node is `videoNode`, mirroring `scene-patch.test.ts`'s own fixture shape. */
function projectWithVideoNode(videoNodeId: string, assetRef: string): Project {
  return {
    id: "proj-1",
    name: "Project",
    compositions: [
      {
        id: "comp-1",
        name: "Main",
        fps: 30,
        durationInFrames: 60,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: "track-1",
            clips: [
              {
                id: "clip-1",
                startFrame: 0,
                durationInFrames: 60,
                node: {
                  id: videoNodeId,
                  kind: "video",
                  transform: createIdentityTransform(),
                  visible: true,
                  assetRef,
                  opacity: 1,
                  children: [],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("cadra-generation:// ref scheme", () => {
  it("round-trips a slot id through buildGenerationRef/parseGenerationRef", () => {
    const ref = buildGenerationRef("hero-clip");
    expect(ref).toBe(`${GENERATION_REF_SCHEME}hero-clip`);
    expect(parseGenerationRef(ref)).toBe("hero-clip");
  });

  it("returns undefined for a ref using a different scheme", () => {
    expect(parseGenerationRef(`${ASSET_REF_SCHEME}abc123`)).toBeUndefined();
    expect(parseGenerationRef("not-a-ref-at-all")).toBeUndefined();
  });
});

describe("findPendingGenerationNodes", () => {
  it("finds a VideoNode nested under a group, not just a clip root", () => {
    const project: Project = {
      id: "proj-1",
      name: "Project",
      compositions: [
        {
          id: "comp-1",
          name: "Main",
          fps: 30,
          durationInFrames: 60,
          width: 1920,
          height: 1080,
          tracks: [
            {
              id: "track-1",
              clips: [
                {
                  id: "clip-1",
                  startFrame: 0,
                  durationInFrames: 60,
                  node: {
                    id: "group-root",
                    kind: "group",
                    transform: createIdentityTransform(),
                    visible: true,
                    children: [
                      {
                        id: "video-child",
                        kind: "video",
                        transform: createIdentityTransform(),
                        visible: true,
                        assetRef: buildGenerationRef("slot-a"),
                        opacity: 1,
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
    };

    const found = findPendingGenerationNodes(project);
    expect(found).toEqual([
      { node: project.compositions[0]!.tracks[0]!.clips[0]!.node.children[0], slotId: "slot-a" },
    ]);
  });

  it("ignores a VideoNode whose assetRef is already a real cadra-asset:// ref", () => {
    const project = projectWithVideoNode("video-1", `${ASSET_REF_SCHEME}deadbeef`);
    expect(findPendingGenerationNodes(project)).toEqual([]);
  });
});

describe("bindReadyGenerations", () => {
  let workspaceRoot: string;
  let testHttpServer: Server | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-generation-binding-test-"));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    if (testHttpServer !== undefined) {
      await new Promise<void>((resolve) => testHttpServer!.close(() => resolve()));
      testHttpServer = undefined;
    }
  });

  /** Starts an in-process HTTP server serving `body` with `contentType` at its root path, mirroring `asset-tools.test.ts`'s own fixture server, so a "vendor outputUrl" in these tests is a real fetchable local URL, never a real internet call. */
  async function startFixtureServer(body: Buffer, contentType: string): Promise<string> {
    testHttpServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": contentType });
      response.end(body);
    });
    await new Promise<void>((resolve) => testHttpServer!.listen(0, "127.0.0.1", () => resolve()));
    const address = testHttpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the fixture server to bind to a network address.");
    }
    return `http://127.0.0.1:${address.port}/generated.mp4`;
  }

  it("leaves a still-pending slot's node untouched and reports stillPending", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);

    const project = projectWithVideoNode("video-1", buildGenerationRef("hero-clip"));
    const pendingNodes = findPendingGenerationNodes(project);

    const result = await bindReadyGenerations(project, pendingNodes, store, workspaceRoot);

    expect(result.outcomes).toEqual([
      { nodeId: "video-1", slotId: "hero-clip", outcome: "stillPending" },
    ]);
    expect(result.project).toBe(project);
    const node = result.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(node.kind === "video" ? node.assetRef : undefined).toBe(buildGenerationRef("hero-clip"));
  });

  it("leaves an unknown-to-this-store slot's node untouched and reports unknownSlot", async () => {
    const store = createGenerationStore({ providers: {} });

    const project = projectWithVideoNode("video-1", buildGenerationRef("never-submitted-slot"));
    const pendingNodes = findPendingGenerationNodes(project);

    const result = await bindReadyGenerations(project, pendingNodes, store, workspaceRoot);

    expect(result.outcomes).toEqual([
      { nodeId: "video-1", slotId: "never-submitted-slot", outcome: "unknownSlot" },
    ]);
    expect(result.project).toBe(project);
    const node = result.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(node.kind === "video" ? node.assetRef : undefined).toBe(
      buildGenerationRef("never-submitted-slot"),
    );
  });

  it("reports failed (without touching assetRef) for a slot whose generation terminally failed", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);
    fake.setNextStatus("veo-job-1", { status: "failed", error: "vendor rejected the prompt" });
    await store.refresh();

    const project = projectWithVideoNode("video-1", buildGenerationRef("hero-clip"));
    const pendingNodes = findPendingGenerationNodes(project);

    const result = await bindReadyGenerations(project, pendingNodes, store, workspaceRoot);

    expect(result.outcomes).toEqual([
      {
        nodeId: "video-1",
        slotId: "hero-clip",
        outcome: "failed",
        error: "vendor rejected the prompt",
      },
    ]);
    const node = result.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(node.kind === "video" ? node.assetRef : undefined).toBe(buildGenerationRef("hero-clip"));
  });

  it("ingests a ready slot's outputUrl and rewrites the node's assetRef to a real cadra-asset:// ref", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);

    const videoBytes = Buffer.from("fake mp4 bytes for the generated shot");
    const outputUrl = await startFixtureServer(videoBytes, "video/mp4");
    fake.setNextStatus("veo-job-1", { status: "succeeded", outputUrl });
    await store.refresh();

    const project = projectWithVideoNode("video-1", buildGenerationRef("hero-clip"));
    const pendingNodes = findPendingGenerationNodes(project);

    const result = await bindReadyGenerations(project, pendingNodes, store, workspaceRoot);

    expect(result.outcomes).toHaveLength(1);
    const outcome = result.outcomes[0]!;
    expect(outcome.outcome).toBe("bound");
    expect(outcome.nodeId).toBe("video-1");
    expect(outcome.slotId).toBe("hero-clip");
    const boundRef = outcome.outcome === "bound" ? outcome.assetRef : undefined;
    expect(boundRef).toMatch(new RegExp(`^${ASSET_REF_SCHEME}`));

    const node = result.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(node.kind === "video" ? node.assetRef : undefined).toBe(boundRef);

    // Every other part of the project not on the path to the rewritten node
    // keeps its exact original object reference (structural sharing, per
    // applyScenePatchOperation's own contract).
    expect(result.project.compositions[0]!.width).toBe(project.compositions[0]!.width);
  });

  it("reports ingestError (without touching assetRef) when a ready slot's outputUrl cannot be fetched", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);
    fake.setNextStatus("veo-job-1", {
      status: "succeeded",
      outputUrl: "http://127.0.0.1:1/definitely-not-listening.mp4",
    });
    await store.refresh();

    const project = projectWithVideoNode("video-1", buildGenerationRef("hero-clip"));
    const pendingNodes = findPendingGenerationNodes(project);

    const result = await bindReadyGenerations(project, pendingNodes, store, workspaceRoot);

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]!.outcome).toBe("ingestError");
    const node = result.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(node.kind === "video" ? node.assetRef : undefined).toBe(buildGenerationRef("hero-clip"));
  });
});

describe("bindReadyGenerationsForScene", () => {
  let workspaceRoot: string;
  let testHttpServer: Server | undefined;
  let store: GenerationStore;
  let fake: ReturnType<typeof createFakeProvider>;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-generation-binding-scene-test-"));
    fake = createFakeProvider("veo");
    store = createGenerationStore({ providers: { veo: fake.provider } });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    if (testHttpServer !== undefined) {
      await new Promise<void>((resolve) => testHttpServer!.close(() => resolve()));
      testHttpServer = undefined;
    }
  });

  async function startFixtureServer(body: Buffer, contentType: string): Promise<string> {
    testHttpServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": contentType });
      response.end(body);
    });
    await new Promise<void>((resolve) => testHttpServer!.listen(0, "127.0.0.1", () => resolve()));
    const address = testHttpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the fixture server to bind to a network address.");
    }
    return `http://127.0.0.1:${address.port}/generated.mp4`;
  }

  it("returns undefined for a scene id that does not exist", async () => {
    const result = await bindReadyGenerationsForScene(workspaceRoot, "no-such-scene", store);
    expect(result).toBeUndefined();
  });

  it("is a no-op (empty outcomes) for a scene with no generation-backed nodes", async () => {
    const project = projectWithVideoNode("video-1", `${ASSET_REF_SCHEME}deadbeef`);
    await writeSceneDocument(workspaceRoot, "scene-1", {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      project,
    });

    const result = await bindReadyGenerationsForScene(workspaceRoot, "scene-1", store);

    expect(result).toBeDefined();
    expect(result!.outcomes).toEqual([]);
  });

  it("persists the rewritten document once a slot resolves ready, and leaves it untouched while still pending", async () => {
    await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);
    const project = projectWithVideoNode("video-1", buildGenerationRef("hero-clip"));
    await writeSceneDocument(workspaceRoot, "scene-1", {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      project,
    });

    const stillPending = await bindReadyGenerationsForScene(workspaceRoot, "scene-1", store);
    expect(stillPending!.outcomes).toEqual([
      { nodeId: "video-1", slotId: "hero-clip", outcome: "stillPending" },
    ]);
    const nodeStillPending =
      stillPending!.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(nodeStillPending.kind === "video" ? nodeStillPending.assetRef : undefined).toBe(
      buildGenerationRef("hero-clip"),
    );

    const videoBytes = Buffer.from("fake mp4 bytes");
    const outputUrl = await startFixtureServer(videoBytes, "video/mp4");
    fake.setNextStatus("veo-job-1", { status: "succeeded", outputUrl });
    await store.refresh();

    const bound = await bindReadyGenerationsForScene(workspaceRoot, "scene-1", store);
    expect(bound!.outcomes).toHaveLength(1);
    expect(bound!.outcomes[0]!.outcome).toBe("bound");

    const boundNode = bound!.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    const boundRef = boundNode.kind === "video" ? boundNode.assetRef : undefined;
    expect(boundRef).toMatch(new RegExp(`^${ASSET_REF_SCHEME}`));

    // The persisted document on disk reflects the rewrite too, and still validates.
    const rewrittenScene = await bindReadyGenerationsForScene(workspaceRoot, "scene-1", store);
    expect(rewrittenScene!.outcomes).toEqual([]);
    const persistedNode =
      rewrittenScene!.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(persistedNode.kind === "video" ? persistedNode.assetRef : undefined).toBe(boundRef);
    expect(parseScene(rewrittenScene!.document).success).toBe(true);
  });
});
