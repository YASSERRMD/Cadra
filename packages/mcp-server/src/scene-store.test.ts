import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIdentityTransform } from "@cadra/core";
import type { SceneDocument } from "@cadra/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listSceneFiles,
  readSceneFile,
  sanitizeSceneId,
  summarizeSceneDocument,
  writeSceneDocument,
} from "./scene-store.js";

function minimalDocument(overrides: Partial<SceneDocument["project"]> = {}): SceneDocument {
  return {
    schemaVersion: 1,
    project: {
      id: "proj-1",
      name: "Project One",
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
                    id: "root",
                    kind: "group",
                    transform: createIdentityTransform(),
                    visible: true,
                    children: [
                      {
                        id: "child-1",
                        kind: "mesh",
                        transform: createIdentityTransform(),
                        visible: true,
                        geometryRef: "geo-1",
                        materialRef: "mat-1",
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
      ...overrides,
    },
  };
}

describe("sanitizeSceneId", () => {
  it("accepts a plain alphanumeric id", () => {
    expect(sanitizeSceneId("scene-1")).toEqual({ valid: true, sceneId: "scene-1" });
  });

  it("accepts underscores and mixed case", () => {
    expect(sanitizeSceneId("My_Scene_123")).toEqual({ valid: true, sceneId: "My_Scene_123" });
  });

  it("rejects an empty id", () => {
    const result = sanitizeSceneId("");
    expect(result.valid).toBe(false);
  });

  it("rejects an id containing '..'", () => {
    const result = sanitizeSceneId("../../etc/passwd");
    expect(result.valid).toBe(false);
  });

  it("rejects an id containing a forward slash", () => {
    const result = sanitizeSceneId("foo/bar");
    expect(result.valid).toBe(false);
  });

  it("rejects an id containing a backslash", () => {
    const result = sanitizeSceneId("foo\\bar");
    expect(result.valid).toBe(false);
  });

  it("rejects an absolute path", () => {
    const result = sanitizeSceneId("/etc/passwd");
    expect(result.valid).toBe(false);
  });

  it("rejects an id containing whitespace", () => {
    const result = sanitizeSceneId("scene one");
    expect(result.valid).toBe(false);
  });

  it("rejects an id containing a null byte", () => {
    const result = sanitizeSceneId(`scene${String.fromCharCode(0)}evil`);
    expect(result.valid).toBe(false);
  });

  it("rejects an id longer than the maximum length", () => {
    const result = sanitizeSceneId("a".repeat(500));
    expect(result.valid).toBe(false);
  });

  it("rejects an id containing a dot (extension-like traversal risk)", () => {
    const result = sanitizeSceneId("scene.json");
    expect(result.valid).toBe(false);
  });
});

describe("scene file persistence", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-scene-store-test-"));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("returns undefined reading a scene that was never written", async () => {
    const result = await readSceneFile(workspaceRoot, "does-not-exist");
    expect(result).toBeUndefined();
  });

  it("returns an empty list when the scenes directory does not exist yet", async () => {
    const files = await listSceneFiles(workspaceRoot);
    expect(files).toEqual([]);
  });

  it("writes a scene document and reads it back byte-for-byte equal, with a lastModified timestamp", async () => {
    const document = minimalDocument();
    await writeSceneDocument(workspaceRoot, "scene-1", document);

    const file = await readSceneFile(workspaceRoot, "scene-1");
    expect(file).toBeDefined();
    expect(file?.raw).toEqual(document);
    expect(typeof file?.lastModified).toBe("string");
    expect(Number.isNaN(Date.parse(file!.lastModified))).toBe(false);
  });

  it("creates the scenes subdirectory automatically on first write", async () => {
    await writeSceneDocument(workspaceRoot, "scene-1", minimalDocument());
    const files = await listSceneFiles(workspaceRoot);
    expect(files).toHaveLength(1);
    expect(files[0]?.sceneId).toBe("scene-1");
  });

  it("overwrites an existing scene file when writing the same id again", async () => {
    await writeSceneDocument(workspaceRoot, "scene-1", minimalDocument());
    const updated = minimalDocument({ name: "Renamed" });
    await writeSceneDocument(workspaceRoot, "scene-1", updated);

    const file = await readSceneFile(workspaceRoot, "scene-1");
    expect((file?.raw as SceneDocument).project.name).toBe("Renamed");
  });

  it("lists every persisted scene", async () => {
    await writeSceneDocument(workspaceRoot, "scene-a", minimalDocument());
    await writeSceneDocument(workspaceRoot, "scene-b", minimalDocument());

    const files = await listSceneFiles(workspaceRoot);
    const ids = files.map((file) => file.sceneId).sort();
    expect(ids).toEqual(["scene-a", "scene-b"]);
  });
});

describe("summarizeSceneDocument", () => {
  it("derives a compact summary from a full document", () => {
    const document = minimalDocument();
    const summary = summarizeSceneDocument("scene-1", document, "2024-01-01T00:00:00.000Z");

    expect(summary).toEqual({
      id: "scene-1",
      name: "Project One",
      compositionIds: ["comp-1"],
      compositionCount: 1,
      nodeCount: 2,
      lastModified: "2024-01-01T00:00:00.000Z",
    });
  });

  it("counts nodes across multiple clips, tracks, and compositions", () => {
    const document: SceneDocument = {
      schemaVersion: 1,
      project: {
        id: "proj-multi",
        name: "Multi",
        compositions: [
          {
            id: "comp-a",
            name: "A",
            fps: 30,
            durationInFrames: 30,
            width: 100,
            height: 100,
            tracks: [
              {
                id: "track-a1",
                clips: [
                  {
                    id: "clip-a1",
                    startFrame: 0,
                    durationInFrames: 30,
                    node: {
                      id: "n1",
                      kind: "group",
                      transform: createIdentityTransform(),
                      visible: true,
                      children: [],
                    },
                  },
                ],
              },
              {
                id: "track-a2",
                clips: [
                  {
                    id: "clip-a2",
                    startFrame: 0,
                    durationInFrames: 30,
                    node: {
                      id: "n2",
                      kind: "group",
                      transform: createIdentityTransform(),
                      visible: true,
                      children: [
                        {
                          id: "n3",
                          kind: "group",
                          transform: createIdentityTransform(),
                          visible: true,
                          children: [],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
          {
            id: "comp-b",
            name: "B",
            fps: 30,
            durationInFrames: 30,
            width: 100,
            height: 100,
            tracks: [],
          },
        ],
      },
    };

    const summary = summarizeSceneDocument("scene-multi", document, "2024-01-01T00:00:00.000Z");
    expect(summary.compositionIds).toEqual(["comp-a", "comp-b"]);
    expect(summary.compositionCount).toBe(2);
    expect(summary.nodeCount).toBe(3);
  });
});
