import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createIdentityTransform } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "./envelope.js";
import { parseScene } from "./parse.js";

const EXAMPLE_NAMES = [
  "title-card",
  "moving-shape",
  "camera-pan",
  "multi-track-transition",
] as const;

function loadExample(name: (typeof EXAMPLE_NAMES)[number]): unknown {
  const path = fileURLToPath(new URL(`../examples/${name}.scene.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

function minimalValidDocument() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
      id: "p1",
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
                    id: "node-1",
                    kind: "mesh",
                    transform: createIdentityTransform(),
                    visible: true,
                    geometryRef: "geo-1",
                    materialRef: "mat-1",
                    children: [],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

describe("parseScene: valid documents", () => {
  it("accepts a minimal valid document", () => {
    const result = parseScene(minimalValidDocument());
    expect(result.success).toBe(true);
  });

  it.each(EXAMPLE_NAMES)("accepts the %s example document", (name) => {
    const result = parseScene(loadExample(name));
    expect(result.success).toBe(true);
  });

  it("returns the fully-typed document on success", () => {
    const result = parseScene(minimalValidDocument());
    if (!result.success) {
      throw new Error("expected parseScene to succeed");
    }
    expect(result.document.project.id).toBe("p1");
    expect(result.document.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("parseScene: invalid documents", () => {
  it("reports a missing required field with the exact offending path", () => {
    const document = minimalValidDocument();
    // Delete a deeply-nested required field: the clip's `node.transform`.
    const node = document.project.compositions[0]?.tracks[0]?.clips[0]?.node as {
      transform?: unknown;
    };
    delete node.transform;

    const result = parseScene(document);

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        path: "project.compositions[0].tracks[0].clips[0].node.transform",
      }),
    );
  });

  it("reports a wrong-type field with the exact offending path", () => {
    const document = minimalValidDocument();
    const composition = document.project.compositions[0] as { fps: unknown };
    // fps must be a number; supply a string instead.
    composition.fps = "thirty";

    const result = parseScene(document);

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        path: "project.compositions[0].fps",
      }),
    );
    expect(result.diagnostics.some((diagnostic) => /number/i.test(diagnostic.message))).toBe(true);
  });

  it("reports an invalid enum value (bad SceneNode kind) with the exact offending path", () => {
    const document = minimalValidDocument();
    const node = document.project.compositions[0]?.tracks[0]?.clips[0]?.node as {
      kind: unknown;
    };
    node.kind = "sprite";

    const result = parseScene(document);

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.path.startsWith("project.compositions[0].tracks[0].clips[0].node"),
      ),
    ).toBe(true);
  });

  it("reports an invalid enum value (bad lightType) with the exact offending path", () => {
    const document = minimalValidDocument();
    const clip = document.project.compositions[0]?.tracks[0]?.clips[0] as { node: unknown };
    clip.node = {
      id: "light-1",
      kind: "light",
      transform: createIdentityTransform(),
      visible: true,
      lightType: "neon",
      color: [1, 1, 1, 1],
      intensity: 1,
      children: [],
    };

    const result = parseScene(document);

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        path: "project.compositions[0].tracks[0].clips[0].node.lightType",
      }),
    );
  });

  it("reports an unsupported schemaVersion with a clear diagnostic", () => {
    const document = { ...minimalValidDocument(), schemaVersion: 999 };

    const result = parseScene(document);

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        path: "schemaVersion",
        message: expect.stringMatching(/unsupported schema version 999/i),
      }),
    ]);
  });
});

/**
 * Table-driven coverage for the common error classes `enrichIssue` (in
 * `./parse.ts`) recognizes: each case corrupts a fresh
 * `minimalValidDocument()` in one specific, structurally-recognizable way,
 * and asserts the resulting diagnostic at the expected path carries a
 * non-empty `expected` and `suggestedFix`, not just a `message`.
 *
 * This is deliberately a separate `describe` block from
 * "parseScene: invalid documents" above: that block asserts `path` and
 * `message` are correct (the pre-Phase-27 contract), while this one asserts
 * the new `expected`/`suggestedFix` enrichment specifically, so a future
 * change that regresses only the enrichment (while leaving `path`/`message`
 * intact) fails a test named for exactly that.
 */
interface DiagnosticEnrichmentCase {
  /** Short label for the error class, used as the test name. */
  name: string;
  /** Mutates a fresh minimal valid document in place to introduce the error. */
  corrupt: (document: ReturnType<typeof minimalValidDocument>) => void;
  /** The exact offending path the enriched diagnostic is expected at. */
  path: string;
}

const DIAGNOSTIC_ENRICHMENT_CASES: DiagnosticEnrichmentCase[] = [
  {
    name: "unknown node kind",
    corrupt: (document) => {
      const node = document.project.compositions[0]?.tracks[0]?.clips[0]?.node as { kind: unknown };
      node.kind = "sprite";
    },
    path: "project.compositions[0].tracks[0].clips[0].node.kind",
  },
  {
    name: "missing required field",
    corrupt: (document) => {
      const node = document.project.compositions[0]?.tracks[0]?.clips[0]?.node as {
        transform?: unknown;
      };
      delete node.transform;
    },
    path: "project.compositions[0].tracks[0].clips[0].node.transform",
  },
  {
    name: "value out of allowed range",
    corrupt: (document) => {
      const composition = document.project.compositions[0] as { fps: unknown };
      composition.fps = -30;
    },
    path: "project.compositions[0].fps",
  },
  {
    name: "unsupported schemaVersion",
    corrupt: (document) => {
      (document as { schemaVersion: unknown }).schemaVersion = 999;
    },
    path: "schemaVersion",
  },
];

describe("parseScene: diagnostics include expected and suggestedFix", () => {
  it.each(DIAGNOSTIC_ENRICHMENT_CASES)(
    "reports a non-empty expected and suggestedFix for: $name",
    ({ corrupt, path }) => {
      const document = minimalValidDocument();
      corrupt(document);

      const result = parseScene(document);

      expect(result.success).toBe(false);
      if (result.success) {
        return;
      }
      const diagnostic = result.diagnostics.find((entry) => entry.path === path);
      expect(diagnostic, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
      expect(diagnostic?.expected).toEqual(expect.stringMatching(/.+/));
      expect(diagnostic?.suggestedFix).toEqual(expect.stringMatching(/.+/));
    },
  );

  it("reports expected/suggestedFix for an invalid enum value (bad lightType)", () => {
    const document = minimalValidDocument();
    const clip = document.project.compositions[0]?.tracks[0]?.clips[0] as { node: unknown };
    clip.node = {
      id: "light-1",
      kind: "light",
      transform: createIdentityTransform(),
      visible: true,
      lightType: "neon",
      color: [1, 1, 1, 1],
      intensity: 1,
      children: [],
    };

    const result = parseScene(document);

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find(
      (entry) => entry.path === "project.compositions[0].tracks[0].clips[0].node.lightType",
    );
    expect(diagnostic, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(diagnostic?.expected).toEqual(expect.stringMatching(/.+/));
    expect(diagnostic?.suggestedFix).toEqual(expect.stringMatching(/.+/));
  });

  it("reports expected/suggestedFix for an unrecognized field name (strict object typo)", () => {
    const document = minimalValidDocument();
    const composition = document.project.compositions[0] as Record<string, unknown>;
    composition.framesPerSecond = 30;

    const result = parseScene(document);

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find((entry) => entry.path === "project.compositions[0]");
    expect(diagnostic, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(diagnostic?.expected).toEqual(expect.stringMatching(/.+/));
    expect(diagnostic?.suggestedFix).toEqual(expect.stringMatching(/.+/));
  });
});
