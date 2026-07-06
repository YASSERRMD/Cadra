import { createProject, type Project } from "@cadra/core";
import {
  CURRENT_SCHEMA_VERSION,
  parseScene,
  type SceneDocument,
  type SceneParseResult,
} from "@cadra/schema";

import { CompositionBuilder, type CompositionBuilderProps } from "./composition-builder.js";
import { SceneBuildError } from "./errors.js";

/**
 * Fluent, strongly typed entry point for constructing a Cadra scene document
 * without hand-writing JSON: `scene({...}).composition({...}).add(...).build()`,
 * repeating `.composition({...})` (on the original `scene(...)` result, or by
 * calling `.build()` and starting a fresh `scene(...)` for a separate
 * project) for as many compositions as the project needs.
 *
 * Every `.composition()` call both registers a new `CompositionBuilder` on
 * this project and returns that `CompositionBuilder`, so a caller chains
 * directly off it to populate that one composition
 * (`scene({...}).composition({...}).add(Text({...}).at(0, 30)).build()`).
 * `.build()` is reachable from either the original `SceneBuilder` or any
 * `CompositionBuilder` it produced (see `CompositionBuilder.build()`): both
 * assemble and validate *every* composition added so far, not just the most
 * recently started one.
 */
export class SceneBuilder {
  private readonly id: string;
  private readonly name: string;
  private readonly compositionBuilders: CompositionBuilder[] = [];

  constructor(props: SceneBuilderProps) {
    this.id = props.id;
    this.name = props.name;
  }

  /**
   * Starts a new `Composition` within this project and returns its
   * `CompositionBuilder`, so a caller can chain straight into populating it
   * (`.add(...)`, `.track(...)`, ...) and, from there, straight into
   * `.build()` too.
   */
  composition(props: CompositionBuilderProps): CompositionBuilder {
    const builder = new CompositionBuilder(props, () => this.build());
    this.compositionBuilders.push(builder);
    return builder;
  }

  /**
   * Assembles every composition added so far into a `Project`, wraps it in
   * the `{ schemaVersion, project }` envelope `@cadra/schema`'s
   * `sceneDocumentSchema` defines, and validates the result through
   * `parseScene` before returning it.
   *
   * Throws `SceneBuildError` (carrying `parseScene`'s full
   * `SceneParseDiagnostic[]`) if validation fails, so a caller (human or
   * agent) gets back precisely which field of the assembled document was
   * invalid and why, rather than a generic thrown string. On success,
   * returns the fully-typed, validated `SceneDocument` `parseScene` itself
   * produced (not just the pre-validation input), so a caller never holds a
   * document this builder merely *believes* is valid.
   */
  build(): SceneDocument {
    const project: Project = createProject({
      id: this.id,
      name: this.name,
      compositions: this.compositionBuilders.map((builder) => builder.toComposition()),
    });

    const input = { schemaVersion: CURRENT_SCHEMA_VERSION, project };
    const result: SceneParseResult = parseScene(input);

    if (!result.success) {
      throw new SceneBuildError(result.diagnostics);
    }

    return result.document;
  }
}

/** Props `scene()` takes to start a new `SceneBuilder`. */
export interface SceneBuilderProps {
  id: string;
  name: string;
}

/**
 * Starts a new fluent scene builder: `scene({ id, name }).composition({...}).add(...)`.
 *
 * See the module doc on `SceneBuilder` for the full chaining shape, and
 * `./index.ts` for complete authoring examples.
 */
export function scene(props: SceneBuilderProps): SceneBuilder {
  return new SceneBuilder(props);
}
