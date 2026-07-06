import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EXAMPLE_SCENE_DOCUMENTS } from "./examples.js";
import { parseScene } from "./parse.js";

/**
 * `./examples.ts` inlines the same four example documents that live as
 * human-browsable `.scene.json` files under `../examples/`, for the reason
 * documented on `EXAMPLE_SCENE_DOCUMENTS`: a runtime `describeCadraContract()`
 * needs its `examples` field to work the same for an in-repo caller and a
 * consumer who only has the published npm package, and the sibling
 * `../examples/` directory is not guaranteed to exist for the latter.
 *
 * That duplication is only safe if the two copies can never silently drift
 * apart. This test is the guard: it loads each `.scene.json` file directly
 * and asserts it deep-equals (as parsed JSON, so key order does not matter)
 * the corresponding entry's `document` in `EXAMPLE_SCENE_DOCUMENTS`.
 */

function loadExampleJson(name: string): unknown {
  const path = fileURLToPath(new URL(`../examples/${name}.scene.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("EXAMPLE_SCENE_DOCUMENTS matches the on-disk .scene.json files", () => {
  it.each(EXAMPLE_SCENE_DOCUMENTS.map((example) => example.name))(
    "the '%s' inline document deep-equals its .scene.json file",
    (name) => {
      const example = EXAMPLE_SCENE_DOCUMENTS.find((entry) => entry.name === name);
      expect(example).toBeDefined();

      const fromDisk = loadExampleJson(name);
      // Round-trip the inline document through JSON so both sides are plain
      // JSON values (no undefined-valued optional fields, no object
      // identity), matching how the .scene.json file was itself parsed.
      const inlineAsJson = JSON.parse(JSON.stringify(example?.document));
      expect(inlineAsJson).toEqual(fromDisk);
    },
  );

  it("every inline example document parses successfully via parseScene", () => {
    for (const example of EXAMPLE_SCENE_DOCUMENTS) {
      const result = parseScene(example.document);
      expect(
        result.success,
        `${example.name}: ${JSON.stringify(!result.success && result.diagnostics)}`,
      ).toBe(true);
    }
  });

  it("names every example after its corresponding .scene.json file with a non-empty description", () => {
    for (const example of EXAMPLE_SCENE_DOCUMENTS) {
      expect(example.name.length).toBeGreaterThan(0);
      expect(example.description.length).toBeGreaterThan(0);
      // Throws if the file does not exist, which is itself a useful assertion.
      expect(() => loadExampleJson(example.name)).not.toThrow();
    }
  });
});
