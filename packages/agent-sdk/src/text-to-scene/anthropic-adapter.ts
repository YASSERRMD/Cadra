import type { LlmCompletionFn } from "./llm-completion.js";

/**
 * The `@anthropic-ai/sdk`-backed real implementation of {@link LlmCompletionFn}:
 * this is the *only* module in this package's text-to-scene support that
 * imports `@anthropic-ai/sdk` at all, and the *only* place `@anthropic-ai/sdk`
 * is ever constructed or called. Every other module (`create-text-to-scene-
 * adapter.ts`, `prompt-building.ts`, `json-extraction.ts`) is written purely
 * against the vendor-neutral `LlmCompletionFn` seam and has no knowledge this
 * module, or Anthropic, exists at all.
 *
 * Used only as the *default* `completionFn` when a caller constructs a
 * `TextToScene` adapter (`createTextToSceneAdapter`) without injecting one of
 * their own; see that module's `resolveDefaultCompletionFn`, which imports
 * this module lazily (a dynamic `import()`), specifically so that
 * constructing an `Anthropic` client (which reads
 * `process.env.ANTHROPIC_API_KEY` the moment it is instantiated, per this
 * SDK's own documented constructor behavior) never happens for a caller that
 * always injects its own `completionFn`, which every test in this package's
 * suite does. No test in this repository ever imports this module.
 *
 * Deliberately does not use this SDK's forced-structured-output or
 * tool-calling mode for the completion: this function's whole contract is
 * "send free text in, get free text back", with the JSON-shaped-ness of that
 * text left entirely to the prompt's own instructions (see
 * `./prompt-building.ts`) and validated downstream by `parseScene`, not by
 * the vendor's API surface. See `create-text-to-scene-adapter.ts`'s module
 * doc for why this is a deliberate design choice for this phase, not an
 * oversight.
 */

/** Options accepted by {@link createAnthropicLlmCompletionFn}. */
export interface AnthropicLlmCompletionOptions {
  /**
   * API key to construct the `Anthropic` client with. Defaults to
   * `undefined`, in which case the SDK's own constructor falls back to
   * `process.env.ANTHROPIC_API_KEY` (the SDK's own documented default
   * behavior; see `@anthropic-ai/sdk`'s `client.d.ts`). The
   * `generate_scene_from_text` MCP tool passes this explicitly, sourced from
   * `CadraMcpServerConfig.providerKeys.anthropic` (see
   * `@cadra/mcp-server`'s `text-to-scene-tools.ts`), rather than relying on
   * this fallback, so the server's own typed provider-key configuration
   * remains the single source of truth for which key is used.
   */
  apiKey?: string;
  /**
   * Model id to request. Defaults to {@link DEFAULT_ANTHROPIC_MODEL}. Kept
   * overridable so a caller can pin a specific model/version without this
   * package needing a new release to track a newer default.
   */
  model?: string;
  /** `max_tokens` passed to every completion request. Defaults to {@link DEFAULT_MAX_TOKENS}, generous enough for a realistic multi-node scene document. */
  maxTokens?: number;
}

/**
 * Default model id requested by {@link createAnthropicLlmCompletionFn}. A
 * capable, current, generally-available model well-suited to a
 * structured-JSON-generation task; overridable via
 * `AnthropicLlmCompletionOptions.model`.
 */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";

/** Default `max_tokens` for every completion request; see {@link AnthropicLlmCompletionOptions.maxTokens}. */
export const DEFAULT_MAX_TOKENS = 8192;

/**
 * Constructs the real, `@anthropic-ai/sdk`-backed default {@link LlmCompletionFn}.
 *
 * Constructing the returned function does not itself make a network call or
 * even construct the underlying `Anthropic` client; the client is created
 * once, lazily, the first time the returned function is actually invoked
 * (and reused for every subsequent call from that same returned function),
 * so simply calling this factory (e.g. while wiring up default options) never
 * requires a valid API key to be present.
 *
 * Every call sends `prompt` as a single `user`-role message with no system
 * prompt and no conversation history (each retry attempt in
 * `create-text-to-scene-adapter.ts` builds one complete, self-contained
 * prompt string of its own; see that module's doc), and returns the
 * concatenation of every `text`-type content block in the response (in
 * practice always exactly one for a plain text completion with no tool use
 * configured, but concatenating every block is more robust than assuming
 * that shape unconditionally).
 */
export function createAnthropicLlmCompletionFn(options: AnthropicLlmCompletionOptions = {}): LlmCompletionFn {
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  let clientPromise: Promise<import("@anthropic-ai/sdk").default> | undefined;

  async function getClient(): Promise<import("@anthropic-ai/sdk").default> {
    if (clientPromise === undefined) {
      clientPromise = import("@anthropic-ai/sdk").then(({ default: Anthropic }) => {
        return new Anthropic(options.apiKey !== undefined ? { apiKey: options.apiKey } : {});
      });
    }
    return clientPromise;
  }

  return async (prompt: string): Promise<string> => {
    const client = await getClient();

    const message = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    return message.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
  };
}
