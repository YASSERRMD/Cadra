/**
 * The single seam every text-to-scene adapter in this package is written
 * against: a vendor-neutral, free-text-in/free-text-out completion
 * function.
 *
 * Deliberately not tied to any one vendor's message/tool-call/streaming
 * shape (no `role`/`content` blocks, no tool-use, no system-prompt-as-a-
 * separate-parameter): `prompt` is the *entire* input the model sees (this
 * package's own prompt builder, see `./prompt-building.ts`, is responsible
 * for folding the Cadra contract, examples, brief, constraints, and any
 * prior-attempt diagnostics into that one string), and the resolved string is
 * the *entire* raw response, with no structure assumed beyond "some text that
 * hopefully contains JSON somewhere in it" (see `./json-extraction.ts`).
 *
 * This mirrors the same injectable-seam pattern already used throughout this
 * codebase for every other real external dependency (`BrowserLauncher` in
 * `@cadra/headless`, `VideoEncoderConstructor` in `@cadra/encode`): a real
 * implementation is provided as a default (`./anthropic-adapter.ts`, backed
 * by `@anthropic-ai/sdk`), but every consumer in this module
 * (`createTextToSceneAdapter` in `./create-text-to-scene-adapter.ts`) takes
 * one of these as a plain injectable function, with zero knowledge of, or
 * dependency on, which vendor (or whether a real vendor at all) is behind it.
 * A test suite for this phase never needs to import `@anthropic-ai/sdk` at
 * all; it just supplies a fake `LlmCompletionFn`.
 */
export type LlmCompletionFn = (prompt: string) => Promise<string>;
