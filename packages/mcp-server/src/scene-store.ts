/**
 * Workspace-rooted persistence for scene documents: one JSON file per scene
 * under `<workspaceRoot>/scenes/<sceneId>.json`.
 *
 * Every read/write in this module goes through {@link sanitizeSceneId} first.
 * A scene id doubles as a filesystem path segment, so an unsanitized id is a
 * path-traversal vector (`"../../etc/passwd"`, an absolute path, a id
 * containing a path separator, and so on): {@link sanitizeSceneId} rejects
 * anything that is not a plain, flat, safe token before it is ever joined
 * onto `workspaceRoot`. This is deliberately a narrow, single-purpose sandbox
 * scoped to this phase's own scene-file writes; the deep, general
 * workspace/output sandboxing for render/asset tools (arbitrary output
 * paths, symlink handling, etc.) is Phase 30's job, not this module's.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { SceneDocument } from "@cadra/schema";

/** Subdirectory under `workspaceRoot` scene files are persisted in. */
const SCENES_SUBDIRECTORY = "scenes";

/** File extension every persisted scene file uses. */
const SCENE_FILE_EXTENSION = ".json";

/**
 * A scene id is accepted only if it matches this pattern: one or more
 * characters from a conservative allow-list (letters, digits, hyphen,
 * underscore). This alone already rules out `/`, `\`, `..`, null bytes, and
 * any other path-meaningful character, without needing to special-case each
 * one individually.
 */
const VALID_SCENE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Upper bound on scene id length, generous for any realistic generated or agent-authored id, but bounded so a pathological input cannot build an unreasonably long file path. */
const MAX_SCENE_ID_LENGTH = 200;

/** A scene id that passed {@link sanitizeSceneId}. */
export interface SceneIdValidationSuccess {
  valid: true;
  /** The validated id, unchanged from the input (validation never rewrites it). */
  sceneId: string;
}

/** A scene id that failed {@link sanitizeSceneId}, with a human-readable reason. */
export interface SceneIdValidationFailure {
  valid: false;
  /** Why `sceneId` was rejected, suitable for surfacing directly to an agent. */
  reason: string;
}

/** Result of validating a candidate scene id. */
export type SceneIdValidationResult = SceneIdValidationSuccess | SceneIdValidationFailure;

/**
 * Validates that `sceneId` is safe to use as a single filesystem path
 * segment: non-empty, within {@link MAX_SCENE_ID_LENGTH}, and composed only
 * of `[A-Za-z0-9_-]`. This rejects `..`, `/`, `\`, absolute paths, and null
 * bytes by construction (none of those characters are in the allow-list),
 * rather than trying to enumerate and block each dangerous pattern
 * individually.
 *
 * Does not check whether a scene with this id already exists; that is a
 * separate, tool-level concern ({@link readSceneDocument} returning
 * `undefined` for a well-formed but unknown id).
 */
export function sanitizeSceneId(sceneId: string): SceneIdValidationResult {
  if (sceneId.length === 0) {
    return { valid: false, reason: "Scene id must not be empty." };
  }
  if (sceneId.length > MAX_SCENE_ID_LENGTH) {
    return {
      valid: false,
      reason: `Scene id must be at most ${MAX_SCENE_ID_LENGTH} characters long.`,
    };
  }
  if (!VALID_SCENE_ID_PATTERN.test(sceneId)) {
    return {
      valid: false,
      reason:
        "Scene id must contain only letters, digits, hyphens, and underscores " +
        "(no path separators, no '..', no other punctuation).",
    };
  }
  return { valid: true, sceneId };
}

/**
 * Resolves the absolute path a scene's JSON file is stored at, given an
 * already-{@link sanitizeSceneId}-validated `sceneId`.
 *
 * As defense in depth beyond the allow-list check in `sanitizeSceneId`, this
 * also re-verifies (via `resolve`) that the resulting path is still directly
 * inside the scenes directory before returning it, throwing rather than ever
 * handing back a path that escaped it. Callers must not pass an unsanitized
 * `sceneId` here; this function trusts its caller to have validated first
 * and only guards against that validation itself somehow being bypassed.
 */
function resolveSceneFilePath(workspaceRoot: string, sceneId: string): string {
  const scenesDirectory = resolve(workspaceRoot, SCENES_SUBDIRECTORY);
  const filePath = resolve(scenesDirectory, `${sceneId}${SCENE_FILE_EXTENSION}`);

  if (filePath !== join(scenesDirectory, `${sceneId}${SCENE_FILE_EXTENSION}`)) {
    throw new Error(`Refusing to resolve scene id "${sceneId}" to a path outside the scenes directory.`);
  }

  return filePath;
}

/** Compact, list-friendly summary of a persisted scene, returned by {@link listSceneSummaries}. */
export interface SceneSummary {
  /** The scene's id (its filename, minus the `.json` extension). */
  id: string;
  /** The scene's `project.name`. */
  name: string;
  /** Ids of every composition in the scene's project, in order. */
  compositionIds: string[];
  /** `project.compositions.length`; redundant with `compositionIds.length` but kept explicit for a caller that only wants the count. */
  compositionCount: number;
  /** Total number of scene nodes across every clip in every track in every composition, counting each node and all of its descendants exactly once. */
  nodeCount: number;
  /** ISO-8601 timestamp of this scene file's last write, from the filesystem. */
  lastModified: string;
}

/** Counts `node` and every descendant, recursively. */
function countNodesInTree(node: SceneDocument["project"]["compositions"][number]["tracks"][number]["clips"][number]["node"]): number {
  let count = 1;
  for (const child of node.children) {
    count += countNodesInTree(child);
  }
  return count;
}

/** Total scene-node count across every clip in every track in every composition of `project`. */
function countNodesInProject(project: SceneDocument["project"]): number {
  let count = 0;
  for (const composition of project.compositions) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        count += countNodesInTree(clip.node);
      }
    }
  }
  return count;
}

/** Derives a {@link SceneSummary} from a full document plus its filesystem `lastModified` timestamp. */
export function summarizeSceneDocument(
  sceneId: string,
  document: SceneDocument,
  lastModified: string,
): SceneSummary {
  return {
    id: sceneId,
    name: document.project.name,
    compositionIds: document.project.compositions.map((composition) => composition.id),
    compositionCount: document.project.compositions.length,
    nodeCount: countNodesInProject(document.project),
    lastModified,
  };
}

/**
 * Persists `document` as `sceneId`'s scene file under `workspaceRoot`,
 * creating the `scenes` subdirectory if it does not already exist.
 * `sceneId` must already have passed {@link sanitizeSceneId}; this function
 * does not re-validate it beyond the defense-in-depth check in
 * `resolveSceneFilePath`.
 *
 * Callers are responsible for validating `document` (e.g. via `parseScene`)
 * before calling this: this function persists whatever it is given verbatim.
 */
export async function writeSceneDocument(
  workspaceRoot: string,
  sceneId: string,
  document: SceneDocument,
): Promise<void> {
  const filePath = resolveSceneFilePath(workspaceRoot, sceneId);
  await mkdir(resolve(workspaceRoot, SCENES_SUBDIRECTORY), { recursive: true });
  await writeFile(filePath, JSON.stringify(document, null, 2), "utf8");
}

/** A scene file's raw parsed JSON contents plus its filesystem last-modified timestamp, as read by {@link readSceneFile}. Not yet validated as a `SceneDocument`: see `./scene-tools.ts` for where `parseScene` is applied to this. */
export interface SceneFileContents {
  /** Raw `JSON.parse` of the file's contents; the caller is responsible for schema validation. */
  raw: unknown;
  /** ISO-8601 timestamp of this file's last write. */
  lastModified: string;
}

/**
 * Reads `sceneId`'s scene file under `workspaceRoot` and returns its raw
 * parsed JSON plus last-modified timestamp, or `undefined` if no such file
 * exists. `sceneId` must already have passed {@link sanitizeSceneId}.
 *
 * Deliberately returns `raw: unknown`, not a `SceneDocument`: a file already
 * on disk was valid when written (every write goes through `parseScene`
 * first), but this function stays a pure I/O primitive and leaves
 * re-validating (or trusting) that content to its caller, matching how
 * `writeSceneDocument` also does no validation of its own.
 */
export async function readSceneFile(
  workspaceRoot: string,
  sceneId: string,
): Promise<SceneFileContents | undefined> {
  const filePath = resolveSceneFilePath(workspaceRoot, sceneId);

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }

  const contents = await readFile(filePath, "utf8");
  return { raw: JSON.parse(contents), lastModified: fileStat.mtime.toISOString() };
}

/**
 * Lists every persisted scene under `workspaceRoot`'s `scenes` directory as
 * `{ sceneId, raw, lastModified }` entries, or an empty array if the
 * directory does not exist yet (a workspace with no scenes created is not an
 * error).
 *
 * Entries whose filename does not end in {@link SCENE_FILE_EXTENSION}, or
 * whose id (once the extension is stripped) does not itself pass
 * {@link sanitizeSceneId}, are silently skipped: this directory is expected
 * to contain only files this module itself wrote, but a stray or
 * hand-edited file should not crash a listing.
 */
export async function listSceneFiles(
  workspaceRoot: string,
): Promise<Array<{ sceneId: string } & SceneFileContents>> {
  const scenesDirectory = resolve(workspaceRoot, SCENES_SUBDIRECTORY);

  let entries;
  try {
    entries = await readdir(scenesDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const results: Array<{ sceneId: string } & SceneFileContents> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SCENE_FILE_EXTENSION)) {
      continue;
    }
    const candidateId = entry.name.slice(0, -SCENE_FILE_EXTENSION.length);
    const validation = sanitizeSceneId(candidateId);
    if (!validation.valid) {
      continue;
    }
    const contents = await readSceneFile(workspaceRoot, candidateId);
    if (contents !== undefined) {
      results.push({ sceneId: candidateId, ...contents });
    }
  }
  return results;
}

/** True if `error` is a Node.js `ENOENT` (file/directory not found) error. */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

/**
 * Deletes `sceneId`'s scene file under `workspaceRoot`, if it exists. Exposed
 * for test cleanup and forward compatibility; no tool in this phase deletes
 * scenes (there is no `delete_scene` tool yet), so production code paths
 * never call this today.
 */
export async function deleteSceneFile(workspaceRoot: string, sceneId: string): Promise<void> {
  const filePath = resolveSceneFilePath(workspaceRoot, sceneId);
  await rm(filePath, { force: true });
}
