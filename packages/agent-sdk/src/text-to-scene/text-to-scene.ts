import type { SceneDocument, SceneParseDiagnostic } from "@cadra/schema";

/**
 * Optional, deliberately small set of hard constraints a caller can pin on
 * the generated scene, on top of whatever the free-text `brief` describes.
 * Every field is optional: an agent that only has a rough idea in mind can
 * pass just a `brief` and let the model choose everything else (duration,
 * size, frame rate) itself, while a caller that already knows the exact
 * output envelope it needs (e.g. "this must be a 9:16 short under 10
 * seconds") can pin exactly those fields and leave the rest to the model.
 *
 * Kept intentionally narrow (duration, frame size, frame rate) rather than
 * trying to cover every field a `Composition` has: these three are the
 * properties most likely to be dictated by something *outside* the
 * creative brief itself (a platform's aspect-ratio requirement, a fixed ad
 * slot length, a house frame-rate standard), so they are the ones worth a
 * caller being able to pin without having to smuggle them into the prose
 * brief and hope the model honors them exactly. Every other creative
 * decision (what appears on screen, how it moves, color choices, pacing
 * within the fixed duration) is left entirely to the brief and the model's
 * own judgment.
 */
export interface TextToSceneConstraints {
  /** Exact total length the generated composition's `durationInFrames` must match, in whole frames. */
  durationInFrames?: number;
  /** Frame rate the generated composition's `fps` must match. */
  fps?: number;
  /** Exact output frame size, in pixels, the generated composition's `width`/`height` must match. */
  size?: { width: number; height: number };
}

/** Input to {@link TextToScene.generate}: a natural-language brief plus optional hard constraints. */
export interface TextToSceneRequest {
  /**
   * Free-text description of the scene to generate, e.g. "A 5-second title
   * card: our logo fades in over a dark background, then the tagline types
   * on underneath it." No fixed structure is imposed on this text; it is
   * embedded directly into the prompt sent to the underlying
   * `LlmCompletionFn`.
   */
  brief: string;
  /** Optional hard constraints the generated scene's composition must satisfy exactly; see {@link TextToSceneConstraints}'s own doc for why only these three fields are covered. */
  constraints?: TextToSceneConstraints;
}

/**
 * Successful result of {@link TextToScene.generate}: a validated
 * `SceneDocument` (the same envelope shape `parseScene` accepts and
 * `create_scene`/`update_scene` persist, not necessarily assembled via
 * `@cadra/agent-sdk`'s own fluent `SceneBuilder`, since an LLM naturally
 * emits the JSON directly rather than chaining builder calls) plus bookkeeping
 * about how the generation went.
 */
export interface TextToSceneSuccess {
  success: true;
  /** The validated scene document; already passed `@cadra/schema`'s `parseScene`. */
  document: SceneDocument;
  /**
   * A short free-text explanation of the model's choices, *if and only if*
   * the model actually provided one in its final (successful) response.
   * Never fabricated when absent: a model that replied with bare scene JSON
   * and no accompanying explanation leaves this `undefined` rather than
   * this adapter inventing a rationale on the model's behalf.
   */
  rationale?: string;
  /** How many completion attempts this generation took, counting the first attempt as 1. Always at least 1, and at most the adapter's configured attempt limit. */
  attempts: number;
}

/**
 * Failed result of {@link TextToScene.generate}: every attempt (the first
 * plus every retry) failed to produce a document that passes `parseScene`,
 * or failed even to produce parseable JSON at all. Mirrors the same
 * `{ success: false, diagnostics }` shape every write tool in
 * `@cadra/mcp-server` already returns on a validation failure (see
 * `scene-tools.ts`), so a caller (human or agent) handles this exactly like
 * any other rejected write, with no special case for "the rejection came
 * from an LLM adapter instead of a direct call".
 */
export interface TextToSceneFailure {
  success: false;
  /**
   * Diagnostics from the *final* attempt: either `parseScene`'s own
   * `SceneParseDiagnostic[]` (the candidate was valid JSON but an invalid
   * scene), or a single synthetic diagnostic describing a JSON-extraction
   * failure (the candidate was not parseable as JSON at all; see
   * `./create-text-to-scene-adapter.ts`'s `jsonExtractionFailureDiagnostic`).
   * Earlier attempts' diagnostics are not included here (each retry prompt
   * already folds the *previous* attempt's diagnostics back to the model;
   * see `./prompt-building.ts`), but the same total attempt count is
   * available on `attempts`.
   */
  diagnostics: SceneParseDiagnostic[];
  /** How many completion attempts were made before giving up. Always equal to the adapter's configured attempt limit. */
  attempts: number;
}

/** Result of {@link TextToScene.generate}: a discriminated union on `success`, mirroring `@cadra/schema`'s own `SceneParseResult` shape. */
export type TextToSceneResult = TextToSceneSuccess | TextToSceneFailure;

/**
 * Provider-agnostic interface for turning a natural-language brief into a
 * validated Cadra scene document.
 *
 * `generate` is the sole method: implementations are free to prompt any
 * underlying model any number of times (see `./create-text-to-scene-adapter.ts`
 * for the reference self-correcting implementation, built on an injectable
 * `LlmCompletionFn`), but every implementation must return either a document
 * that has already passed `@cadra/schema`'s `parseScene`, or a failure
 * carrying actionable diagnostics; this interface itself makes no assumption
 * about retries, prompting strategy, or which (if any) vendor is behind it.
 */
export interface TextToScene {
  generate(request: TextToSceneRequest): Promise<TextToSceneResult>;
}
