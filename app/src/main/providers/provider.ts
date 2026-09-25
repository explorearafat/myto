import type {
  ChatMessage,
  CompletionChunk,
  CompletionOptions,
  ListModelsResult,
  ModelInfo,
  TestConnectionResult
} from '../../shared/types'
export interface Provider {
  listModels(): Promise<ListModelsResult>
  testConnection(modelId: string): Promise<TestConnectionResult>
  /**
   * One-shot, non-streaming completion.
   *
   * `signal` is a 4th positional parameter rather than a field on
   * {@link CompletionOptions} on purpose: `CompletionOptions` crosses the IPC
   * boundary (it is structured-cloned to the renderer), and an `AbortSignal`
   * cannot be cloned. Without it a cancelled run left the HTTP request running
   * to completion in the background.
   */
  getCompletion(
    modelId: string,
    messages: ChatMessage[],
    options?: CompletionOptions,
    signal?: AbortSignal,
    /**
     * Called with the text collected SO FAR as it arrives. Optional, and purely
     * for reporting: these completions are collected rather than shown, so a
     * caller that wants to prove a long authoring call is still alive has no
     * other signal to work from.
     */
    onProgress?: (text: string) => void
  ): Promise<string>
  streamCompletion(
    modelId: string,
    messages: ChatMessage[],
    onChunk: (chunk: Omit<CompletionChunk, 'streamId'>) => void,
    signal?: AbortSignal,
    options?: CompletionOptions
  ): Promise<void>
  /**
   * Whether this provider can carry native (structured) function-calling for the
   * active endpoint (#15). Optional: only {@link GatewayProvider} implements it
   * (delegating to its wire adapter), so callers read
   * `provider.supportsNativeTools?.() ?? false` and Ollama (which omits it) yields
   * the safe `false`. The Cowork reply loop consults this before opting a turn into
   * the native tool path; when false it uses the ```myto:tool text protocol.
   */
  supportsNativeTools?(): boolean
}

/** Convenience: build a {@link ModelInfo} from an id, deriving a display name. */
export function modelInfo(id: string, name?: string): ModelInfo {
  return { id, name: name && name.trim() ? name : id }
}
