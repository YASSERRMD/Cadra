#!/usr/bin/env node
/**
 * Generates `dist/scene.schema.json` from the compiled Zod schemas.
 *
 * Run as the second step of this package's `build` script, after `tsc` has
 * emitted `dist/`. Importing the compiled `dist/json-schema.js` (rather than
 * re-implementing generation here, or reaching into `src/`) guarantees the
 * artifact is generated from the exact same `generateSceneJsonSchema`
 * function the package exports and tests exercise, so the committed JSON
 * file can never quietly drift from what the published package actually
 * does.
 *
 * Usage: node scripts/generate-json-schema.mjs
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { generateSceneJsonSchema } from "../dist/json-schema.js";

const outputPath = fileURLToPath(new URL("../dist/scene.schema.json", import.meta.url));

async function main() {
  const jsonSchema = generateSceneJsonSchema();
  const serialized = `${JSON.stringify(jsonSchema, null, 2)}\n`;
  await writeFile(outputPath, serialized, "utf8");
  console.log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error("Failed to generate scene.schema.json:", error);
  process.exitCode = 1;
});
