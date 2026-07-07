/**
 * A generic "apply one edit at a dotted/bracketed-index path string against
 * an arbitrary parsed-JSON value" primitive.
 *
 * The path format here is exactly {@link SceneParseDiagnostic.path}'s own
 * format (see `./parse.ts`): a dotted sequence of object-property names,
 * with array indices written as a bracketed suffix on the preceding segment,
 * e.g. `"project.compositions[0].tracks[1].clips[0].node.transform.position"`.
 * This is the same format a `SceneDiagnosticPatch.path` is always expressed
 * in, so a patch straight off a `SceneParseDiagnostic` can be handed to
 * {@link applyPatchAtPath} with no translation step in between.
 *
 * This is a different, more general primitive than
 * `@cadra/core`'s `tree-operations.ts` (`addNode`/`updateNode`/`removeNode`):
 * those operate on a `SceneNode` subtree, addressed by a stable node `id`,
 * and only ever add/update/remove a whole node. This module operates on any
 * parsed-JSON value (a whole `SceneDocument`, a bare `Project`, or anything
 * else shaped like JSON), addressed by an arbitrary structural path, and
 * edits a single scalar (or object/array) value at that exact path,
 * including paths that reach far outside any scene-node subtree entirely
 * (e.g. `"project.compositions[0].fps"` or `"schemaVersion"`). Neither
 * primitive is a special case of the other; use whichever matches what you
 * are addressing by (a stable node id, or a structural path).
 *
 * Every function here is pure and uses structural sharing: the input value
 * is never mutated, and only the objects/arrays on the path from the root
 * down to the edited location are newly allocated. Every sibling value not
 * on that path keeps its exact original object reference.
 */

/** One segment of a parsed path: either an object property name, or a numeric array index. */
export type PathSegment = { kind: "property"; name: string } | { kind: "index"; index: number };

/** Thrown when a path string cannot be parsed at all (malformed bracket syntax). */
export class InvalidPathError extends Error {
  constructor(path: string, reason: string) {
    super(`Cannot parse path "${path}": ${reason}`);
    this.name = "InvalidPathError";
  }
}

/**
 * Thrown when applying a patch requires traversing through a location that
 * does not exist, or exists but is the wrong kind of container (e.g. an
 * `"index"` segment applied to something that is not an array).
 */
export class PathTraversalError extends Error {
  constructor(path: string, reason: string) {
    super(`Cannot apply patch at path "${path}": ${reason}`);
    this.name = "PathTraversalError";
  }
}

/**
 * Parses a dotted/bracketed-index path string into an ordered list of
 * {@link PathSegment}s, e.g. `"project.compositions[0].fps"` becomes
 * `[{kind:"property",name:"project"}, {kind:"property",name:"compositions"},
 * {kind:"index",index:0}, {kind:"property",name:"fps"}]`.
 *
 * Accepts exactly the format {@link formatIssuePath} in `./parse.ts` produces:
 * property names separated by `.`, array indices as a `[N]` suffix
 * immediately following the segment they index into (no leading `.` before
 * a bracket). The literal path `"<root>"` (what `formatIssuePath` emits for
 * an issue about the document root itself) parses to an empty segment list,
 * meaning "the whole value, not a location inside it"; see
 * {@link applyPatchAtPath}, which rejects an empty segment list outright
 * (there is no parent container to add/replace/remove a root value *within*).
 *
 * @throws {InvalidPathError} if `path` is empty (and not `"<root>"`), or
 *   contains malformed bracket syntax (an unclosed `[`, a non-numeric or
 *   empty index, or a stray `]` not immediately preceded by a matching `[`).
 */
export function parsePath(path: string): PathSegment[] {
  if (path === "<root>") {
    return [];
  }
  if (path.length === 0) {
    throw new InvalidPathError(path, "path must not be empty");
  }

  const segments: PathSegment[] = [];
  // Splits on '.' first, then peels any number of trailing `[N]` suffixes off
  // each dot-separated chunk; e.g. "tracks[1]" -> property "tracks", index 1.
  // A chunk with no brackets at all is just a plain property name.
  for (const chunk of path.split(".")) {
    if (chunk.length === 0) {
      throw new InvalidPathError(path, "empty segment between two '.' separators");
    }

    const bracketStart = chunk.indexOf("[");
    const propertyName = bracketStart === -1 ? chunk : chunk.slice(0, bracketStart);
    const bracketPortion = bracketStart === -1 ? "" : chunk.slice(bracketStart);

    if (propertyName.length === 0) {
      throw new InvalidPathError(path, `segment "${chunk}" has an index with no preceding property name`);
    }
    segments.push({ kind: "property", name: propertyName });

    if (bracketPortion.length === 0) {
      continue;
    }

    const indexPattern = /\[(\d+)\]/g;
    let consumedLength = 0;
    let match: RegExpExecArray | null;
    while ((match = indexPattern.exec(bracketPortion)) !== null) {
      if (match.index !== consumedLength) {
        throw new InvalidPathError(path, `malformed index syntax in segment "${chunk}"`);
      }
      segments.push({ kind: "index", index: Number(match[1]) });
      consumedLength = indexPattern.lastIndex;
    }
    if (consumedLength !== bracketPortion.length) {
      throw new InvalidPathError(path, `malformed index syntax in segment "${chunk}"`);
    }
  }

  return segments;
}

/** Renders a parsed segment list back to its dotted/bracketed string form, the inverse of {@link parsePath}. Used only for error messages below. */
function formatSegments(segments: ReadonlyArray<PathSegment>): string {
  if (segments.length === 0) {
    return "<root>";
  }
  let formatted = "";
  for (const segment of segments) {
    if (segment.kind === "index") {
      formatted += `[${segment.index}]`;
    } else {
      formatted += formatted.length === 0 ? segment.name : `.${segment.name}`;
    }
  }
  return formatted;
}

/** Returns a shallow copy of `container` (array or plain object) suitable for structural-sharing mutation of one key/index. */
function shallowClone(container: unknown[] | Record<string, unknown>): unknown[] | Record<string, unknown> {
  return Array.isArray(container) ? container.slice() : { ...container };
}

/**
 * Reads the child at `segment` from `container`, or returns a sentinel
 * meaning "does not exist", distinguishing "exists and is `undefined`" (not
 * actually possible from parsed JSON, but kept precise) from "the key/index
 * is simply absent".
 */
function hasSegment(container: unknown, segment: PathSegment): boolean {
  if (segment.kind === "index") {
    return Array.isArray(container) && segment.index >= 0 && segment.index < container.length;
  }
  return (
    typeof container === "object" &&
    container !== null &&
    !Array.isArray(container) &&
    Object.prototype.hasOwnProperty.call(container, segment.name)
  );
}

/** Reads the child at `segment` from `container`. Caller must have already confirmed the container/segment kinds match via {@link assertContainerMatchesSegment}. */
function readSegment(container: unknown, segment: PathSegment): unknown {
  if (segment.kind === "index") {
    return (container as unknown[])[segment.index];
  }
  return (container as Record<string, unknown>)[segment.name];
}

/**
 * Throws {@link PathTraversalError} unless `container` is the right kind of
 * value to index with `segment` (an array for an `"index"` segment, a plain
 * object for a `"property"` segment).
 */
function assertContainerMatchesSegment(
  container: unknown,
  segment: PathSegment,
  fullPath: string,
): void {
  if (segment.kind === "index") {
    if (!Array.isArray(container)) {
      throw new PathTraversalError(
        fullPath,
        `expected an array to index with [${segment.index}], found ${describeValueKind(container)}`,
      );
    }
    return;
  }
  if (typeof container !== "object" || container === null || Array.isArray(container)) {
    throw new PathTraversalError(
      fullPath,
      `expected an object to read property '${segment.name}' from, found ${describeValueKind(container)}`,
    );
  }
}

/** Short human-readable label for a value's runtime kind, for use in error messages. */
function describeValueKind(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return typeof value === "object" ? "a non-array object" : `a ${typeof value}`;
}

/**
 * Immutably overwrites whatever is at `segment` within `container` with
 * `child`, returning a new container (structural sharing: only `container`
 * itself is cloned, not `child` or any sibling value).
 *
 * For an `"index"` segment, this always overwrites the existing element in
 * place (it never shifts other elements); use {@link insertSegment} instead
 * when the intent is to insert a new element and shift later ones along.
 * This distinction only matters for array segments: for a `"property"`
 * segment, "overwrite" and "insert" are the same operation (an object
 * property is simply set), which is exactly why a top-level `"replace"` and
 * a top-level `"add"` onto an already-existing property both resolve to a
 * plain `writeSegment` call (see {@link applyPatchAtPath}).
 *
 * Also used, unconditionally, to write an already-computed updated child
 * back into its parent while unwinding the recursive walk in {@link recurse}:
 * that step is always "put this exact (possibly-modified) child back where
 * it came from", never an insertion, regardless of which op the caller
 * originally requested.
 */
function writeSegment(
  container: unknown[] | Record<string, unknown>,
  segment: PathSegment,
  child: unknown,
  fullPath: string,
): unknown[] | Record<string, unknown> {
  assertContainerMatchesSegment(container, segment, fullPath);
  const clone = shallowClone(container);

  if (segment.kind === "index") {
    const array = clone as unknown[];
    if (segment.index < 0 || segment.index >= array.length) {
      throw new PathTraversalError(
        fullPath,
        `index ${segment.index} is out of bounds for an array of length ${array.length}`,
      );
    }
    array[segment.index] = child;
    return array;
  }

  (clone as Record<string, unknown>)[segment.name] = child;
  return clone;
}

/**
 * Immutably inserts `child` as a new element at array index `segment.index`
 * within `container`, shifting the existing element at that index (and every
 * element after it) one place later. `segment.index` may equal the array's
 * current length, which appends `child` as the new last element.
 *
 * Only meaningful for an `"index"` segment; used exclusively by the `"add"`
 * op in {@link applyPatchAtPath} when the final path segment indexes into an
 * array (an `"add"` onto an object property is a plain {@link writeSegment}
 * instead, since inserting and overwriting are the same thing for a named
 * property).
 */
function insertSegment(
  container: unknown[] | Record<string, unknown>,
  segment: Extract<PathSegment, { kind: "index" }>,
  child: unknown,
  fullPath: string,
): unknown[] {
  assertContainerMatchesSegment(container, segment, fullPath);
  const array = container as unknown[];
  if (segment.index < 0 || segment.index > array.length) {
    throw new PathTraversalError(
      fullPath,
      `index ${segment.index} is out of bounds for an array of length ${array.length}`,
    );
  }
  const next = array.slice();
  next.splice(segment.index, 0, child);
  return next;
}

/**
 * Immutably removes whatever is at `segment` within `container`, returning a
 * new container. Removing an array index splices it out (shifting later
 * elements one place earlier, so the array's length shrinks by one, matching
 * ordinary "delete this element" semantics rather than leaving a hole).
 * Removing an object property deletes that key outright.
 */
function removeSegment(
  container: unknown[] | Record<string, unknown>,
  segment: PathSegment,
  fullPath: string,
): unknown[] | Record<string, unknown> {
  assertContainerMatchesSegment(container, segment, fullPath);

  if (segment.kind === "index") {
    const array = container as unknown[];
    if (segment.index < 0 || segment.index >= array.length) {
      throw new PathTraversalError(
        fullPath,
        `index ${segment.index} is out of bounds for an array of length ${array.length}`,
      );
    }
    const next = array.slice();
    next.splice(segment.index, 1);
    return next;
  }

  const clone = { ...(container as Record<string, unknown>) };
  delete clone[segment.name];
  return clone;
}

/**
 * Recursively walks `value` down `segments`, applying `atTarget` once the
 * last segment is reached, and reconstructing every container on the path
 * back up with structural sharing (each ancestor is a fresh shallow clone;
 * every value not on the path is returned by its original reference).
 */
function recurse(
  value: unknown,
  segments: ReadonlyArray<PathSegment>,
  fullPath: string,
  atTarget: (parent: unknown[] | Record<string, unknown>, lastSegment: PathSegment) => unknown,
): unknown {
  const [segment, ...rest] = segments;
  if (segment === undefined) {
    throw new PathTraversalError(fullPath, "internal error: recursed past the last path segment");
  }

  assertContainerMatchesSegment(value, segment, fullPath);
  const container = value as unknown[] | Record<string, unknown>;

  if (rest.length === 0) {
    return atTarget(container, segment);
  }

  if (!hasSegment(container, segment)) {
    throw new PathTraversalError(
      fullPath,
      `${formatSegments(segments.slice(0, 1))} does not exist; cannot traverse further down the path`,
    );
  }

  const child = readSegment(container, segment);
  const updatedChild = recurse(child, rest, fullPath, atTarget);
  return writeSegment(container, segment, updatedChild, fullPath);
}

/**
 * Applies one `"replace"` | `"add"` | `"remove"` edit at `path` against
 * `value`, returning a new value with the edit applied. `value` is never
 * mutated; only the containers on the path from the root down to `path`'s
 * final segment are newly allocated (see this module's own doc).
 *
 * - `"replace"`: the location at `path` must already exist (an object
 *   property present, or an array index within bounds); its value is
 *   replaced with `patchValue`.
 * - `"add"`: if `path`'s final segment is an object property, it is set to
 *   `patchValue` whether or not it already existed (an `"add"` onto an
 *   existing property behaves like a replace, matching ordinary "set this
 *   field" intuition rather than requiring the caller to know in advance
 *   whether the field is already present). If the final segment is an array
 *   index, `patchValue` is inserted at that index (shifting the existing
 *   element at that index, and every element after it, one place later);
 *   the index may equal the array's current length to append.
 * - `"remove"`: the location at `path` must already exist; it is deleted (an
 *   object property is deleted outright, an array index is spliced out,
 *   shifting later elements one place earlier). `patchValue` is ignored.
 *
 * @throws {InvalidPathError} if `path` cannot be parsed (see {@link parsePath}).
 * @throws {PathTraversalError} if `path` is `"<root>"` or otherwise empty
 *   (there is no parent container to edit a root value within), if any
 *   segment before the last requires stepping into a container that does
 *   not exist or is the wrong kind, or (for `"replace"`/`"remove"`) if the
 *   final location itself does not exist.
 */
export function applyPatchAtPath(
  value: unknown,
  path: string,
  op: "replace" | "add" | "remove",
  patchValue?: unknown,
): unknown {
  const segments = parsePath(path);
  if (segments.length === 0) {
    throw new PathTraversalError(path, "cannot apply a patch at the document root itself; path must name a field within it");
  }

  return recurse(value, segments, path, (parent, lastSegment) => {
    if (op === "remove") {
      if (!hasSegment(parent, lastSegment)) {
        throw new PathTraversalError(path, `${formatSegments(segments)} does not exist; nothing to remove`);
      }
      return removeSegment(parent, lastSegment, path);
    }

    if (op === "replace") {
      if (!hasSegment(parent, lastSegment)) {
        throw new PathTraversalError(
          path,
          `${formatSegments(segments)} does not exist; "replace" requires the location to already exist (use "add" to create it)`,
        );
      }
      return writeSegment(parent, lastSegment, patchValue, path);
    }

    // op === "add": an array index inserts (shifting later elements along);
    // an object property is simply set, whether or not it already existed.
    if (lastSegment.kind === "index") {
      return insertSegment(parent, lastSegment, patchValue, path);
    }
    return writeSegment(parent, lastSegment, patchValue, path);
  });
}
