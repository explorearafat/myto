import type {
  ChatMessage,
  CompletionChunk,
  CompletionOptions,
  GatewayConfig,
  ListModelsResult,
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
 * OpenAI-compatible sampling fields for the request body. We prefer
 * `reasoning_effort` (a capable gateway maps it to the model's extended-thinking
 * budget — the single biggest quality lever) and, because Anthropic-backed
 * proxies reject a custom temperature while thinking is on, send `temperature`
 * ONLY when no reasoning effort is requested. `max_tokens` is orthogonal to both
 * and is added whenever the caller sets it (the `max` tier), lifting the output
 * ceiling so a big generation isn't truncated. Unknown fields are ignored by
 * spec-compliant gateways, so this can only help a capable backend.
 */
function samplingBody(options?: CompletionOptions): Record<string, unknown> {
  if (!options) return {}
  const body: Record<string, unknown> = {}
  if (options.reasoningEffort) {
    // 'max' is Sylor-internal; the wire vocabulary tops out at 'high'.
    body.reasoning_effort = options.reasoningEffort === 'max' ? 'high' : options.reasoningEffort
  } else if (typeof options.temperature === 'number') {
    body.temperature = options.temperature
  }
  if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens
  return body
}

/**
 * Expands our {@link ChatMessage}[] into the OpenAI chat wire format. A text-only
 * message passes straight through (`{role, content: string}`); a message carrying
 * images is rewritten into the multimodal parts array — one `text` part plus an
 * `image_url` part per image, each a `data:<mime>;base64,<bytes>` URL the gateway
 * forwards to the model's vision input. A gateway or model without vision ignores
 * the parts it can't use, and the text caption in `content` still carries meaning.
 */
function toOpenAiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (!m.images || m.images.length === 0) return { role: m.role, content: m.content }
    const parts: unknown[] = [{ type: 'text', text: m.content }]
    for (const img of m.images) {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` }
      })
    }
    return { role: m.role, content: parts }
  })
}
interface GatewayModelsResponse {
  data?: Array<{ id: string }>
}
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string }
}
interface ChatCompletionStreamChunk {
  choices?: Array<{ delta?: { content?: string; reasoning?: string } }>
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

  /**
   * Collected over the streaming endpoint rather than sent as `stream: false` —
   * see {@link collectCompletion} for why (a non-streaming request's header
   * deadline is a hard ceiling on total generation time, and every internal
   * caller of this method is asking for something big).
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
    // The guard replaces the (now gone) body deadline: armed only once bytes are
    // flowing, reset by each one, so a long-but-alive stream runs as long as it
    // needs and a dead one fails in STREAM_STALL_MS instead of hanging.
    const guard = stallGuard(STREAM_STALL_MS, signal)
    try {
      await this.streamInner(modelId, messages, onChunk, guard, options)
    } catch (err) {
      // A stall aborts the read, which surfaces as a bare cancellation; name it.
      if (guard.expired && !(err instanceof StallError)) throw new StallError(STREAM_STALL_MS)
      throw err
    } finally {
      guard.stop()
    }
  }

  private async streamInner(
    modelId: string,
    messages: ChatMessage[],
    onChunk: (chunk: Omit<CompletionChunk, 'streamId'>) => void,
    guard: ReturnType<typeof stallGuard>,
    options?: CompletionOptions
  ): Promise<void> {
    const res = await httpFetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      // `Accept` nudges gateways that decide streaming from request headers to
      // actually stream; the non-SSE fallback below covers those that ignore it.
      headers: { Accept: 'text/event-stream', ...this.authHeaders() },
      timeoutMs: COMPLETION_TIMEOUT_MS,
      signal: guard.signal,
      body: { model: modelId, stream: true, messages: toOpenAiMessages(messages), ...samplingBody(options) }
    })
    if (!res.ok) {
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
    // Headers are in, so httpFetch's deadline is gone; hand the body over to the
    // guard. This covers the buffered-JSON branch below as well as the SSE loop.
    guard.touch()

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

    await readSse(
      res.body,
      (data) => {
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
        // Reasoning models stream their chain-of-thought in `delta.reasoning` while
        // `delta.content` stays empty — often for tens of seconds. Forward it
        // out-of-band (empty delta) so the funnel can show a live "thinking"
        // caption; it must never join the reply text.
        const reasoning = parsed.choices?.[0]?.delta?.reasoning
        if (reasoning) onChunk({ delta: '', done: false, reasoning })
        const delta = parsed.choices?.[0]?.delta?.content ?? ''
        if (delta) onChunk({ delta, done: false })
      },
      // Progress is *any* byte, including a keep-alive comment line — the point
      // is that the connection is still producing, not that it produced content.
      guard.touch
    )
    onChunk({ delta: '', done: true })
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

async function readSse(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
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
        if (line.startsWith('data:')) onData(line.slice(5).trim())
      }
    }
  } finally {
    reader.releaseLock()
  }
}
