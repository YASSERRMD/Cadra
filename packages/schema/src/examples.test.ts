import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { parseScene } from "./parse.js";

/**
 * Proves the *generated JSON Schema artifact* actually accepts real
 * documents, not just the Zod schemas it was generated from: this test
 * loads `dist/scene.schema.json` (the exact file this package's `build`
 * script produces and that gets committed to git) and validates every
 * example document in `../examples/` against it directly with an
 * independent JSON Schema validator (ajv). This is a genuinely separate code
 * path from `parseScene`,
 * which validates through Zod: a bug that only affects JSON Schema
 * generation (and not Zod's own `safeParse`) would be invisible to
 * `parse.test.ts` but caught here.
 *
 * Requires `dist/scene.schema.json` to already exist, i.e. this package's
 * `build` script must have run before this test suite (the same ordering
 * `pnpm -w build` before `pnpm -w test` already gives in CI and in the
 * verification steps for this phase).
 */

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

function loadGeneratedJsonSchema(): Record<string, unknown> {
  const path = fileURLToPath(new URL("../dist/scene.schema.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("generated JSON Schema artifact accepts the example documents", () => {
  const ajv = new Ajv2020({ strict: false });
  const jsonSchema = loadGeneratedJsonSchema();
  const validate = ajv.compile(jsonSchema);

  it.each(EXAMPLE_NAMES)("validates the %s example against dist/scene.schema.json", (name) => {
    const document = loadExample(name);
    const valid = validate(document);

    expect(valid, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});

describe("parseScene accepts the example documents", () => {
  it.each(EXAMPLE_NAMES)("parses the %s example successfully", (name) => {
    const result = parseScene(loadExample(name));

    expect(result.success, JSON.stringify(!result.success && result.diagnostics)).toBe(true);
  });
});
