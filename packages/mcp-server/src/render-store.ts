/**
 * Workspace-rooted render job bookkeeping: mints a safe, MCP-facing job id
 * for every `render_scene` call, resolves that job's own output file path
 * under `config.outputDirectory` with the exact same allow-list-plus-
 * resolved-path-check discipline `scene-store.ts`'s `sanitizeSceneId`/
 * `resolveSceneFilePath` established for scene ids, and keeps an in-memory
 * registry mapping this server's own job id to the underlying
 * `@cadra/encode` `EncodedRenderJobHandle` plus enough metadata to answer
 * `get_render_status`/`get_render_output` later.
 *
 * Unlike a scene id (caller-supplied, and therefore untrusted input that
 * must be validated before ever touching a filesystem path), a render job id
 * minted by {@link mintRenderJobId} is never influenced by caller input: it
 * is generated here, from a timestamp and a random suffix, and is
 * unconditionally well-formed by construction. The defense-in-depth
 * resolved-path check in {@link resolveRenderOutputPath} is still applied
 * (mirroring `scene-store.ts`'s own belt-and-suspenders approach exactly),
 * but the primary sandboxing property this module relies on is simpler than
 * `scene-store.ts`'s: a caller-supplied `jobId` passed to `get_render_status`/
 * `get_render_output` is looked up in this module's own in-memory registry
 * (`renderJobs`), never turned into a filesystem path directly, so an
 * unknown or malformed job id simply misses the registry lookup rather than
 * needing its own separate allow-list validation.
 */
import { resolve } from "node:path";

import type { EncodedRenderJobHandle } from "@cadra/encode";
import type { RangeState, RenderJobStatusSnapshot } from "@cadra/headless";

/** Subdirectory under `outputDirectory` a render job's own output file is stored directly in. Kept flat (no further nesting) since {@link resolveRenderOutputPath} already scopes every file under `outputDirectory` itself. */
const RENDER_JOB_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Mints a fresh, MCP-facing render job id: a millisecond timestamp and a random alphanumeric suffix, joined by a hyphen. Always matches {@link RENDER_JOB_ID_PATTERN} by construction. */
export function mintRenderJobId(): string {
  const timestamp = Date.now().toString(36);
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  return `render-${timestamp}-${randomSuffix}`;
}

/**
 * Resolves the absolute path a render job's output file is written to, given
 * an already-{@link mintRenderJobId}-minted `jobId` and its `format`
 * (determining the file extension).
 *
 * As defense in depth, re-verifies (via `resolve`) that the resulting path
 * is still directly inside `outputDirectory` before returning it, and that
 * `jobId` itself matches {@link RENDER_JOB_ID_PATTERN}, throwing rather than
 * ever handing back a path that escaped it; mirrors `scene-store.ts`'s
 * `resolveSceneFilePath` exactly, adapted to this module's own job id shape.
 */
export function resolveRenderOutputPath(
  outputDirectory: string,
  jobId: string,
  format: "mp4" | "webm",
): string {
  if (!RENDER_JOB_ID_PATTERN.test(jobId)) {
    throw new Error(`Refusing to resolve render job id "${jobId}": it does not match the expected job id shape.`);
  }

  const outputRoot = resolve(outputDirectory);
  const filePath = resolve(outputRoot, `${jobId}.${format}`);

  const expectedPrefix = outputRoot.endsWith("/") ? outputRoot : `${outputRoot}/`;
  if (!filePath.startsWith(expectedPrefix)) {
    throw new Error(`Refusing to resolve render job id "${jobId}" to a path outside the output directory.`);
  }

  return filePath;
}

/** One render job's bookkeeping record, held in this module's in-memory registry. */
export interface RenderJobRecord {
  /** This server's own MCP-facing job id (distinct from `@cadra/encode`'s own underlying `handle.jobId`, which is only used internally to query `getEncodedRenderJobStatus`). */
  jobId: string;
  /** `@cadra/encode`'s own underlying job id, as returned by `submitEncodedRenderJob`; passed to `getEncodedRenderJobStatus` to read live per-range progress. */
  encodedJobId: string;
  /** Id of the scene document this job renders. */
  sceneId: string;
  /** Id of the composition, within that scene, this job renders. */
  compositionId: string;
  /** Output container format. */
  format: "mp4" | "webm";
  /** Absolute path the finished file is (or will be) written to. */
  outputPath: string;
  /** ISO-8601 timestamp of when this job was submitted. */
  submittedAt: string;
  /**
   * Settles once `handle.result` itself settles: `undefined` while the job
   * is still in flight, `{ ok: true }` once the whole job (every range plus
   * the final mux pass) finished successfully, or `{ ok: false, message }`
   * if it failed. Tracked separately from `getEncodedRenderJobStatus`'s own
   * per-range snapshot because that snapshot alone cannot distinguish "every
   * range succeeded and the final mux pass is still running/also succeeded"
   * from "every range succeeded but the final mux pass itself failed" (the
   * mux pass is not itself one of the tracked ranges).
   */
  outcome?: { ok: true } | { ok: false; message: string };
}

/**
 * This process' in-memory render job registry, keyed by this module's own
 * MCP-facing job id. Deliberately in-memory and unbounded by any eviction
 * policy: matches `@cadra/headless`'s own `jobRegistry` design (see that
 * module's doc), scoped to however many jobs a given server process actually
 * submits during its lifetime, not by anything else.
 */
const renderJobs = new Map<string, RenderJobRecord>();

/** Registers a freshly-submitted job's bookkeeping record, keyed by its own `jobId`. */
export function registerRenderJob(record: RenderJobRecord): void {
  renderJobs.set(record.jobId, record);
}

/** Looks up a render job's bookkeeping record by this server's own MCP-facing job id, or `undefined` if no such job was ever submitted in this process. */
export function getRenderJobRecord(jobId: string): RenderJobRecord | undefined {
  return renderJobs.get(jobId);
}

/** Marks `jobId`'s record with its final outcome, once `handle.result` itself settles. No-op if `jobId` is not (or no longer) registered. */
export function setRenderJobOutcome(jobId: string, outcome: RenderJobRecord["outcome"]): void {
  const record = renderJobs.get(jobId);
  if (record !== undefined) {
    record.outcome = outcome;
  }
}

/**
 * Wires `handle.result`'s eventual settlement into {@link setRenderJobOutcome},
 * so a job's record reflects final success/failure without any caller of
 * `render_scene` needing to await the whole render itself. Deliberately
 * fire-and-forget from the caller's perspective: `render_scene` returns as
 * soon as this function is called, well before `handle.result` itself
 * settles.
 */
export function trackRenderJobOutcome(jobId: string, handle: EncodedRenderJobHandle): void {
  handle.result.then(
    () => setRenderJobOutcome(jobId, { ok: true }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setRenderJobOutcome(jobId, { ok: false, message });
    },
  );
}

/** A `RangeState`'s own `errors: Error[]` field, serialized to plain `{ message }` objects (a bare `Error` serializes to `{}` via `JSON.stringify`, silently dropping its message). */
export interface SerializedRangeError {
  message: string;
}

/** One range's status, in the same shape `RenderJobStatusSnapshot.ranges` carries, with its `errors` serialized to plain objects and its own (opaque, potentially large) `segment` omitted: a status poll reports progress, not the render's actual output data. */
export interface SerializedRangeState {
  range: RangeState<unknown>["range"];
  status: RangeState<unknown>["status"];
  attempts: number;
  errors: SerializedRangeError[];
}

/** A full job status snapshot, JSON-serializable end to end (see {@link SerializedRangeState} for why `errors`/`segment` need their own handling), as returned by `get_render_status`. */
export interface SerializedJobStatus {
  status: RenderJobStatusSnapshot<unknown>["status"];
  totalFrames: number;
  framesCompleted: number;
  ranges: SerializedRangeState[];
}

/** Converts a live `RenderJobStatusSnapshot` (whose `ranges[].errors` are real `Error` instances and whose `ranges[].segment` may be an arbitrarily large opaque value) into a {@link SerializedJobStatus} safe to hand back as MCP tool JSON. */
export function serializeJobStatus<TSegment>(snapshot: RenderJobStatusSnapshot<TSegment>): SerializedJobStatus {
  return {
    status: snapshot.status,
    totalFrames: snapshot.totalFrames,
    framesCompleted: snapshot.framesCompleted,
    ranges: snapshot.ranges.map((range) => ({
      range: range.range,
      status: range.status,
      attempts: range.attempts,
      errors: range.errors.map((error) => ({ message: error.message })),
    })),
  };
}
