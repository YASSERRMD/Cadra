import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import type { SceneDocument } from "./envelope.js";
import { EXAMPLE_SCENE_DOCUMENTS } from "./examples.js";
import { generateSceneJsonSchema } from "./json-schema.js";

describe("generateSceneJsonSchema", () => {
  it("produces a JSON-serializable object", () => {
    const result = generateSceneJsonSchema();
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("describes an object with schemaVersion and project properties", () => {
    const result = generateSceneJsonSchema() as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(result.type).toBe("object");
    expect(result.properties).toHaveProperty("schemaVersion");
    expect(result.properties).toHaveProperty("project");
    expect(result.required).toEqual(expect.arrayContaining(["schemaVersion", "project"]));
  });

  it("flows .describe() text through as JSON Schema descriptions", () => {
    const result = generateSceneJsonSchema() as {
      properties: { schemaVersion: { description?: string } };
    };

    expect(result.properties.schemaVersion.description).toMatch(/schema version/i);
  });
});

/**
 * `meshNodeSchema`'s `.superRefine` (`./scene-node.ts`) is a plain runtime
 * predicate `z.toJSONSchema` cannot see, so without `generateSceneJsonSchema`'s
 * own post-processing (`injectMeshNodeRefConstraints`), a mesh node with
 * neither a ref nor its inline alternative would validate successfully
 * against the raw JSON Schema even though `parseScene` rejects it. These
 * tests exercise that constraint the same way `examples.test.ts` exercises
 * the artifact as a whole: through an independent JSON Schema validator
 * (`ajv`), not through this package's own Zod-based parser, since the whole
 * point is that an external consumer with only `scene.schema.json` (no Zod,
 * no `parseScene`) gets the same guarantee.
 */
describe("generateSceneJsonSchema: mesh node geometryRef/materialRef 'at least one of' constraint", () => {
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(generateSceneJsonSchema());

  /** A real, already-valid document (the "moving-shape" curated example) plus a direct handle on its first mesh node, so each test only needs to edit the one field it cares about. */
  function movingShapeDocumentWithFirstMeshNode(): { document: SceneDocument; node: Record<string, unknown> } {
    const example = EXAMPLE_SCENE_DOCUMENTS.find((candidate) => candidate.name === "moving-shape");
    if (example === undefined) {
      throw new Error("expected the curated 'moving-shape' example to exist");
    }
    const document = structuredClone(example.document);
    const node = document.project.compositions[0]!.tracks[0]!.clips[0]!.node as unknown as Record<string, unknown>;
    return { document, node };
  }

  it("rejects a mesh node with neither geometryRef nor an inline geometry", () => {
    const { document, node } = movingShapeDocumentWithFirstMeshNode();
    delete node.geometryRef;
    delete node.geometry;
    expect(validate(document)).toBe(false);
  });

  it("rejects a mesh node with neither materialRef nor an inline material", () => {
    const { document, node } = movingShapeDocumentWithFirstMeshNode();
    delete node.materialRef;
    delete node.material;
    expect(validate(document)).toBe(false);
  });

  it("accepts a mesh node with only inline geometry and material, geometryRef/materialRef both omitted", () => {
    const { document, node } = movingShapeDocumentWithFirstMeshNode();
    delete node.geometryRef;
    delete node.materialRef;
    node.geometry = { type: "box" };
    node.material = {};
    expect(validate(document), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("accepts a mesh node with only geometryRef/materialRef, no inline geometry/material (regression)", () => {
    const { document, node } = movingShapeDocumentWithFirstMeshNode();
    delete node.geometry;
    delete node.material;
    expect(validate(document), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});
