import { describe, expect, it } from "vitest";

import { describeCadraContract } from "./describe.js";
import { CURRENT_SCHEMA_VERSION } from "./envelope.js";
import { parseScene } from "./parse.js";

describe("describeCadraContract", () => {
  it("tags the whole contract with the current schema version", () => {
    const contract = describeCadraContract();
    expect(contract.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("nests the same schema version under capabilities and every generated piece", () => {
    const contract = describeCadraContract();
    expect(contract.capabilities.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("produces a fully JSON-serializable contract", () => {
    const contract = describeCadraContract();
    expect(() => JSON.stringify(contract)).not.toThrow();
  });

  it("includes a jsonSchema describing the envelope's schemaVersion and project properties", () => {
    const contract = describeCadraContract();
    const jsonSchema = contract.jsonSchema as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toHaveProperty("schemaVersion");
    expect(jsonSchema.properties).toHaveProperty("project");
    expect(jsonSchema.required).toEqual(expect.arrayContaining(["schemaVersion", "project"]));
  });

  it("includes capabilities with every scene node primitive and every easing", () => {
    const contract = describeCadraContract();
    expect(contract.capabilities.primitives.length).toBe(12);
    expect(contract.capabilities.easings.length).toBe(14);
  });

  it("leaves capabilities.codecs undefined, the documented extension point for a higher-level consumer", () => {
    const contract = describeCadraContract();
    expect(contract.capabilities.codecs).toBeUndefined();
  });

  it("includes at least four named, parseable examples", () => {
    const contract = describeCadraContract();
    expect(contract.examples.length).toBeGreaterThanOrEqual(4);

    for (const example of contract.examples) {
      expect(example.name.length).toBeGreaterThan(0);
      const result = parseScene(example.document);
      expect(
        result.success,
        `${example.name}: ${JSON.stringify(!result.success && result.diagnostics)}`,
      ).toBe(true);
    }
  });

  it("includes the multi-track-transition example among the named examples", () => {
    const contract = describeCadraContract();
    const names = contract.examples.map((example) => example.name);
    expect(names).toContain("multi-track-transition");
  });

  it("generates fresh output on every call rather than sharing mutable state", () => {
    const first = describeCadraContract();
    const second = describeCadraContract();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
