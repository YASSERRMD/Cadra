/**
 * `list_outputs`/`delete_output`/`prune_outputs`: filesystem-level
 * bookkeeping for `config.outputDirectory`, the same directory
 * `render_scene`/`probe_render` write finished files into. Answers the
 * real production incident memory already records: accumulated render
 * outputs (masters, rejected takes, draft probes) filled a disk to 100%
 * (ENOSPC), with nothing in this server watching or bounding that
 * directory's own growth.
 *
 * Deliberately scans the real filesystem, not this process' own in-memory
 * `render-store.ts` job registry: that registry is wiped on every server
 * restart (see its own doc), so a file written by a job from a *previous*
 * process has no in-memory record at all by the time this module might
 * need to clean it up - exactly the failure mode that let output
 * accumulate unnoticed in the first place. `list_outputs` still enriches
 * an entry with this process' own job metadata when it happens to be
 * available, but never requires it.
 */
import { readdir, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CadraMcpServerConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { getRenderJobRecord } from "./render-store.js";

export const LIST_OUTPUTS_TOOL_NAME = "list_outputs";
export const DELETE_OUTPUT_TOOL_NAME = "delete_output";
export const PRUNE_OUTPUTS_TOOL_NAME = "prune_outputs";

/** A caller-supplied output file name must match this exactly (no path separators, no `..`, no leading dot) before it is ever resolved to a filesystem path - mirrors `render-store.ts`'s own `RENDER_JOB_ID_PATTERN` defense-in-depth discipline. */
const OUTPUT_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Validates `fileName` and resolves it to an absolute path guaranteed to sit directly inside `outputDirectory`, throwing rather than ever handing back a path that could have escaped it. */
function resolveOutputFilePath(outputDirectory: string, fileName: string): string {
  if (!OUTPUT_FILE_NAME_PATTERN.test(fileName) || fileName.includes("..")) {
    throw new Error(
      `Refusing to resolve output file name "${fileName}": it must contain only letters, digits, ` +
        "dots, hyphens, and underscores, with no path separators.",
    );
  }

  const outputRoot = resolve(outputDirectory);
  const filePath = resolve(outputRoot, fileName);
  const expectedPrefix = outputRoot.endsWith("/") ? outputRoot : `${outputRoot}/`;
  if (!filePath.startsWith(expectedPrefix)) {
    throw new Error(`Refusing to resolve output file name "${fileName}" to a path outside the output directory.`);
  }
  return filePath;
}

/** One file currently sitting in `outputDirectory`, with filesystem metadata plus (when this process happens to know it) the job that produced it. */
export interface OutputFileInfo {
  fileName: string;
  sizeBytes: number;
  /** ISO-8601 last-modified time - render outputs are written once and never touched again, so this is effectively "when this file was finished." */
  modifiedAt: string;
  /** This server process' own job id for the job that produced this file, if it is still in this process' in-memory registry (see this module's own doc for why a file can exist with no known job at all). */
  jobId?: string;
  sceneId?: string;
  compositionId?: string;
}

/** Lists every regular file directly inside `outputDirectory` (non-recursive: `render-store.ts`'s own `resolveRenderOutputPath` never nests output files in subdirectories), enriched with this process' own job metadata where available. Returns an empty array (not an error) if `outputDirectory` does not exist yet - nothing has ever been rendered. */
async function listOutputFiles(outputDirectory: string): Promise<OutputFileInfo[]> {
  let entries;
  try {
    entries = await readdir(outputDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: OutputFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = resolve(outputDirectory, entry.name);
    const stats = await stat(filePath);
    const knownJob = findJobRecordByOutputFileName(entry.name);
    files.push({
      fileName: entry.name,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      ...(knownJob !== undefined && {
        jobId: knownJob.jobId,
        sceneId: knownJob.sceneId,
        compositionId: knownJob.compositionId,
      }),
    });
  }
  return files;
}

/** Finds a job in `render-store.ts`'s own in-memory registry whose output file name matches `fileName`, by trying every job id shape that file name could plausibly encode. Cheap and exact: job ids are minted by `mintRenderJobId`, never caller-supplied, so this is a lookup, not a fuzzy match. */
function findJobRecordByOutputFileName(fileName: string): ReturnType<typeof getRenderJobRecord> {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return undefined;
  }
  const jobId = fileName.slice(0, dotIndex);
  return getRenderJobRecord(jobId);
}

/** Wraps a JSON-serializable payload as a single-text-block MCP tool result, matching every other tool module's own established convention. */
function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

interface HygieneFailurePayload {
  success: false;
  message: string;
}

interface ListOutputsSuccessPayload {
  success: true;
  outputDirectory: string;
  files: OutputFileInfo[];
  totalBytes: number;
}

interface DeleteOutputSuccessPayload {
  success: true;
  fileName: string;
  bytesFreed: number;
}

interface PruneOutputsSuccessPayload {
  success: true;
  dryRun: boolean;
  deletedFiles: string[];
  bytesFreed: number;
  protectedFiles: string[];
  remainingFileCount: number;
  remainingBytes: number;
}

/**
 * Registers `list_outputs`, `delete_output`, and `prune_outputs` on
 * `server`. All three operate only on `config.outputDirectory` (render
 * outputs); none of them ever touch `config.workspaceRoot`'s own scene
 * documents or uploaded assets.
 */
export function registerCadraWorkspaceHygieneTools(
  server: McpServer,
  config: CadraMcpServerConfig,
  logger: Logger,
): RegisteredTool[] {
  const toolLogger = logger.child("workspace-hygiene-tools");

  const listOutputsTool = server.registerTool(
    LIST_OUTPUTS_TOOL_NAME,
    {
      title: "List outputs",
      description:
        "Lists every render output file currently on disk under this server's output directory, " +
        "with size and last-modified time (plus scene/composition/jobId, when this server process " +
        "still remembers the job that produced it). Use this before prune_outputs to see what a " +
        "cleanup would actually be working with.",
      inputSchema: {},
    },
    async () => {
      const files = await listOutputFiles(config.outputDirectory);
      const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
      return jsonResult({
        success: true,
        outputDirectory: config.outputDirectory,
        files,
        totalBytes,
      } satisfies ListOutputsSuccessPayload);
    },
  );

  const deleteOutputTool = server.registerTool(
    DELETE_OUTPUT_TOOL_NAME,
    {
      title: "Delete output",
      description:
        "Permanently deletes one render output file by name (as returned by list_outputs' own " +
        "fileName field, or get_render_output's outputFileName). The underlying scene document is " +
        "never touched - only the rendered file itself, which render_scene/probe_render can always " +
        "regenerate from the scene. Irreversible.",
      inputSchema: {
        fileName: z.string().describe("Exact file name to delete, e.g. as returned by list_outputs."),
      },
    },
    async ({ fileName }) => {
      let filePath: string;
      try {
        filePath = resolveOutputFilePath(config.outputDirectory, fileName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ success: false, message } satisfies HygieneFailurePayload);
      }

      let sizeBytes: number;
      try {
        sizeBytes = (await stat(filePath)).size;
        await unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            success: false,
            message: `No output file named "${fileName}" exists in this server's output directory.`,
          } satisfies HygieneFailurePayload);
        }
        throw error;
      }

      toolLogger.info("delete_output removed a file", { fileName, sizeBytes });
      return jsonResult({ success: true, fileName, bytesFreed: sizeBytes } satisfies DeleteOutputSuccessPayload);
    },
  );

  const pruneOutputsTool = server.registerTool(
    PRUNE_OUTPUTS_TOOL_NAME,
    {
      title: "Prune outputs",
      description:
        "Bulk-deletes render output files under a policy: files older than maxAgeDays, and/or " +
        "(if the directory's own total size still exceeds maxTotalBytes after that) the oldest " +
        "remaining files until it no longer does. protectFileNames is never deleted regardless of " +
        "policy. Omitting both maxAgeDays and maxTotalBytes is rejected (a no-op policy is almost " +
        "certainly a mistake, not intent). Pass dryRun: true first to preview exactly what a call " +
        "would delete before actually deleting anything - recommended before the first real call " +
        "with a new policy.",
      inputSchema: {
        maxAgeDays: z
          .number()
          .positive()
          .optional()
          .describe("Delete any output file last modified more than this many days ago."),
        maxTotalBytes: z
          .number()
          .positive()
          .optional()
          .describe(
            "If the output directory's total size still exceeds this after any maxAgeDays deletions, " +
              "delete the oldest remaining files (by last-modified time) until it no longer does.",
          ),
        protectFileNames: z
          .array(z.string())
          .optional()
          .describe("File names (e.g. a delivered FINAL) never deleted, regardless of age or size policy."),
        dryRun: z
          .boolean()
          .optional()
          .describe("When true, reports exactly what would be deleted without deleting anything. Defaults to false."),
      },
    },
    async ({ maxAgeDays, maxTotalBytes, protectFileNames, dryRun }) => {
      if (maxAgeDays === undefined && maxTotalBytes === undefined) {
        return jsonResult({
          success: false,
          message: "prune_outputs requires at least one of maxAgeDays or maxTotalBytes; an empty policy would not do anything.",
        } satisfies HygieneFailurePayload);
      }

      const protectedSet = new Set(protectFileNames ?? []);
      const files = await listOutputFiles(config.outputDirectory);
      const [protectedFiles, prunableFiles] = partition(files, (file) => protectedSet.has(file.fileName));

      const toDelete = new Set<string>();

      if (maxAgeDays !== undefined) {
        const cutoff = Date.parse(new Date().toISOString()) - maxAgeDays * 24 * 60 * 60 * 1000;
        for (const file of prunableFiles) {
          if (Date.parse(file.modifiedAt) < cutoff) {
            toDelete.add(file.fileName);
          }
        }
      }

      if (maxTotalBytes !== undefined) {
        const remaining = prunableFiles
          .filter((file) => !toDelete.has(file.fileName))
          .sort((a, b) => Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt));
        let remainingTotal = remaining.reduce((sum, file) => sum + file.sizeBytes, 0);
        for (const file of remaining) {
          if (remainingTotal <= maxTotalBytes) {
            break;
          }
          toDelete.add(file.fileName);
          remainingTotal -= file.sizeBytes;
        }
      }

      const filesToDelete = prunableFiles.filter((file) => toDelete.has(file.fileName));
      const bytesFreed = filesToDelete.reduce((sum, file) => sum + file.sizeBytes, 0);

      if (!(dryRun ?? false)) {
        for (const file of filesToDelete) {
          await unlink(resolve(config.outputDirectory, file.fileName));
        }
        toolLogger.info("prune_outputs deleted files", {
          deletedCount: filesToDelete.length,
          bytesFreed,
        });
      }

      const remainingFiles = files.filter((file) => !toDelete.has(file.fileName));
      return jsonResult({
        success: true,
        dryRun: dryRun ?? false,
        deletedFiles: filesToDelete.map((file) => file.fileName),
        bytesFreed,
        protectedFiles: protectedFiles.map((file) => file.fileName),
        remainingFileCount: remainingFiles.length,
        remainingBytes: remainingFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
      } satisfies PruneOutputsSuccessPayload);
    },
  );

  return [listOutputsTool, deleteOutputTool, pruneOutputsTool];
}

/** Splits `items` into `[matching, nonMatching]` by `predicate`, in one pass. */
function partition<T>(items: readonly T[], predicate: (item: T) => boolean): [T[], T[]] {
  const matching: T[] = [];
  const nonMatching: T[] = [];
  for (const item of items) {
    (predicate(item) ? matching : nonMatching).push(item);
  }
  return [matching, nonMatching];
}
