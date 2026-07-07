import { describe, expect, it } from "vitest";

import { extractJsonFromLlmResponse } from "./json-extraction.js";

describe("extractJsonFromLlmResponse", () => {
  it("parses a raw response that is nothing but JSON", () => {
    const result = extractJsonFromLlmResponse('{"a": 1, "b": [2, 3]}');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual({ a: 1, b: [2, 3] });
      expect(result.leftoverText).toBeUndefined();
    }
  });

  it("tolerates surrounding whitespace with no leftover text", () => {
    const result = extractJsonFromLlmResponse('  \n  {"a": 1}  \n  ');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual({ a: 1 });
      expect(result.leftoverText).toBeUndefined();
    }
  });

  it("extracts JSON from a ```json fenced code block", () => {
    const result = extractJsonFromLlmResponse('```json\n{"a": 1}\n```');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it("extracts JSON from a bare ``` fenced code block with no language tag", () => {
    const result = extractJsonFromLlmResponse('```\n{"a": 1}\n```');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it("is case-insensitive on the fence's language tag", () => {
    const result = extractJsonFromLlmResponse('```JSON\n{"a": 1}\n```');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it("captures prose before a fenced block as leftover text (a rationale)", () => {
    const result = extractJsonFromLlmResponse('I chose a fade-in because it feels calm.\n\n```json\n{"a": 1}\n```');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual({ a: 1 });
      expect(result.leftoverText).toContain("I chose a fade-in");
    }
  });

  it("captures prose after a fenced block as leftover text too", () => {
    const result = extractJsonFromLlmResponse('```json\n{"a": 1}\n```\n\nLet me know if you want changes.');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual({ a: 1 });
      expect(result.leftoverText).toContain("Let me know if you want changes.");
    }
  });

  it("extracts the outermost bracketed span from unfenced prose with JSON inline", () => {
    const result = extractJsonFromLlmResponse('Here is the scene:\n\n{"a": 1}\n\nHope that helps!');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual({ a: 1 });
      expect(result.leftoverText).toContain("Here is the scene");
      expect(result.leftoverText).toContain("Hope that helps!");
    }
  });

  it("extracts a top-level JSON array (not just objects)", () => {
    const result = extractJsonFromLlmResponse("[1, 2, 3]");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual([1, 2, 3]);
    }
  });

  it("fails with a reason on an empty response", () => {
    const result = extractJsonFromLlmResponse("   ");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("fails with a reason when the response is prose with no JSON at all", () => {
    const result = extractJsonFromLlmResponse("I'm not sure what scene you want, could you clarify?");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("fails when the fenced block's contents are malformed JSON and no other valid JSON is found", () => {
    const result = extractJsonFromLlmResponse('```json\n{"a": 1,,,}\n```');
    expect(result.success).toBe(false);
  });

  it("fails on truncated/unterminated JSON", () => {
    const result = extractJsonFromLlmResponse('{"a": 1, "b": [2, 3');
    expect(result.success).toBe(false);
  });
});
