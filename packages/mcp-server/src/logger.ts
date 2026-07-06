/**
 * Structured logging for the Cadra MCP server.
 *
 * Critical protocol constraint: when this server runs over the stdio
 * transport, `stdout` carries nothing but newline-delimited JSON-RPC frames
 * (see `StdioServerTransport`, which reads/writes `process.stdin`/
 * `process.stdout` directly). Any log line this server emits while a stdio
 * transport is attached must not touch `stdout`, or it interleaves with (and
 * corrupts) the protocol stream for every connected client.
 *
 * Rather than making that a "default" a caller could override, this logger
 * writes exclusively to `stderr` unconditionally, for every transport, not
 * only stdio: the HTTP transport has no such constraint, but there is no
 * benefit to a different code path there, and keeping a single unconditional
 * destination removes an entire class of "it logged to stdout because this
 * one call site forgot which transport is active" bugs.
 */

/** Severity for a single log entry, ordered least to most severe. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured metadata attached to a log entry; kept as a plain JSON-serializable record. */
export type LogFields = Record<string, unknown>;

/** A single structured log entry, as written to `stderr`. */
export interface LogEntry {
  /** ISO-8601 timestamp of when the entry was created. */
  timestamp: string;
  /** Severity of this entry. */
  level: LogLevel;
  /** Which component/module emitted this entry, e.g. `"stdio-transport"` or `"http-transport"`. */
  component: string;
  /** Human-readable message. */
  message: string;
  /** Optional structured metadata, merged into the emitted JSON line. */
  fields?: LogFields;
}

/** A destination log entries are written to; a plain function so tests can capture output without touching the real `process.stderr`. */
export type LogSink = (line: string) => void;

/** The logger surface used throughout this package: one method per {@link LogLevel}, plus `child` for a fixed component/field scope. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a new `Logger` that always logs under `component`, merging `baseFields` into every entry ahead of any per-call `fields`. */
  child(component: string, baseFields?: LogFields): Logger;
}

/** Default sink: writes one line to `process.stderr`, never `process.stdout`. */
function stderrSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

function serializeEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}

/**
 * Creates a {@link Logger} rooted at `component`. All entries are serialized
 * as single-line JSON and written through `sink` (defaulting to `stderr`).
 *
 * `sink` is intentionally a plain callback rather than always being
 * `process.stderr` directly: it lets tests assert on emitted log lines
 * without capturing real file-descriptor output, while production code
 * simply omits the parameter and gets the `stderr`-only default.
 */
export function createLogger(
  component: string,
  baseFields: LogFields = {},
  sink: LogSink = stderrSink,
): Logger {
  function log(level: LogLevel, message: string, fields?: LogFields): void {
    const mergedFields =
      fields === undefined && Object.keys(baseFields).length === 0
        ? undefined
        : { ...baseFields, ...fields };

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...(mergedFields !== undefined ? { fields: mergedFields } : {}),
    };
    sink(serializeEntry(entry));
  }

  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
    child: (childComponent, childBaseFields) =>
      createLogger(childComponent, { ...baseFields, ...childBaseFields }, sink),
  };
}
