import { describe, expect, it } from "vitest";

import { applyPatchAtPath, InvalidPathError, parsePath, PathTraversalError } from "./patch-path.js";

describe("parsePath", () => {
  it("parses a plain dotted property path", () => {
    expect(parsePath("project.name")).toEqual([
      { kind: "property", name: "project" },
      { kind: "property", name: "name" },
    ]);
  });

  it("parses a single bracketed index", () => {
    expect(parsePath("compositions[0]")).toEqual([
      { kind: "property", name: "compositions" },
      { kind: "index", index: 0 },
    ]);
  });

  it("parses a mixed dotted/bracketed path matching parse.ts's own format", () => {
    expect(parsePath("project.compositions[0].tracks[1].clips[0].node.transform.position")).toEqual([
      { kind: "property", name: "project" },
      { kind: "property", name: "compositions" },
      { kind: "index", index: 0 },
      { kind: "property", name: "tracks" },
      { kind: "index", index: 1 },
      { kind: "property", name: "clips" },
      { kind: "index", index: 0 },
      { kind: "property", name: "node" },
      { kind: "property", name: "transform" },
      { kind: "property", name: "position" },
    ]);
  });

  it("parses consecutive bracketed indices (a 2D-array-style path)", () => {
    expect(parsePath("grid[0][1]")).toEqual([
      { kind: "property", name: "grid" },
      { kind: "index", index: 0 },
      { kind: "index", index: 1 },
    ]);
  });

  it("parses the literal <root> as an empty segment list", () => {
    expect(parsePath("<root>")).toEqual([]);
  });

  it("parses a bare top-level property with no dots", () => {
    expect(parsePath("schemaVersion")).toEqual([{ kind: "property", name: "schemaVersion" }]);
  });

  it("rejects an empty string", () => {
    expect(() => parsePath("")).toThrow(InvalidPathError);
  });

  it("rejects a malformed bracket (unclosed)", () => {
    expect(() => parsePath("compositions[0")).toThrow(InvalidPathError);
  });

  it("rejects a non-numeric index", () => {
    expect(() => parsePath("compositions[abc]")).toThrow(InvalidPathError);
  });

  it("rejects an index with no preceding property name", () => {
    expect(() => parsePath("[0]")).toThrow(InvalidPathError);
  });

  it("rejects a double-dot (empty segment)", () => {
    expect(() => parsePath("project..name")).toThrow(InvalidPathError);
  });
});

describe("applyPatchAtPath: replace", () => {
  it("replaces a top-level scalar property", () => {
    const document = { schemaVersion: 999 };
    const result = applyPatchAtPath(document, "schemaVersion", "replace", 1);
    expect(result).toEqual({ schemaVersion: 1 });
    // Original is untouched.
    expect(document).toEqual({ schemaVersion: 999 });
  });

  it("replaces a deeply nested scalar", () => {
    const document = {
      project: { compositions: [{ id: "c1", fps: -30 }] },
    };
    const result = applyPatchAtPath(document, "project.compositions[0].fps", "replace", 30);
    expect(result).toEqual({
      project: { compositions: [{ id: "c1", fps: 30 }] },
    });
  });

  it("uses structural sharing: untouched siblings keep their exact object reference", () => {
    const untouchedComposition = { id: "c2", fps: 60 };
    const document = {
      project: {
        compositions: [{ id: "c1", fps: -30 }, untouchedComposition],
      },
    };
    const result = applyPatchAtPath(document, "project.compositions[0].fps", "replace", 30) as typeof document;

    expect(result.project.compositions[1]).toBe(untouchedComposition);
    expect(result.project.compositions[0]).not.toBe(document.project.compositions[0]);
    expect(result.project).not.toBe(document.project);
    expect(result).not.toBe(document);
  });

  it("replaces an array element by index", () => {
    const document = { tags: ["a", "b", "c"] };
    const result = applyPatchAtPath(document, "tags[1]", "replace", "B");
    expect(result).toEqual({ tags: ["a", "B", "c"] });
  });

  it("replaces a whole object value, not just a scalar", () => {
    const document = { transform: { position: [0, 0, 0] } };
    const result = applyPatchAtPath(document, "transform", "replace", { position: [1, 2, 3] });
    expect(result).toEqual({ transform: { position: [1, 2, 3] } });
  });

  it("throws PathTraversalError replacing a property that does not exist", () => {
    const document = { project: {} };
    expect(() => applyPatchAtPath(document, "project.missing", "replace", 1)).toThrow(PathTraversalError);
  });

  it("throws PathTraversalError replacing an out-of-bounds array index", () => {
    const document = { tags: ["a"] };
    expect(() => applyPatchAtPath(document, "tags[5]", "replace", "x")).toThrow(PathTraversalError);
  });

  it("throws PathTraversalError when an intermediate segment does not exist", () => {
    const document = { project: {} };
    expect(() => applyPatchAtPath(document, "project.compositions[0].fps", "replace", 30)).toThrow(
      PathTraversalError,
    );
  });

  it("throws PathTraversalError when an intermediate segment is the wrong container kind", () => {
    const document = { project: "not-an-object" };
    expect(() => applyPatchAtPath(document, "project.name", "replace", "x")).toThrow(PathTraversalError);
  });

  it("throws PathTraversalError attempting to apply a patch at the document root", () => {
    const document = { a: 1 };
    expect(() => applyPatchAtPath(document, "<root>", "replace", { a: 2 })).toThrow(PathTraversalError);
  });
});

describe("applyPatchAtPath: add", () => {
  it("adds a missing object property", () => {
    const document = { project: { compositions: [{ id: "c1" }] } };
    const result = applyPatchAtPath(document, "project.compositions[0].fps", "add", 30);
    expect(result).toEqual({ project: { compositions: [{ id: "c1", fps: 30 }] } });
  });

  it("behaves like replace when adding a property that already exists", () => {
    const document = { fps: 24 };
    const result = applyPatchAtPath(document, "fps", "add", 30);
    expect(result).toEqual({ fps: 30 });
  });

  it("inserts an array element at an index, shifting later elements", () => {
    const document = { tags: ["a", "c"] };
    const result = applyPatchAtPath(document, "tags[1]", "add", "b");
    expect(result).toEqual({ tags: ["a", "b", "c"] });
  });

  it("appends to an array when the index equals its current length", () => {
    const document = { tags: ["a", "b"] };
    const result = applyPatchAtPath(document, "tags[2]", "add", "c");
    expect(result).toEqual({ tags: ["a", "b", "c"] });
  });

  it("throws PathTraversalError adding at an index far past the array's length", () => {
    const document = { tags: ["a"] };
    expect(() => applyPatchAtPath(document, "tags[5]", "add", "x")).toThrow(PathTraversalError);
  });

  it("uses structural sharing for an add, same as replace", () => {
    const untouched = { id: "c2" };
    const document = { compositions: [{ id: "c1" }, untouched] };
    const result = applyPatchAtPath(document, "compositions[0].fps", "add", 30) as typeof document;
    expect(result.compositions[1]).toBe(untouched);
  });
});

describe("applyPatchAtPath: remove", () => {
  it("removes an object property outright", () => {
    const document = { fps: 30, framesPerSecond: 30 };
    const result = applyPatchAtPath(document, "framesPerSecond", "remove");
    expect(result).toEqual({ fps: 30 });
    expect(Object.prototype.hasOwnProperty.call(result, "framesPerSecond")).toBe(false);
  });

  it("removes a nested object property", () => {
    const document = { project: { compositions: [{ id: "c1", extra: true }] } };
    const result = applyPatchAtPath(document, "project.compositions[0].extra", "remove");
    expect(result).toEqual({ project: { compositions: [{ id: "c1" }] } });
  });

  it("removes an array element, splicing the array shorter", () => {
    const document = { tags: ["a", "b", "c"] };
    const result = applyPatchAtPath(document, "tags[1]", "remove");
    expect(result).toEqual({ tags: ["a", "c"] });
  });

  it("throws PathTraversalError removing a property that does not exist", () => {
    const document = { project: {} };
    expect(() => applyPatchAtPath(document, "project.missing", "remove")).toThrow(PathTraversalError);
  });

  it("throws PathTraversalError removing an out-of-bounds array index", () => {
    const document = { tags: ["a"] };
    expect(() => applyPatchAtPath(document, "tags[5]", "remove")).toThrow(PathTraversalError);
  });
});

describe("applyPatchAtPath: propagates parsePath's own errors", () => {
  it("throws InvalidPathError for a malformed path before attempting any traversal", () => {
    const document = { a: 1 };
    expect(() => applyPatchAtPath(document, "a[oops]", "replace", 2)).toThrow(InvalidPathError);
  });
});
