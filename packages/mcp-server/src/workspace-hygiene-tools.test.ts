import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";
import { createCadraMcpServer } from "./server.js";
import {
  DELETE_OUTPUT_TOOL_NAME,
  LIST_OUTPUTS_TOOL_NAME,
  PRUNE_OUTPUTS_TOOL_NAME,
} from "./workspace-hygiene-tools.js";

interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
}

function parseToolResult<T>(result: ToolTextResult): T {
  const [content] = result.content;
  expect(content?.type).toBe("text");
  return JSON.parse(content!.text) as T;
}

interface FailurePayload {
  success: false;
  message: string;
}

interface ListOutputsPayload {
  success: true;
  outputDirectory: string;
  files: Array<{ fileName: string; sizeBytes: number; modifiedAt: string }>;
  totalBytes: number;
}

interface DeleteOutputPayload {
  success: true;
  fileName: string;
  bytesFreed: number;
}

interface PruneOutputsPayload {
  success: true;
  dryRun: boolean;
  deletedFiles: string[];
  bytesFreed: number;
  protectedFiles: string[];
  remainingFileCount: number;
  remainingBytes: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("workspace hygiene tools", () => {
  let workspaceRoot: string;
  let outputDirectory: string;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  async function connectClient(): Promise<Client> {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-hygiene-test-"));
    outputDirectory = join(workspaceRoot, "out");
    const { server } = createCadraMcpServer({
      config: { workspaceRoot, outputDirectory },
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

  /** Writes a real output file of `sizeBytes` bytes, with its mtime backdated by `ageDays` (0 means "just now"). */
  async function writeOutputFile(fileName: string, sizeBytes: number, ageDays = 0): Promise<void> {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, fileName), Buffer.alloc(sizeBytes, 1));
    if (ageDays > 0) {
      const time = new Date(Date.now() - ageDays * DAY_MS);
      await utimes(join(outputDirectory, fileName), time, time);
    }
  }

  describe("list_outputs", () => {
    it("returns an empty list when the output directory does not exist yet", async () => {
      const connectedClient = await connectClient();
      const result = await connectedClient.callTool({ name: LIST_OUTPUTS_TOOL_NAME, arguments: {} });
      const payload = parseToolResult<ListOutputsPayload>(result as ToolTextResult);

      expect(payload.success).toBe(true);
      expect(payload.files).toEqual([]);
      expect(payload.totalBytes).toBe(0);
    });

    it("lists real files with their size and modified time", async () => {
      const connectedClient = await connectClient();
      await writeOutputFile("render-a.mp4", 1000);
      await writeOutputFile("render-b.webm", 2000);

      const result = await connectedClient.callTool({ name: LIST_OUTPUTS_TOOL_NAME, arguments: {} });
      const payload = parseToolResult<ListOutputsPayload>(result as ToolTextResult);

      expect(payload.success).toBe(true);
      expect(payload.files).toHaveLength(2);
      expect(payload.totalBytes).toBe(3000);
      const names = payload.files.map((f) => f.fileName).sort();
      expect(names).toEqual(["render-a.mp4", "render-b.webm"]);
    });
  });

  describe("delete_output", () => {
    it("deletes a real file and reports bytes freed", async () => {
      const connectedClient = await connectClient();
      await writeOutputFile("render-a.mp4", 1234);

      const result = await connectedClient.callTool({
        name: DELETE_OUTPUT_TOOL_NAME,
        arguments: { fileName: "render-a.mp4" },
      });
      const payload = parseToolResult<DeleteOutputPayload>(result as ToolTextResult);

      expect(payload.success).toBe(true);
      expect(payload.bytesFreed).toBe(1234);
      expect(await readdir(outputDirectory)).toEqual([]);
    });

    it("reports failure for a file that does not exist", async () => {
      const connectedClient = await connectClient();
      const result = await connectedClient.callTool({
        name: DELETE_OUTPUT_TOOL_NAME,
        arguments: { fileName: "no-such-file.mp4" },
      });
      const payload = parseToolResult<FailurePayload>(result as ToolTextResult);

      expect(payload.success).toBe(false);
      expect(payload.message).toContain("no-such-file.mp4");
    });

    it("rejects a path-traversal file name without ever touching the filesystem", async () => {
      const connectedClient = await connectClient();
      const result = await connectedClient.callTool({
        name: DELETE_OUTPUT_TOOL_NAME,
        arguments: { fileName: "../../etc/passwd" },
      });
      const payload = parseToolResult<FailurePayload>(result as ToolTextResult);

      expect(payload.success).toBe(false);
      expect(payload.message).toContain("Refusing to resolve");
    });
  });

  describe("prune_outputs", () => {
    it("rejects an empty policy (neither maxAgeDays nor maxTotalBytes)", async () => {
      const connectedClient = await connectClient();
      const result = await connectedClient.callTool({ name: PRUNE_OUTPUTS_TOOL_NAME, arguments: {} });
      const payload = parseToolResult<FailurePayload>(result as ToolTextResult);

      expect(payload.success).toBe(false);
      expect(payload.message).toContain("maxAgeDays");
    });

    it("deletes only files older than maxAgeDays", async () => {
      const connectedClient = await connectClient();
      await writeOutputFile("old.mp4", 100, 10);
      await writeOutputFile("new.mp4", 100, 0);

      const result = await connectedClient.callTool({
        name: PRUNE_OUTPUTS_TOOL_NAME,
        arguments: { maxAgeDays: 5 },
      });
      const payload = parseToolResult<PruneOutputsPayload>(result as ToolTextResult);

      expect(payload.success).toBe(true);
      expect(payload.deletedFiles).toEqual(["old.mp4"]);
      expect(payload.bytesFreed).toBe(100);
      const remaining = await readdir(outputDirectory);
      expect(remaining).toEqual(["new.mp4"]);
    });

    it("deletes the oldest files first to satisfy maxTotalBytes", async () => {
      const connectedClient = await connectClient();
      await writeOutputFile("oldest.mp4", 500, 3);
      await writeOutputFile("middle.mp4", 500, 2);
      await writeOutputFile("newest.mp4", 500, 1);

      const result = await connectedClient.callTool({
        name: PRUNE_OUTPUTS_TOOL_NAME,
        arguments: { maxTotalBytes: 700 },
      });
      const payload = parseToolResult<PruneOutputsPayload>(result as ToolTextResult);

      expect(payload.success).toBe(true);
      // 1500 total, budget 700: delete oldest (500) -> 1000, still over ->
      // delete next-oldest (500) -> 500, now under budget. newest.mp4
      // survives. deletedFiles' own order is not part of this tool's
      // contract, so compare as a set.
      expect([...payload.deletedFiles].sort()).toEqual(["middle.mp4", "oldest.mp4"]);
      expect(payload.remainingBytes).toBe(500);
      expect(await readdir(outputDirectory)).toEqual(["newest.mp4"]);
    });

    it("never deletes a protected file, even if it violates the policy", async () => {
      const connectedClient = await connectClient();
      await writeOutputFile("keep-FINAL.mp4", 100, 30);
      await writeOutputFile("stale.mp4", 100, 30);

      const result = await connectedClient.callTool({
        name: PRUNE_OUTPUTS_TOOL_NAME,
        arguments: { maxAgeDays: 1, protectFileNames: ["keep-FINAL.mp4"] },
      });
      const payload = parseToolResult<PruneOutputsPayload>(result as ToolTextResult);

      expect(payload.success).toBe(true);
      expect(payload.deletedFiles).toEqual(["stale.mp4"]);
      expect(payload.protectedFiles).toEqual(["keep-FINAL.mp4"]);
      const remaining = await readdir(outputDirectory);
      expect(remaining).toEqual(["keep-FINAL.mp4"]);
    });

    it("dryRun reports what would be deleted without deleting anything", async () => {
      const connectedClient = await connectClient();
      await writeOutputFile("old.mp4", 100, 10);

      const result = await connectedClient.callTool({
        name: PRUNE_OUTPUTS_TOOL_NAME,
        arguments: { maxAgeDays: 5, dryRun: true },
      });
      const payload = parseToolResult<PruneOutputsPayload>(result as ToolTextResult);

      expect(payload.success).toBe(true);
      expect(payload.dryRun).toBe(true);
      expect(payload.deletedFiles).toEqual(["old.mp4"]);
      // Nothing actually deleted: the file is still really there.
      expect(await readdir(outputDirectory)).toEqual(["old.mp4"]);
    });
  });
});
