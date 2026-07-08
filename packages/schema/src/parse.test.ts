import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createIdentityTransform } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "./envelope.js";
import { DIAGNOSTIC_CODES, parseScene, type SceneParseDiagnostic } from "./parse.js";
import { applyPatchAtPath } from "./patch-path.js";

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
    // One diagnostic per offending key, named by the key's own path (not just
    // the containing object's path), so each carries its own independently
    // appliable `suggestedPatch`; see `unrecognizedKeysToDiagnostics` in
    // `./parse.ts`.
    const diagnostic = result.diagnostics.find(
      (entry) => entry.path === "project.compositions[0].framesPerSecond",
    );
    expect(diagnostic, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(diagnostic?.expected).toEqual(expect.stringMatching(/.+/));
    expect(diagnostic?.suggestedFix).toEqual(expect.stringMatching(/.+/));
  });
});

/**
 * Applies `diagnostic.suggestedPatch` (which must be present) to `document`
 * via `applyPatchAtPath`, returning the patched document. Shared by every
 * "applying the suggestedPatch fixes the document" test below so each test
 * body reads as "corrupt, find, apply, re-parse, expect success" with no
 * repeated plumbing.
 */
function applySuggestedPatch(document: unknown, diagnostic: SceneParseDiagnostic | undefined): unknown {
  expect(diagnostic?.suggestedPatch, "expected this diagnostic to carry a suggestedPatch").toBeDefined();
  const patch = diagnostic!.suggestedPatch!;
  return applyPatchAtPath(document, patch.path, patch.op, patch.value);
}

describe("parseScene: diagnostics carry a stable code and JSON-serializable received value", () => {
  it("tags a missing required field as MISSING_REQUIRED_FIELD with no received value", () => {
    const document = minimalValidDocument();
    const node = document.project.compositions[0]?.tracks[0]?.clips[0]?.node as { transform?: unknown };
    delete node.transform;

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find(
      (entry) => entry.path === "project.compositions[0].tracks[0].clips[0].node.transform",
    );
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.MISSING_REQUIRED_FIELD);
    // The field was absent, so there is no "actual value" to report.
    expect(diagnostic?.received).toBeUndefined();
  });

  it("tags a wrong-type field as WRONG_TYPE with the actual received value", () => {
    const document = minimalValidDocument();
    const composition = document.project.compositions[0] as { fps: unknown };
    composition.fps = "thirty";

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find((entry) => entry.path === "project.compositions[0].fps");
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.WRONG_TYPE);
    expect(diagnostic?.received).toBe("thirty");
  });

  it("tags an unknown node kind as UNKNOWN_NODE_KIND", () => {
    const document = minimalValidDocument();
    const node = document.project.compositions[0]?.tracks[0]?.clips[0]?.node as { kind: unknown };
    node.kind = "sprite";

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find((entry) =>
      entry.path.startsWith("project.compositions[0].tracks[0].clips[0].node"),
    );
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.UNKNOWN_NODE_KIND);
  });

  it("tags an out-of-range value as VALUE_OUT_OF_RANGE with the actual received value", () => {
    const document = minimalValidDocument();
    const composition = document.project.compositions[0] as { fps: unknown };
    composition.fps = -30;

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find((entry) => entry.path === "project.compositions[0].fps");
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.VALUE_OUT_OF_RANGE);
    expect(diagnostic?.received).toBe(-30);
  });

  it("tags an unrecognized field as UNRECOGNIZED_FIELD", () => {
    const document = minimalValidDocument();
    const composition = document.project.compositions[0] as Record<string, unknown>;
    composition.framesPerSecond = 30;

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find(
      (entry) => entry.path === "project.compositions[0].framesPerSecond",
    );
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.UNRECOGNIZED_FIELD);
  });

  it("tags an unsupported schemaVersion as UNSUPPORTED_SCHEMA_VERSION with the actual received value", () => {
    const document = { ...minimalValidDocument(), schemaVersion: 999 };

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.diagnostics[0]?.code).toBe(DIAGNOSTIC_CODES.UNSUPPORTED_SCHEMA_VERSION);
    expect(result.diagnostics[0]?.received).toBe(999);
  });

  it("tags a blank assetRef as INVALID_ASSET_REF", () => {
    const document = minimalValidDocument();
    const clip = document.project.compositions[0]?.tracks[0]?.clips[0] as { node: unknown };
    clip.node = {
      id: "image-1",
      kind: "image",
      transform: createIdentityTransform(),
      visible: true,
      assetRef: "   ",
      children: [],
    };

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find(
      (entry) => entry.path === "project.compositions[0].tracks[0].clips[0].node.assetRef",
    );
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.INVALID_ASSET_REF);
  });

  it("only flags a blank assetRef once the rest of the document is otherwise schema-valid", () => {
    // A blank assetRef alongside an unrelated structural error should not
    // also flood in a secondary INVALID_ASSET_REF diagnostic: the asset-ref
    // walk only runs once schema validation has already succeeded.
    const document = minimalValidDocument();
    const composition = document.project.compositions[0] as { fps: unknown };
    composition.fps = "not-a-number";
    const clip = document.project.compositions[0]?.tracks[0]?.clips[0] as { node: unknown };
    clip.node = {
      id: "image-1",
      kind: "image",
      transform: createIdentityTransform(),
      visible: true,
      assetRef: "",
      children: [],
    };

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.diagnostics.some((entry) => entry.code === DIAGNOSTIC_CODES.INVALID_ASSET_REF)).toBe(
      false,
    );
  });

  it("does not flag an absent optional fontRef as INVALID_ASSET_REF", () => {
    const document = minimalValidDocument();
    const clip = document.project.compositions[0]?.tracks[0]?.clips[0] as { node: unknown };
    clip.node = {
      id: "text-1",
      kind: "text",
      transform: createIdentityTransform(),
      visible: true,
      content: "hello",
      fontSize: 16,
      color: [1, 1, 1, 1],
      children: [],
      // fontRef omitted entirely.
    };

    const result = parseScene(document);
    expect(result.success).toBe(true);
  });

  /**
   * Phase 72 audit: `normalMapRef`/`aoMapRef` (`MeshMaterialConfig`, Phase
   * 55), `envMapRef` (`CompositionEnvironment`, Phase 56), `textureRef`
   * (`ParticleSystemNode`, Phase 67), and `lutRef` (`LutEffectConfig`, Phase
   * 59) are the exact same class of registry-resolved ref string as
   * `assetRef`/`geometryRef`/`materialRef`/`fontRef`, but were missing from
   * `ASSET_REF_FIELD_NAMES` until now - each of these five tests would have
   * failed (a blank ref silently passing validation) before that fix.
   */
  it("tags a blank normalMapRef/aoMapRef (nested in a mesh node's own material) as INVALID_ASSET_REF", () => {
    const document = minimalValidDocument();
    const clip = document.project.compositions[0]?.tracks[0]?.clips[0] as { node: unknown };
    clip.node = {
      id: "mesh-1",
      kind: "mesh",
      transform: createIdentityTransform(),
      visible: true,
      geometryRef: "geo-1",
      materialRef: "mat-1",
      material: { normalMapRef: "  ", aoMapRef: " ao-1 " },
      children: [],
    };

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const codes = result.diagnostics
      .filter((entry) => entry.path.endsWith("normalMapRef") || entry.path.endsWith("aoMapRef"))
      .map((entry) => entry.code);
    expect(codes).toEqual([DIAGNOSTIC_CODES.INVALID_ASSET_REF, DIAGNOSTIC_CODES.INVALID_ASSET_REF]);
  });

  it("tags a blank envMapRef (on a composition's own environment) as INVALID_ASSET_REF", () => {
    const document = minimalValidDocument();
    const composition = document.project.compositions[0] as { environment?: unknown };
    composition.environment = { envMapRef: "" };

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find((entry) => entry.path.endsWith("envMapRef"));
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.INVALID_ASSET_REF);
  });

  it("tags a blank textureRef (on a particles node) as INVALID_ASSET_REF", () => {
    const document = minimalValidDocument();
    const clip = document.project.compositions[0]?.tracks[0]?.clips[0] as { node: unknown };
    clip.node = {
      id: "particles-1",
      kind: "particles",
      transform: createIdentityTransform(),
      visible: true,
      maxParticles: 100,
      emissionRate: 10,
      shape: { type: "point" },
      lifetimeSeconds: 1,
      initialSpeed: 1,
      direction: [0, 1, 0],
      startSize: 1,
      textureRef: "   ",
      children: [],
    };

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find((entry) => entry.path.endsWith("textureRef"));
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.INVALID_ASSET_REF);
  });

  it("tags a blank lutRef (nested in a composition's own postProcessing effects) as INVALID_ASSET_REF", () => {
    const document = minimalValidDocument();
    const composition = document.project.compositions[0] as { postProcessing?: unknown };
    composition.postProcessing = { effects: [{ type: "lut", lutRef: "" }] };

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find((entry) => entry.path.endsWith("lutRef"));
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.INVALID_ASSET_REF);
  });
});

/**
 * End-to-end coverage for task 6: for every common error class this phase
 * gives a `suggestedPatch`, deliberately produce that error, apply the
 * resulting patch via `applyPatchAtPath`, and assert the patched document
 * now passes `parseScene`. Each of these is the exact "corrupt -> patch ->
 * re-validate" loop `repair_scene` automates end to end.
 */
describe("parseScene: suggestedPatch fixes the document when applied", () => {
  it("MISSING_REQUIRED_FIELD (a numeric field with a known safe default): adding the patch's value passes validation", () => {
    const document = minimalValidDocument();
    const composition = document.project.compositions[0] as { fps?: unknown };
    delete composition.fps;

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find((entry) => entry.path === "project.compositions[0].fps");
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.MISSING_REQUIRED_FIELD);
    expect(diagnostic?.suggestedPatch).toEqual({
      op: "add",
      path: "project.compositions[0].fps",
      value: 30,
    });

    const patched = applySuggestedPatch(document, diagnostic);
    expect(parseScene(patched).success).toBe(true);
  });

  it("VALUE_OUT_OF_RANGE (too_small, a negative fps): clamping to the patch's value passes validation", () => {
    const document = minimalValidDocument();
    const composition = document.project.compositions[0] as { fps: unknown };
    composition.fps = -30;

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find((entry) => entry.path === "project.compositions[0].fps");
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.VALUE_OUT_OF_RANGE);
    // fps must be positive (min exclusive at 0), so the clamp lands at 1.
    expect(diagnostic?.suggestedPatch).toEqual({
      op: "replace",
      path: "project.compositions[0].fps",
      value: 1,
    });

    const patched = applySuggestedPatch(document, diagnostic);
    expect(parseScene(patched).success).toBe(true);
  });

  it("VALUE_OUT_OF_RANGE (too_big, an out-of-range color channel): clamping to the patch's value passes validation", () => {
    const document = minimalValidDocument();
    const clip = document.project.compositions[0]?.tracks[0]?.clips[0] as { node: unknown };
    clip.node = {
      id: "light-1",
      kind: "light",
      transform: createIdentityTransform(),
      visible: true,
      lightType: "point",
      color: [2, 1, 1, 1],
      intensity: 1,
      children: [],
    };

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find((entry) =>
      entry.path.endsWith("color[0]"),
    );
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.VALUE_OUT_OF_RANGE);
    expect(diagnostic?.suggestedPatch?.value).toBe(1);

    const patched = applySuggestedPatch(document, diagnostic);
    expect(parseScene(patched).success).toBe(true);
  });

  it("UNRECOGNIZED_FIELD (a typo'd field name): removing it via the patch passes validation", () => {
    const document = minimalValidDocument();
    const composition = document.project.compositions[0] as Record<string, unknown>;
    composition.framesPerSecond = 30;

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find(
      (entry) => entry.path === "project.compositions[0].framesPerSecond",
    );
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.UNRECOGNIZED_FIELD);
    expect(diagnostic?.suggestedPatch).toEqual({
      op: "remove",
      path: "project.compositions[0].framesPerSecond",
    });

    const patched = applySuggestedPatch(document, diagnostic);
    expect(parseScene(patched).success).toBe(true);
  });

  it("INVALID_ASSET_REF (whitespace-padded but otherwise real ref): trimming via the patch passes validation", () => {
    const document = minimalValidDocument();
    const clip = document.project.compositions[0]?.tracks[0]?.clips[0] as { node: unknown };
    clip.node = {
      id: "image-1",
      kind: "image",
      transform: createIdentityTransform(),
      visible: true,
      assetRef: "  cadra-asset://abc123  ",
      children: [],
    };

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find(
      (entry) => entry.path === "project.compositions[0].tracks[0].clips[0].node.assetRef",
    );
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.INVALID_ASSET_REF);
    expect(diagnostic?.suggestedPatch).toEqual({
      op: "replace",
      path: "project.compositions[0].tracks[0].clips[0].node.assetRef",
      value: "cadra-asset://abc123",
    });

    const patched = applySuggestedPatch(document, diagnostic);
    expect(parseScene(patched).success).toBe(true);
  });
});

/**
 * The flip side of the above: error classes that are genuinely ambiguous or
 * unfixable with a single safe patch must leave `suggestedPatch` undefined,
 * not fabricate a guess. See `deriveSuggestedPatch` in `./parse.ts` for the
 * reasoning behind each of these.
 */
describe("parseScene: genuinely unfixable/ambiguous errors are left unpatched", () => {
  it("UNKNOWN_NODE_KIND: no suggestedPatch (guessing a replacement kind is not safe)", () => {
    const document = minimalValidDocument();
    const node = document.project.compositions[0]?.tracks[0]?.clips[0]?.node as { kind: unknown };
    node.kind = "sprite";

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === DIAGNOSTIC_CODES.UNKNOWN_NODE_KIND,
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.suggestedPatch).toBeUndefined();
  });

  it("INVALID_ENUM_VALUE (bad lightType): no suggestedPatch (ambiguous which of several values was meant)", () => {
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
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.INVALID_ENUM_VALUE);
    expect(diagnostic?.suggestedPatch).toBeUndefined();
  });

  it("WRONG_TYPE (a present but wrong-type value): no suggestedPatch (ambiguous what value was actually meant)", () => {
    const document = minimalValidDocument();
    const composition = document.project.compositions[0] as { fps: unknown };
    composition.fps = "thirty";

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find((entry) => entry.path === "project.compositions[0].fps");
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.WRONG_TYPE);
    expect(diagnostic?.suggestedPatch).toBeUndefined();
  });

  it("MISSING_REQUIRED_FIELD with no known safe default (a missing id): no suggestedPatch", () => {
    const document = minimalValidDocument();
    const node = document.project.compositions[0]?.tracks[0]?.clips[0]?.node as { id?: unknown };
    delete node.id;

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find(
      (entry) => entry.path === "project.compositions[0].tracks[0].clips[0].node.id",
    );
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.MISSING_REQUIRED_FIELD);
    expect(diagnostic?.suggestedPatch).toBeUndefined();
  });

  it("INVALID_ASSET_REF (empty string, nothing to trim): no suggestedPatch (no way to know which asset was meant)", () => {
    const document = minimalValidDocument();
    const clip = document.project.compositions[0]?.tracks[0]?.clips[0] as { node: unknown };
    clip.node = {
      id: "image-1",
      kind: "image",
      transform: createIdentityTransform(),
      visible: true,
      assetRef: "",
      children: [],
    };

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === DIAGNOSTIC_CODES.INVALID_ASSET_REF,
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.suggestedPatch).toBeUndefined();
  });

  it("UNSUPPORTED_SCHEMA_VERSION: no suggestedPatch (setting the number alone without migrating would silently corrupt semantics)", () => {
    const document = { ...minimalValidDocument(), schemaVersion: 999 };

    const result = parseScene(document);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.diagnostics[0]?.code).toBe(DIAGNOSTIC_CODES.UNSUPPORTED_SCHEMA_VERSION);
    expect(result.diagnostics[0]?.suggestedPatch).toBeUndefined();
  });
});
