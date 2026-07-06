import { describe, expect, it, vi } from "vitest";

import { createLogger, type LogEntry } from "./logger.js";

/** Parses every line written to a captured sink as a {@link LogEntry}. */
function parseLines(lines: string[]): LogEntry[] {
  return lines.map((line) => JSON.parse(line) as LogEntry);
}

describe("createLogger", () => {
  it("never writes to the sink via process.stdout.write", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const logger = createLogger("test-component");
      logger.info("hello");
      logger.error("boom");
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("defaults to writing through process.stderr.write when no sink is given", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const logger = createLogger("test-component");
      logger.info("hello");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const [line] = stderrSpy.mock.calls[0] ?? [];
      expect(typeof line).toBe("string");
      expect((line as string).endsWith("\n")).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("emits one JSON line per call, tagged with the given component", () => {
    const lines: string[] = [];
    const logger = createLogger("my-component", {}, (line) => lines.push(line));

    logger.info("first message");
    logger.error("second message");

    const entries = parseLines(lines);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      level: "info",
      component: "my-component",
      message: "first message",
    });
    expect(entries[1]).toMatchObject({
      level: "error",
      component: "my-component",
      message: "second message",
    });
  });

  it("supports all four log levels", () => {
    const lines: string[] = [];
    const logger = createLogger("levels", {}, (line) => lines.push(line));

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    const entries = parseLines(lines);
    expect(entries.map((entry) => entry.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  it("includes an ISO-8601 timestamp on every entry", () => {
    const lines: string[] = [];
    const logger = createLogger("timestamped", {}, (line) => lines.push(line));
    logger.info("hi");

    const [entry] = parseLines(lines);
    expect(entry).toBeDefined();
    expect(new Date(entry!.timestamp).toISOString()).toBe(entry!.timestamp);
  });

  it("omits the fields property entirely when no fields are ever supplied", () => {
    const lines: string[] = [];
    const logger = createLogger("no-fields", {}, (line) => lines.push(line));
    logger.info("hi");

    const [entry] = parseLines(lines);
    expect(entry).not.toHaveProperty("fields");
  });

  it("merges per-call fields into the emitted entry", () => {
    const lines: string[] = [];
    const logger = createLogger("with-fields", {}, (line) => lines.push(line));
    logger.info("hi", { requestId: "abc123" });

    const [entry] = parseLines(lines);
    expect(entry?.fields).toEqual({ requestId: "abc123" });
  });

  it("child() scopes to a new component and merges base fields ahead of per-call fields", () => {
    const lines: string[] = [];
    const root = createLogger("root", { rootField: "root-value" }, (line) => lines.push(line));
    const child = root.child("child-component", { childField: "child-value" });

    child.warn("child message", { callField: "call-value" });

    const [entry] = parseLines(lines);
    expect(entry).toMatchObject({
      component: "child-component",
      message: "child message",
      fields: {
        rootField: "root-value",
        childField: "child-value",
        callField: "call-value",
      },
    });
  });

  it("lets a per-call field override a base field of the same name", () => {
    const lines: string[] = [];
    const logger = createLogger("override", { key: "base" }, (line) => lines.push(line));
    logger.info("hi", { key: "override" });

    const [entry] = parseLines(lines);
    expect(entry?.fields).toEqual({ key: "override" });
  });
});
