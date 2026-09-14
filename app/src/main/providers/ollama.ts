import type {
  ChatMessage,
  CompletionChunk,
  CompletionOptions,
  ListModelsResult,
  OllamaConfig,
  TestConnectionResult
} from '../../shared/types'
import { collectCompletion } from './collect'
import {
  COMPLETION_TIMEOUT_MS,
  httpFetch,
  httpJson,
  normaliseBaseUrl,
  stallGuard,
  StallError,
  STREAM_STALL_MS,
  toErrorMessage
} from './http'
import { modelInfo, type Provider } from './provider'

/**
 * Ollama sampling. It has no `reasoning_effort` (that's a gateway concept), so we
 * map the caller's temperature into Ollama's native `options.temperature` and the
 * caller's output cap into `options.num_predict` (Ollama's max-tokens knob). A
 * missing value leaves Ollama on its own defaults. `reasoningEffort` is
 * intentionally ignored here.
 */
function ollamaOptions(options?: CompletionOptions): Record<string, unknown> {
  if (!options) return {}
  const inner: Record<string, unknown> = {}
  if (typeof options.temperature === 'number') inner.temperature = options.temperature
  if (typeof options.maxTokens === 'number') inner.num_predict = options.maxTokens
  return Object.keys(inner).length > 0 ? { options: inner } : {}
}

/**
 * Expands our {@link ChatMessage}[] into Ollama's native chat format. Ollama
 * attaches images out-of-band: a message keeps its string `content` and gains an
 * `images` array of raw base64 strings (no `data:` prefix) — exactly our
 * {@link ChatImage.dataBase64}. A text-only message passes through unchanged; a
 * model without vision ignores the `images` field.
 */
function toOllamaMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) =>
    m.images && m.images.length > 0
      ? { role: m.role, content: m.content, images: m.images.map((img) => img.dataBase64) }
      : { role: m.role, content: m.content }
  )
}
interface OllamaTag {
  name: string
  model?: string
}
interface OllamaTagsResponse {
  models?: OllamaTag[]
}
interface OllamaChatChunk {
  message?: { role: string; content: string }
  done?: boolean
  error?: string
}
export class OllamaProvider implements Provider {
  private readonly baseUrl: string

  constructor(config: OllamaConfig) {
    this.baseUrl = normaliseBaseUrl(config.baseUrl)
  }

  async listModels(): Promise<ListModelsResult> {
    try {
      const data = await httpJson<OllamaTagsResponse>(`${this.baseUrl}/api/tags`, {
        timeoutMs: 8_000
      })
      const models = (data.models ?? []).map((m) => modelInfo(m.name))
      return { ok: true, models }
    } catch (err) {
      return { ok: false, models: [], error: toErrorMessage(err) }
    }
  }

  async testConnection(modelId: string): Promise<TestConnectionResult> {
    const started = Date.now()
    if (!modelId.trim()) {
      const list = await this.listModels()
      const latencyMs = Date.now() - started
      if (!list.ok) return { ok: false, message: list.error ?? 'Could not reach Ollama.', latencyMs }
      const n = list.models.length
      return {
        ok: true,
        message: n > 0 ? `Connected to Ollama · ${n} model${n === 1 ? '' : 's'}` : 'Connected to Ollama · no models pulled yet',
        latencyMs
      }
    }
    try {
      const res = await httpFetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        timeoutMs: 20_000,
        body: {
          model: modelId,
          stream: false,
          options: { num_predict: 1 },
          messages: [{ role: 'user', content: 'ping' }]
        }
      })
      const latencyMs = Date.now() - started
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return {
          ok: false,
          message: `HTTP ${res.status} — ${text.slice(0, 160) || res.statusText}`,
          latencyMs
        }
      }
      await res.json().catch(() => undefined)
      return { ok: true, message: `Connected to Ollama · ${modelId}`, latencyMs }
    } catch (err) {
      return { ok: false, message: toErrorMessage(err), latencyMs: Date.now() - started }
    }
  }

  /**
   * Collected over the streaming endpoint rather than sent as `stream: false` —
   * see {@link collectCompletion}. Matters even more for a local model, where a
   * cold load plus a long generation easily outruns any fixed total deadline.
   */
  async getCompletion(
    modelId: string,
    messages: ChatMessage[],
    options?: CompletionOptions,
    signal?: AbortSignal,
    onProgress?: (text: string) => void
  ): Promise<string> {
    return collectCompletion(this, modelId, messages, options, signal, onProgress)
  }

  async streamCompletion(
    modelId: string,
    messages: ChatMessage[],
    onChunk: (chunk: Omit<CompletionChunk, 'streamId'>) => void,
    signal?: AbortSignal,
    options?: CompletionOptions
  ): Promise<void> {
    // See the gateway provider: the guard is the body's deadline, reset by every
    // chunk, so a local model that thinks for ten minutes is never cut off but a
    // silent stream still fails instead of hanging.
    const guard = stallGuard(STREAM_STALL_MS, signal)
    try {
      const res = await httpFetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        timeoutMs: COMPLETION_TIMEOUT_MS,
        signal: guard.signal,
        body: { model: modelId, stream: true, messages: toOllamaMessages(messages), ...ollamaOptions(options) }
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        const err = new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 160)}` : ''}`)
        // Surface Retry-After so withRetry can honour it (Principle 6 #2).
        const retryAfter = res.headers.get('retry-after')
        if (retryAfter) {
          const ms = parseRetryAfter(retryAfter)
          if (ms !== null) Object.assign(err, { retryAfterMs: ms })
        }
        throw err
      }
      guard.touch()
      await readNdjson(
        res.body,
        (line) => {
          let parsed: OllamaChatChunk
          try {
            parsed = JSON.parse(line) as OllamaChatChunk
          } catch {
            return
          }
          if (parsed.error) throw new Error(parsed.error)
          const delta = parsed.message?.content ?? ''
          if (delta) onChunk({ delta, done: false })
          if (parsed.done) onChunk({ delta: '', done: true })
        },
        guard.touch
      )
    } catch (err) {
      // A stall aborts the read, which surfaces as a bare cancellation; name it.
      if (guard.expired && !(err instanceof StallError)) throw new StallError(STREAM_STALL_MS)
      throw err
    } finally {
      guard.stop()
    }
  }
}
/**
 * Parse a `Retry-After` header value into milliseconds. Handles both delta-seconds
 * (an integer) and HTTP-date (RFC 7231 § 7.1.1.1). Returns `null` if unparseable.
 */
function parseRetryAfter(value: string): number | null {
  const trimmed = value.trim()
  // Delta-seconds: an integer (e.g. "120" = 2 minutes from now).
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return seconds > 0 ? seconds * 1000 : null
  }
  // HTTP-date: parse as a timestamp and compute the delta.
  const timestamp = Date.parse(trimmed)
  if (!isNaN(timestamp)) {
    const delta = timestamp - Date.now()
    return delta > 0 ? delta : null
  }
  return null
}

async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  onProgress?: () => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      onProgress?.()
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) onLine(line)
      }
    }
    const tail = buffer.trim()
    if (tail) onLine(tail)
  } finally {
    reader.releaseLock()
  }
}
