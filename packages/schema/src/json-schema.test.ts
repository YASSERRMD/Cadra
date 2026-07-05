import { describe, expect, it } from "vitest";

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
