import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  GenerationStore,
  SlotResolution,
  VideoGenerationJob,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoProvider,
} from "@cadra/providers";
import { createGenerationStore } from "@cadra/providers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET_GENERATION_STATUS_TOOL_NAME } from "./generation-tools.js";
import { createLogger } from "./logger.js";
import { createCadraMcpServer } from "./server.js";

/** Shape every tool in this package returns its JSON payload as: one text content block. */
interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
}

function parseToolResult<T>(result: ToolTextResult): T {
  const [content] = result.content;
  expect(content).toBeDefined();
  expect(content?.type).toBe("text");
  return JSON.parse(content!.text) as T;
}

interface FailurePayload {
  success: false;
  message: string;
}

interface StatusSuccessPayload {
  success: true;
  slotId: string;
  resolution: SlotResolution;
}

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

describe("Cadra MCP generation tools", () => {
  let workspaceRoot: string;
  let client: Client | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-generation-tools-test-"));
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  async function connectClient(store?: GenerationStore): Promise<Client> {
    const { server } = createCadraMcpServer({
      config: { workspaceRoot, outputDirectory: join(workspaceRoot, "out") },
      logger: createLogger("test", {}, () => {
        // Swallow log output in tests.
      }),
      ...(store !== undefined ? { generation: { store } } : {}),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const newClient = new Client({ name: "test-client", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), newClient.connect(clientTransport)]);

    client = newClient;
    return newClient;
  }

  it("lists the get_generation_status tool", async () => {
    const connectedClient = await connectClient();
    const { tools } = await connectedClient.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain(GET_GENERATION_STATUS_TOOL_NAME);
  });

  it("reports failure for a slot id that was never submitted, with no store injected (empty default store)", async () => {
    const connectedClient = await connectClient();

    const result = await connectedClient.callTool({
      name: GET_GENERATION_STATUS_TOOL_NAME,
      arguments: { slotId: "no-such-slot" },
    });
    const payload = parseToolResult<FailurePayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    expect(payload.message).toContain("no-such-slot");
  });

  it("reports a pending placeholder for a slot whose generation is still running", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);

    const connectedClient = await connectClient(store);
    const result = await connectedClient.callTool({
      name: GET_GENERATION_STATUS_TOOL_NAME,
      arguments: { slotId: "hero-clip" },
    });
    const payload = parseToolResult<StatusSuccessPayload>(result as ToolTextResult);

    expect(payload).toEqual({
      success: true,
      slotId: "hero-clip",
      resolution: { status: "pending", placeholder: { kind: "spinner" } },
    });
  });

  it("reports ready with the vendor's outputUrl once the store has observed success", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);
    fake.setNextStatus("veo-job-1", { status: "succeeded", outputUrl: "https://vendor.example/hero.mp4" });
    await store.refresh();

    const connectedClient = await connectClient(store);
    const result = await connectedClient.callTool({
      name: GET_GENERATION_STATUS_TOOL_NAME,
      arguments: { slotId: "hero-clip" },
    });
    const payload = parseToolResult<StatusSuccessPayload>(result as ToolTextResult);

    expect(payload).toEqual({
      success: true,
      slotId: "hero-clip",
      resolution: { status: "ready", outputUrl: "https://vendor.example/hero.mp4" },
    });
  });

  it("reports failed with the vendor's error once the store has observed failure", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);
    fake.setNextStatus("veo-job-1", { status: "failed", error: "vendor rejected the prompt" });
    await store.refresh();

    const connectedClient = await connectClient(store);
    const result = await connectedClient.callTool({
      name: GET_GENERATION_STATUS_TOOL_NAME,
      arguments: { slotId: "hero-clip" },
    });
    const payload = parseToolResult<StatusSuccessPayload>(result as ToolTextResult);

    expect(payload).toEqual({
      success: true,
      slotId: "hero-clip",
      resolution: { status: "failed", error: "vendor rejected the prompt" },
    });
  });

  it("reports a lastKnownFrame placeholder for a regenerating slot with a prior successful result", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    await store.submitGeneration("hero-clip", "veo", BASE_REQUEST);
    fake.setNextStatus("veo-job-1", { status: "succeeded", outputUrl: "https://vendor.example/first.mp4" });
    await store.refresh();
    await store.regenerateSlot("hero-clip", { params: { ...BASE_REQUEST.params, seed: 999 } });

    const connectedClient = await connectClient(store);
    const result = await connectedClient.callTool({
      name: GET_GENERATION_STATUS_TOOL_NAME,
      arguments: { slotId: "hero-clip" },
    });
    const payload = parseToolResult<StatusSuccessPayload>(result as ToolTextResult);

    expect(payload).toEqual({
      success: true,
      slotId: "hero-clip",
      resolution: {
        status: "pending",
        placeholder: { kind: "lastKnownFrame", outputUrl: "https://vendor.example/first.mp4" },
      },
    });
  });
});
