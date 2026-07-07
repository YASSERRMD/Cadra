import { CURRENT_SCHEMA_VERSION } from "@cadra/schema";
import { describe, expect, it } from "vitest";

import { buildTextToScenePrompt } from "./prompt-building.js";

describe("buildTextToScenePrompt", () => {
  it("embeds the caller's brief verbatim", () => {
    const prompt = buildTextToScenePrompt("A calm sunrise over mountains.", undefined);
    expect(prompt).toContain("A calm sunrise over mountains.");
  });

  it("embeds the current schema version", () => {
    const prompt = buildTextToScenePrompt("Anything.", undefined);
    expect(prompt).toContain(String(CURRENT_SCHEMA_VERSION));
  });

  it("embeds the Cadra JSON Schema (a recognizable schema keyword/field name)", () => {
    const prompt = buildTextToScenePrompt("Anything.", undefined);
    expect(prompt).toContain("schemaVersion");
    expect(prompt).toContain("durationInFrames");
  });

  it("embeds at least one curated example document's project id", () => {
    const prompt = buildTextToScenePrompt("Anything.", undefined);
    // Every curated example's project id is prefixed "project-"; see
    // @cadra/schema's examples.ts.
    expect(prompt).toMatch(/project-[a-z-]+/);
  });

  it("says nothing about constraints when none are given", () => {
    const prompt = buildTextToScenePrompt("Anything.", undefined);
    expect(prompt).not.toContain("hard constraints");
  });

  it("embeds a durationInFrames constraint when given", () => {
    const prompt = buildTextToScenePrompt("Anything.", { durationInFrames: 90 });
    expect(prompt).toContain("hard constraints");
    expect(prompt).toContain("durationInFrames MUST be exactly 90");
  });

  it("embeds an fps constraint when given", () => {
    const prompt = buildTextToScenePrompt("Anything.", { fps: 24 });
    expect(prompt).toContain("fps MUST be exactly 24");
  });

  it("embeds a size constraint when given", () => {
    const prompt = buildTextToScenePrompt("Anything.", { size: { width: 1080, height: 1920 } });
    expect(prompt).toContain("width MUST be exactly 1080");
    expect(prompt).toContain("height MUST be exactly 1920");
  });

  it("embeds every constraint together when multiple are given", () => {
    const prompt = buildTextToScenePrompt("Anything.", {
      durationInFrames: 60,
      fps: 30,
      size: { width: 1920, height: 1080 },
    });
    expect(prompt).toContain("durationInFrames MUST be exactly 60");
    expect(prompt).toContain("fps MUST be exactly 30");
    expect(prompt).toContain("width MUST be exactly 1920");
  });

  it("says nothing about a prior attempt on the first call (no priorAttempt given)", () => {
    const prompt = buildTextToScenePrompt("Anything.", undefined);
    expect(prompt).not.toContain("previous attempt");
  });

  it("embeds the prior attempt's raw output and diagnostics when given", () => {
    const prompt = buildTextToScenePrompt("Anything.", undefined, {
      rawOutput: '{"schemaVersion": 1, "project": {"kind": "not-a-real-kind"}}',
      diagnostics: [
        {
          path: "project.compositions[0].tracks[0].clips[0].node.kind",
          message: "Unrecognized node kind 'not-a-real-kind'.",
          code: "UNKNOWN_NODE_KIND",
          expected: "one of: group, mesh, camera, light, text, image, compositionRef",
          suggestedFix: "Use one of the supported kinds.",
        },
      ],
    });

    expect(prompt).toContain("previous attempt");
    expect(prompt).toContain('"kind": "not-a-real-kind"');
    expect(prompt).toContain("UNKNOWN_NODE_KIND");
    expect(prompt).toContain("project.compositions[0].tracks[0].clips[0].node.kind");
    expect(prompt).toContain("Unrecognized node kind 'not-a-real-kind'.");
    expect(prompt).toContain("one of: group, mesh, camera, light, text, image, compositionRef");
    expect(prompt).toContain("Use one of the supported kinds.");
  });

  it("instructs the model to correct exactly the flagged problems", () => {
    const prompt = buildTextToScenePrompt("Anything.", undefined, {
      rawOutput: "{}",
      diagnostics: [{ path: "project", message: "Required", code: "MISSING_REQUIRED_FIELD" }],
    });
    expect(prompt).toContain("Correct exactly these problems");
  });

  it("renders a diagnostic with only path/message/code (no expected/suggestedFix) without crashing", () => {
    const prompt = buildTextToScenePrompt("Anything.", undefined, {
      rawOutput: "not json at all",
      diagnostics: [{ path: "<root>", message: "not valid JSON", code: "JSON_EXTRACTION_FAILED" }],
    });
    expect(prompt).toContain("not valid JSON");
    expect(prompt).toContain("not json at all");
  });
});
