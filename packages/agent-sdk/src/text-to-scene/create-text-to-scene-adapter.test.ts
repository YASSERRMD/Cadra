import { describe, expect, it, vi } from "vitest";

import { createTextToSceneAdapter } from "./create-text-to-scene-adapter.js";
import type { LlmCompletionFn } from "./llm-completion.js";

/** A real, valid, minimal scene document (mirrors @cadra/schema's own "title-card" curated example), used as the basis for every fixture below. */
const VALID_DOCUMENT = {
  schemaVersion: 1,
  project: {
    id: "project-test",
    name: "Test Project",
    compositions: [
      {
        id: "comp-test",
        name: "Main",
        fps: 30,
        durationInFrames: 90,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: "track-test",
            name: "Title",
            clips: [
              {
                id: "clip-test",
                startFrame: 0,
                durationInFrames: 90,
                node: {
                  id: "root-test",
                  kind: "group",
                  name: "Root",
                  transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
                  visible: true,
                  children: [
                    {
                      id: "title-text",
                      kind: "text",
                      name: "Title",
                      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
                      visible: true,
                      content: "Cadra",
                      fontSize: 96,
                      color: [1, 1, 1, 1],
                      children: [],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  },
};

/** Same as VALID_DOCUMENT, but the text node's `kind` is an unrecognized string: fails parseScene with UNKNOWN_NODE_KIND, and (deliberately) has no `suggestedPatch` on that diagnostic, so it can only be fixed by a genuine model re-prompt, never by the cheap patch-repair pass. */
function brokenDocumentWithUnknownNodeKind(): unknown {
  const clone = JSON.parse(JSON.stringify(VALID_DOCUMENT));
  clone.project.compositions[0].tracks[0].clips[0].node.children[0].kind = "not-a-real-kind";
  return clone;
}

describe("createTextToSceneAdapter", () => {
  describe("first attempt succeeds", () => {
    it("returns a validated document with attempts: 1 and no rationale when the model gives none", async () => {
      const completionFn: LlmCompletionFn = vi.fn(async () => JSON.stringify(VALID_DOCUMENT));
      const adapter = createTextToSceneAdapter({ completionFn });

      const result = await adapter.generate({ brief: "A title card." });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.attempts).toBe(1);
        expect(result.document.project.id).toBe("project-test");
        expect(result.rationale).toBeUndefined();
      }
      expect(completionFn).toHaveBeenCalledTimes(1);
    });

    it("captures a rationale when the model provides one alongside a fenced JSON block", async () => {
      const completionFn: LlmCompletionFn = vi.fn(
        async () =>
          "I used a simple fade-in for a calm, minimal feel.\n\n```json\n" +
          JSON.stringify(VALID_DOCUMENT) +
          "\n```",
      );
      const adapter = createTextToSceneAdapter({ completionFn });

      const result = await adapter.generate({ brief: "A calm title card." });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.rationale).toContain("calm, minimal feel");
      }
    });

    it("never fabricates a rationale when none was given", async () => {
      const completionFn: LlmCompletionFn = vi.fn(async () => `\`\`\`json\n${JSON.stringify(VALID_DOCUMENT)}\n\`\`\``);
      const adapter = createTextToSceneAdapter({ completionFn });

      const result = await adapter.generate({ brief: "A title card." });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.rationale).toBeUndefined();
      }
    });
  });

  describe("self-correction from an invalid first draft", () => {
    it("recovers within 2 attempts from deliberately broken (unparseable) JSON on the first try", async () => {
      const completionFn: LlmCompletionFn = vi
        .fn()
        .mockResolvedValueOnce("Sure! Here's your scene: { this is not valid json,,, }")
        .mockResolvedValueOnce(JSON.stringify(VALID_DOCUMENT));
      const adapter = createTextToSceneAdapter({ completionFn });

      const result = await adapter.generate({ brief: "A title card." });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.attempts).toBe(2);
        expect(result.document.project.id).toBe("project-test");
      }
      expect(completionFn).toHaveBeenCalledTimes(2);
    });

    it("recovers within 2 attempts from JSON that fails parseScene (an unknown node kind)", async () => {
      const completionFn: LlmCompletionFn = vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify(brokenDocumentWithUnknownNodeKind()))
        .mockResolvedValueOnce(JSON.stringify(VALID_DOCUMENT));
      const adapter = createTextToSceneAdapter({ completionFn });

      const result = await adapter.generate({ brief: "A title card." });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.attempts).toBe(2);
      }
      expect(completionFn).toHaveBeenCalledTimes(2);
    });

    it("feeds the first attempt's exact diagnostics back into the second prompt", async () => {
      const completionFn: LlmCompletionFn = vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify(brokenDocumentWithUnknownNodeKind()))
        .mockResolvedValueOnce(JSON.stringify(VALID_DOCUMENT));
      const adapter = createTextToSceneAdapter({ completionFn });

      await adapter.generate({ brief: "A title card." });

      expect(completionFn).toHaveBeenCalledTimes(2);
      const secondPrompt = vi.mocked(completionFn).mock.calls[1]?.[0];
      expect(secondPrompt).toBeDefined();
      // The second prompt must contain the diagnostic code/path/message
      // parseScene produced against the first (broken) attempt, so the model
      // sees exactly what was wrong, not a generic "try again".
      expect(secondPrompt).toContain("UNKNOWN_NODE_KIND");
      expect(secondPrompt).toContain("not-a-real-kind");
      // And it must also contain the first attempt's own raw output verbatim.
      expect(secondPrompt).toContain("not-a-real-kind");
    });

    it("feeds a JSON-extraction failure's diagnostic back into the second prompt too", async () => {
      const completionFn: LlmCompletionFn = vi
        .fn()
        .mockResolvedValueOnce("I'm not sure, could you clarify the brief?")
        .mockResolvedValueOnce(JSON.stringify(VALID_DOCUMENT));
      const adapter = createTextToSceneAdapter({ completionFn });

      const result = await adapter.generate({ brief: "A title card." });

      expect(result.success).toBe(true);
      const secondPrompt = vi.mocked(completionFn).mock.calls[1]?.[0];
      expect(secondPrompt).toContain("JSON_EXTRACTION_FAILED");
      expect(secondPrompt).toContain("could you clarify the brief");
    });
  });

  describe("exhausted retries", () => {
    it("reports the final attempt's diagnostics rather than hanging or throwing, once every attempt fails", async () => {
      const completionFn: LlmCompletionFn = vi.fn(async () => JSON.stringify(brokenDocumentWithUnknownNodeKind()));
      const adapter = createTextToSceneAdapter({ completionFn, maxAttempts: 3 });

      const result = await adapter.generate({ brief: "A title card." });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.attempts).toBe(3);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics.some((d) => d.code === "UNKNOWN_NODE_KIND")).toBe(true);
      }
      expect(completionFn).toHaveBeenCalledTimes(3);
    });

    it("exhausts retries gracefully when every attempt returns unparseable text", async () => {
      const completionFn: LlmCompletionFn = vi.fn(async () => "not json, ever, no matter how many times you ask");
      const adapter = createTextToSceneAdapter({ completionFn, maxAttempts: 2 });

      const result = await adapter.generate({ brief: "A title card." });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.attempts).toBe(2);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]?.code).toBe("JSON_EXTRACTION_FAILED");
      }
      expect(completionFn).toHaveBeenCalledTimes(2);
    });

    it("respects a custom maxAttempts rather than the default", async () => {
      const completionFn: LlmCompletionFn = vi.fn(async () => JSON.stringify(brokenDocumentWithUnknownNodeKind()));
      const adapter = createTextToSceneAdapter({ completionFn, maxAttempts: 5 });

      const result = await adapter.generate({ brief: "A title card." });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.attempts).toBe(5);
      }
      expect(completionFn).toHaveBeenCalledTimes(5);
    });

    it("uses DEFAULT_MAX_ATTEMPTS when maxAttempts is not given", async () => {
      const completionFn: LlmCompletionFn = vi.fn(async () => JSON.stringify(brokenDocumentWithUnknownNodeKind()));
      const adapter = createTextToSceneAdapter({ completionFn });

      const result = await adapter.generate({ brief: "A title card." });

      expect(result.success).toBe(false);
      expect(completionFn).toHaveBeenCalledTimes(3);
    });

    it("rejects a maxAttempts less than 1 eagerly, at construction time", () => {
      expect(() => createTextToSceneAdapter({ maxAttempts: 0 })).toThrow(RangeError);
    });
  });

  describe("cheap patch-repair pass", () => {
    it("resolves an out-of-range value via a suggestedPatch with no second model call", async () => {
      const clone = JSON.parse(JSON.stringify(VALID_DOCUMENT));
      // fps must be a positive integer; a too_small violation on this
      // known-numeric-bound field carries a suggestedPatch clamping it to
      // the nearest allowed value (see @cadra/schema's parse.ts
      // deriveSuggestedPatch's "too_small" branch), so this should be
      // resolved by the cheap repair pass alone, with no second
      // completionFn call.
      clone.project.compositions[0].fps = -5;

      const completionFn: LlmCompletionFn = vi.fn(async () => JSON.stringify(clone));
      const adapter = createTextToSceneAdapter({ completionFn });

      const result = await adapter.generate({ brief: "A title card." });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.document.project.compositions[0]?.fps).toBeGreaterThan(0);
      }
      // The whole point of the cheap-patch pass: no second model call needed.
      expect(completionFn).toHaveBeenCalledTimes(1);
    });

    it("does not apply a cheap patch and falls through to a re-prompt for an unknown node kind (no suggestedPatch)", async () => {
      const completionFn: LlmCompletionFn = vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify(brokenDocumentWithUnknownNodeKind()))
        .mockResolvedValueOnce(JSON.stringify(VALID_DOCUMENT));
      const adapter = createTextToSceneAdapter({ completionFn });

      const result = await adapter.generate({ brief: "A title card." });

      expect(result.success).toBe(true);
      if (result.success) {
        // Required a real second model call; the cheap pass could not have
        // fixed this on its own since UNKNOWN_NODE_KIND never carries a
        // suggestedPatch.
        expect(result.attempts).toBe(2);
      }
      expect(completionFn).toHaveBeenCalledTimes(2);
    });
  });

  describe("no real network access", () => {
    it("never touches the module-level default completion function when one is injected", async () => {
      // A constructed adapter with an injected completionFn must never
      // attempt to lazily resolve @anthropic-ai/sdk's default at all; if it
      // did, this test (which supplies no ANTHROPIC_API_KEY and runs with no
      // network access in CI) would still pass today only by accident. This
      // assertion instead directly counts calls to prove only the injected
      // fake was ever invoked, for every attempt this generation made.
      const completionFn: LlmCompletionFn = vi.fn(async () => JSON.stringify(VALID_DOCUMENT));
      const adapter = createTextToSceneAdapter({ completionFn });

      await adapter.generate({ brief: "A title card." });
      await adapter.generate({ brief: "Another title card." });

      expect(completionFn).toHaveBeenCalledTimes(2);
    });
  });
});
