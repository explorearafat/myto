import type { ChatMessage, CompletionOptions } from '../../shared/types'
import type { Provider } from './provider'

/**
 * Collects a whole completion over the **streaming** transport.
 *
 * This is how both concrete providers implement {@link Provider.getCompletion},
 * and the reason is a non-obvious property of `fetch`: it resolves at the
 * response *headers*. A `stream: false` request therefore gives us no way to
 * tell "still generating" from "dead", which makes its header deadline a hard
 * ceiling on total generation time. Every internal model call — the planner, the
 * complexity router, the intent classifier, the audit/spec/phase-plan scribe,
 * the reviewer, the memory summariser, the chat auto-titler — went through that
 * path, so a 26-section phase plan at high reasoning effort ran straight into
 * it. Worse, the resulting failure *looks* like a timeout, so the retry loop
 * replayed the identical request against the identical ceiling and failed the
 * same way: minutes of waiting for an error that was never going to clear.
 *
 * Streaming inverts it. Headers arrive in a second and the deadline becomes a
 * *no-progress* one (see `stallGuard` in `./http`), so a call is cut off only
 * when it actually goes silent — the generation itself may take as long as it
 * takes. Callers see no difference: they still get one string.
 *
 * Replaying is safe for these callers precisely because nothing is shown while
 * it happens — the accumulator is local and starts empty on every attempt, so a
 * retry can never duplicate half an answer the way a user-visible stream would.
 */
export async function collectCompletion(
  provider: Provider,
  modelId: string,
  messages: ChatMessage[],
  options?: CompletionOptions,
  signal?: AbortSignal,
  onProgress?: (text: string) => void
): Promise<string> {
  let text = ''
  await provider.streamCompletion(
    modelId,
    messages,
    (chunk) => {
      if (!chunk.delta) return
      text += chunk.delta
      // Proof of life for the caller's status row. These documents are collected,
      // never shown, so without this hook a five-minute authoring call at high
      // reasoning effort is indistinguishable from a hung request.
      onProgress?.(text)
    },
    signal,
    options
  )
  return text
}
