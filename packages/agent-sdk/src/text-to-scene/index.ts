/**
 * Phase 32: provider-agnostic text-to-scene generation.
 *
 * `TextToScene` (`./text-to-scene.ts`) is the interface: turn a
 * natural-language brief (plus optional hard constraints on duration/fps/
 * size) into a validated `SceneDocument`, or a `{ success: false,
 * diagnostics }` failure mirroring every other write tool in this codebase.
 *
 * `createTextToSceneAdapter` (`./create-text-to-scene-adapter.ts`) is the
 * reference implementation: a self-correcting retry loop built purely
 * against the vendor-neutral `LlmCompletionFn` seam (`./llm-completion.ts`),
 * defaulting to a real `@anthropic-ai/sdk`-backed completion function
 * (`./anthropic-adapter.ts`) only when no `completionFn` is injected. See
 * `create-text-to-scene-adapter.ts`'s own module doc for the exact
 * attempt/prompt/repair sequence.
 */
export {
  type AnthropicLlmCompletionOptions,
  createAnthropicLlmCompletionFn,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_MAX_TOKENS,
} from "./anthropic-adapter.js";
export {
  createTextToSceneAdapter,
  type CreateTextToSceneAdapterOptions,
  DEFAULT_MAX_ATTEMPTS,
} from "./create-text-to-scene-adapter.js";
export type { JsonExtractionFailure, JsonExtractionResult, JsonExtractionSuccess } from "./json-extraction.js";
export { extractJsonFromLlmResponse } from "./json-extraction.js";
export type { LlmCompletionFn } from "./llm-completion.js";
export type { PriorAttempt } from "./prompt-building.js";
export { buildTextToScenePrompt } from "./prompt-building.js";
export type {
  TextToScene,
  TextToSceneConstraints,
  TextToSceneFailure,
  TextToSceneRequest,
  TextToSceneResult,
  TextToSceneSuccess,
} from "./text-to-scene.js";
