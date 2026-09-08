/**
 * What the meter is allowed to claim about a model's context window.
 *
 * Sylor talks to whatever a gateway or a local Ollama exposes, so for most model
 * ids the real window is genuinely not knowable here — and a meter that invents a
 * denominator would draw a confident percentage out of a guess. So this table is
 * deliberately small and conservative: it holds only families whose documented
 * window is stable, matched by prefix, and everything else returns `undefined`,
 * which the UI renders as "unknown" rather than as a number.
 *
 * The window is only ever a SECONDARY reading. The limit that actually applies to
 * a Sylor run is its own fold threshold (`MAX_CONTEXT_CHARS`), because that is
 * where the engine condenses the conversation — regardless of how much room the
 * model would still have had.
 */

/** Characters per token, matching the estimate used across the app. */
export const CHARS_PER_TOKEN = 4

/**
 * Prefix matchers, first hit wins. Anthropic's published window has been 200k for
 * every Claude generation (the 1M beta is opt-in and NOT assumed here); the OpenAI
 * and Gemini entries are the documented figures for those families.
 */
const KNOWN_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^claude[-.]/i, 200_000],
  [/^(o3|o4)[-.]?/i, 200_000],
  [/^gpt-4\.1/i, 1_047_576],
  [/^gpt-4o/i, 128_000],
  [/^gemini-2/i, 1_048_576]
]

/**
 * The model's context window in tokens, or `undefined` when Sylor does not know it.
 * A provider prefix (`anthropic/claude-…`, `openai/gpt-4o`) is stripped first, since
 * gateways name the same model both ways.
 */
export function contextWindowFor(modelId: string): number | undefined {
  const bare = modelId.includes('/') ? modelId.slice(modelId.lastIndexOf('/') + 1) : modelId
  for (const [pattern, tokens] of KNOWN_WINDOWS) if (pattern.test(bare)) return tokens
  return undefined
}
