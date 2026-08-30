import type {
  ChatMessage,
  CompletionChunk,
  CompletionOptions,
  ListModelsResult,
  OllamaConfig,
  TestConnectionResult
} from '../../shared/types'
import { httpFetch, httpJson, normaliseBaseUrl, toErrorMessage } from './http'
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

  async getCompletion(
    modelId: string,
    messages: ChatMessage[],
    options?: CompletionOptions
  ): Promise<string> {
    const data = await httpJson<OllamaChatChunk>(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      timeoutMs: 120_000,
      body: { model: modelId, stream: false, messages, ...ollamaOptions(options) }
    })
    if (data.error) throw new Error(data.error)
    return data.message?.content ?? ''
  }

  async streamCompletion(
    modelId: string,
    messages: ChatMessage[],
    onChunk: (chunk: Omit<CompletionChunk, 'streamId'>) => void,
    signal?: AbortSignal,
    options?: CompletionOptions
  ): Promise<void> {
    const res = await httpFetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      timeoutMs: 120_000,
      signal,
      body: { model: modelId, stream: true, messages, ...ollamaOptions(options) }
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 160)}` : ''}`)
    }
    await readNdjson(res.body, (line) => {
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
    })
  }
}
async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
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
