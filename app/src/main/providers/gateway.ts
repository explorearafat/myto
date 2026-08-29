import type {
  ChatMessage,
  CompletionChunk,
  CompletionOptions,
  GatewayConfig,
  ListModelsResult,
  TestConnectionResult
} from '../../shared/types'
import { httpFetch, httpJson, normaliseBaseUrl, toErrorMessage } from './http'
import { modelInfo, type Provider } from './provider'

/**
 * OpenAI-compatible sampling fields for the request body. We prefer
 * `reasoning_effort` (a capable gateway maps it to the model's extended-thinking
 * budget — the single biggest quality lever) and, because Anthropic-backed
 * proxies reject a custom temperature while thinking is on, send `temperature`
 * ONLY when no reasoning effort is requested. Unknown fields are ignored by
 * spec-compliant gateways, so this can only help a capable backend.
 */
function samplingBody(options?: CompletionOptions): Record<string, unknown> {
  if (!options) return {}
  if (options.reasoningEffort) {
    // 'max' is Sylor-internal; the wire vocabulary tops out at 'high'.
    const effort = options.reasoningEffort === 'max' ? 'high' : options.reasoningEffort
    return { reasoning_effort: effort }
  }
  if (typeof options.temperature === 'number') return { temperature: options.temperature }
  return {}
}
interface GatewayModelsResponse {
  data?: Array<{ id: string }>
}
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string }
}
interface ChatCompletionStreamChunk {
  choices?: Array<{ delta?: { content?: string } }>
  error?: { message?: string }
}
export class GatewayProvider implements Provider {
  private readonly baseUrl: string
  private readonly config: GatewayConfig

  constructor(config: GatewayConfig) {
    this.baseUrl = normaliseBaseUrl(config.baseUrl)
    this.config = config
  }
  private authHeaders(): Record<string, string> {
    const { authSchema, apiKey, authHeaderName } = this.config
    if (!apiKey) return {}
    if (authSchema === 'bearer') return { Authorization: `Bearer ${apiKey}` }
    if (authSchema === 'header' && authHeaderName.trim()) return { [authHeaderName.trim()]: apiKey }
    return {}
  }

  async listModels(): Promise<ListModelsResult> {
    if (!this.baseUrl) return { ok: false, models: [], error: 'Base URL is required.' }
    try {
      const data = await httpJson<GatewayModelsResponse>(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
        timeoutMs: 10_000
      })
      const models = (data.data ?? []).map((m) => modelInfo(m.id))
      return { ok: true, models }
    } catch (err) {
      return { ok: false, models: [], error: toErrorMessage(err) }
    }
  }

  async testConnection(modelId: string): Promise<TestConnectionResult> {
    if (!this.baseUrl) return { ok: false, message: 'Base URL is required.' }
    const started = Date.now()
    if (!modelId.trim()) {
      const list = await this.listModels()
      const latencyMs = Date.now() - started
      if (!list.ok) {
        const hint = /401|403/.test(list.error ?? '') ? ' (check API key / auth schema)' : ''
        return { ok: false, message: `${list.error ?? 'Could not reach the gateway.'}${hint}`, latencyMs }
      }
      const n = list.models.length
      return {
        ok: true,
        message: n > 0 ? `Connected · ${n} model${n === 1 ? '' : 's'} found` : 'Connected · endpoint reachable (no models listed)',
        latencyMs
      }
    }
    try {
      const res = await httpFetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.authHeaders(),
        timeoutMs: 20_000,
        body: {
          model: modelId,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        }
      })
      const latencyMs = Date.now() - started
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const detail = text.slice(0, 180) || res.statusText
        const hint = res.status === 401 || res.status === 403 ? ' (check API key / auth schema)' : ''
        return { ok: false, message: `HTTP ${res.status} — ${detail}${hint}`, latencyMs }
      }
      await res.json().catch(() => undefined)
      return { ok: true, message: `Connected · ${modelId}`, latencyMs }
    } catch (err) {
      return { ok: false, message: toErrorMessage(err), latencyMs: Date.now() - started }
    }
  }

  async getCompletion(
    modelId: string,
    messages: ChatMessage[],
    options?: CompletionOptions
  ): Promise<string> {
    const data = await httpJson<ChatCompletionResponse>(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.authHeaders(),
      timeoutMs: 120_000,
      body: { model: modelId, stream: false, messages, ...samplingBody(options) }
    })
    if (data.error?.message) throw new Error(data.error.message)
    return data.choices?.[0]?.message?.content ?? ''
  }

  async streamCompletion(
    modelId: string,
    messages: ChatMessage[],
    onChunk: (chunk: Omit<CompletionChunk, 'streamId'>) => void,
    signal?: AbortSignal,
    options?: CompletionOptions
  ): Promise<void> {
    const res = await httpFetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      // `Accept` nudges gateways that decide streaming from request headers to
      // actually stream; the non-SSE fallback below covers those that ignore it.
      headers: { Accept: 'text/event-stream', ...this.authHeaders() },
      timeoutMs: 120_000,
      signal,
      body: { model: modelId, stream: true, messages, ...samplingBody(options) }
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 160)}` : ''}`)
    }

    // Not every OpenAI-compatible gateway honours `stream:true`. Many routers
    // (e.g. ones proxying Claude/Gemini) ignore it and return a single JSON
    // completion (content-type application/json) instead of an SSE stream. If we
    // fed that to the SSE reader it would find no `data:` lines and emit nothing —
    // the connection "works" yet the user gets total silence. Detect a
    // non-event-stream response, read the whole body, and emit its content as one
    // delta so the answer still arrives. An error field is surfaced, and an
    // unrecognised body throws (visible) rather than failing quietly.
    const contentType = res.headers.get('content-type') ?? ''
    if (!res.body || !contentType.includes('text/event-stream')) {
      const data = (await res.json().catch(() => null)) as ChatCompletionResponse | null
      if (data?.error?.message) throw new Error(data.error.message)
      if (data && Array.isArray(data.choices)) {
        const content = data.choices[0]?.message?.content ?? ''
        if (content) onChunk({ delta: content, done: false })
        onChunk({ delta: '', done: true })
        return
      }
      throw new Error(
        'The gateway returned a non-streaming response with no recognisable message content. ' +
          'The model id may not be valid for chat completions on this endpoint.'
      )
    }

    await readSse(res.body, (data) => {
      if (data === '[DONE]') {
        onChunk({ delta: '', done: true })
        return
      }
      let parsed: ChatCompletionStreamChunk
      try {
        parsed = JSON.parse(data) as ChatCompletionStreamChunk
      } catch {
        return
      }
      if (parsed.error?.message) throw new Error(parsed.error.message)
      const delta = parsed.choices?.[0]?.delta?.content ?? ''
      if (delta) onChunk({ delta, done: false })
    })
    onChunk({ delta: '', done: true })
  }
}
async function readSse(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void
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
        if (line.startsWith('data:')) onData(line.slice(5).trim())
      }
    }
  } finally {
    reader.releaseLock()
  }
}
