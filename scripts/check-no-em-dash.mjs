#!/usr/bin/env node
/**
 * Fails with a non-zero exit code if the em dash character (U+2014) appears
 * in any git-tracked text file. Prints file:line references for every hit.
 *
 * Usage: node scripts/check-no-em-dash.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Only the first slice of a file is checked for a NUL byte when guessing
// whether it is binary, matching the heuristic used by tools like `grep -I`.
const BINARY_SNIFF_BYTES = 8000;

// Written as an escape sequence rather than a literal glyph so this file
// itself never contains the character it is scanning for.
const EM_DASH = "\u2014";

// Binary and generated file extensions are skipped since they cannot
// meaningfully contain the em dash character and may not be valid UTF-8.
const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".pdf",
  ".zip",
  ".gz",
  ".mp4",
  ".mov",
  ".glb",
  ".gltf",
  ".bin",
  ".lock",
]);

function listTrackedFiles() {
  const output = execFileSync("git", ["ls-files"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return output.split("\n").filter((line) => line.trim().length > 0);
}

function shouldSkip(filePath) {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = filePath.slice(lastDot).toLowerCase();
  return SKIP_EXTENSIONS.has(ext);
}

/**
 * Guesses whether a buffer holds binary content by checking for a NUL byte
 * in the first slice, the same heuristic tools like `grep -I` use. Checking
 * raw bytes (rather than the UTF-8-decoded string) avoids false positives on
 * source files that legitimately contain the Unicode replacement character
 * as a string literal, such as this script itself.
 */
function looksBinary(buffer) {
  const sniffLength = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sniffLength; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function findEmDashHits(filePath) {
  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    // Unreadable (e.g. deleted) files are skipped rather than crashing the
    // whole check.
    return [];
  }

  if (looksBinary(buffer)) {
    return [];
  }

  const contents = buffer.toString("utf8");
  const hits = [];
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== undefined && line.includes(EM_DASH)) {
      hits.push({ line: i + 1, text: line.trim() });
    }
  }
  return hits;
}

function main() {
  const files = listTrackedFiles().filter((f) => !shouldSkip(f));

  const violations = [];
  for (const file of files) {
    const hits = findEmDashHits(file);
    for (const hit of hits) {
      violations.push(`${file}:${hit.line}: ${hit.text}`);
    }
  }

  if (violations.length > 0) {
    console.error("Em dash character (U+2014) found in tracked files:\n");
    for (const violation of violations) {
      console.error(`  ${violation}`);
    }
    console.error(
      `\n${violations.length} violation(s) found. Replace the em dash with a hyphen or restructure the sentence.`,
    );
    process.exit(1);
  }

  console.log("No em dash characters found in tracked files.");
  process.exit(0);
}

main();
