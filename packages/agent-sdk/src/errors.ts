import type { SceneParseDiagnostic } from "@cadra/schema";

/**
 * Thrown by `SceneBuilder.build()` when the assembled document fails
 * `@cadra/schema`'s `parseScene` validation.
 *
 * Carries the exact `SceneParseDiagnostic[]` `parseScene` returned, each
 * `{ path, message }` naming precisely which field of the built document was
 * invalid and why, rather than forcing a caller (human or agent) to re-derive
 * that detail from a generic thrown string. An agent catching this error can
 * read `error.diagnostics` directly and correct its next build attempt field
 * by field.
 */
export class SceneBuildError extends Error {
  /** Every diagnostic `parseScene` reported for the document that failed to build. */
  readonly diagnostics: SceneParseDiagnostic[];

  constructor(diagnostics: SceneParseDiagnostic[]) {
    super(SceneBuildError.formatMessage(diagnostics));
    this.name = "SceneBuildError";
    this.diagnostics = diagnostics;
  }

  /**
   * Renders every diagnostic as a `path: message` line, joined so
   * `error.message` alone (e.g. in a log line or a top-level catch that only
   * prints `error.message`) already names every offending field, even
   * without a caller reaching into `error.diagnostics` explicitly.
   */
  private static formatMessage(diagnostics: SceneParseDiagnostic[]): string {
    const lines = diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`);
    return (
      `Scene builder produced an invalid document (${diagnostics.length} ` +
      `${diagnostics.length === 1 ? "problem" : "problems"}):\n${lines.join("\n")}`
    );
  }
}

/**
 * Thrown by builder methods that catch a structurally impossible request
 * before a document is even assembled (e.g. a negative or non-integer frame
 * range passed to `.at()`), so the caller gets an immediate, specific error
 * at the exact call site rather than a deferred, harder-to-localize
 * `SceneBuildError` out of `.build()`.
 *
 * Distinct from `SceneBuildError`: this fires eagerly, mid-chain, before a
 * document exists to validate; `SceneBuildError` fires only from `.build()`,
 * against a fully assembled document.
 */
export class SceneBuilderUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneBuilderUsageError";
  }
}
