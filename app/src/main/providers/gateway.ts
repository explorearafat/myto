import type {
  ChatMessage,
  CompletionChunk,
  CompletionOptions,
  GatewayConfig,
  ListModelsResult,
  TestConnectionResult
} from '../../shared/types'
import { pickAdapter, type WireAdapter } from './adapters'
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
import { type Provider } from './provider'

/**
 * The remote-gateway provider. It owns all the shared plumbing — fetch, the stall
 * guard, the SSE line reader, content-type sniffing, the Cloudflare/HTML block
 * detection, and Retry-After — and delegates every format-specific decision
 * (endpoint URLs, auth headers, request body, per-line parse, buffered parse,
 * models parse) to a {@link WireAdapter} chosen from the base URL. That is what
 * lets one BYOK config drive an OpenAI-compatible endpoint or the native Anthropic
 * Messages API through a single interface; see `./adapters`.
 */
export class GatewayProvider implements Provider {
  private readonly baseUrl: string
  private readonly config: GatewayConfig
  private readonly adapter: WireAdapter

  constructor(config: GatewayConfig) {
    this.baseUrl = normaliseBaseUrl(config.baseUrl)
    this.config = config
    // Auto-detect the wire format from the endpoint host; invisible to the config.
    this.adapter = pickAdapter(this.baseUrl)
  }

  private authHeaders(): Record<string, string> {
    return this.adapter.authHeaders(this.config)
  }

  async listModels(): Promise<ListModelsResult> {
    if (!this.baseUrl) return { ok: false, models: [], error: 'Base URL is required.' }
    try {
      const data = await httpJson<unknown>(this.adapter.modelsUrl(this.baseUrl), {
        headers: this.authHeaders(),
        timeoutMs: 10_000
      })
      return { ok: true, models: this.adapter.parseModels(data) }
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
      const res = await httpFetch(this.adapter.chatUrl(this.baseUrl), {
        method: 'POST',
        headers: this.authHeaders(),
        timeoutMs: 20_000,
        body: this.adapter.pingBody(modelId)
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
    const res = await httpFetch(this.adapter.chatUrl(this.baseUrl), {
      method: 'POST',
      // `Accept` nudges gateways that decide streaming from request headers to
      // actually stream; the non-SSE fallback below covers those that ignore it.
      headers: { Accept: 'text/event-stream', ...this.authHeaders() },
      timeoutMs: COMPLETION_TIMEOUT_MS,
      signal: guard.signal,
      body: this.adapter.buildBody(modelId, messages, options)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // A Cloudflare / edge firewall block returns an HTML page, not an API error.
      // Dumping that raw HTML into the chat is noise and hides what's wrong, so
      // detect it and surface a clear, actionable message instead.
      const server = (res.headers.get('server') ?? '').toLowerCase()
      const looksHtml = /^\s*<!doctype html|^\s*<html/i.test(text)
      const cloudflareBlock =
        looksHtml && (server.includes('cloudflare') || /attention required|cloudflare|you have been blocked/i.test(text))
      if (cloudflareBlock || looksHtml) {
        const err = new Error(
          `Your model endpoint refused the request (HTTP ${res.status}${
            cloudflareBlock ? ', blocked by Cloudflare' : ''
          }). The endpoint is reachable but its firewall is rejecting chat requests from your network — this is on the provider, not Myto. Try a different network or VPN, or switch to a working endpoint on the Myto website → Authentication page.`
        )
        throw err
      }
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
    // delta so the answer still arrives. The adapter's parseBuffered surfaces an
    // error field and throws (visible) on an unrecognised body rather than failing
    // quietly.
    const contentType = res.headers.get('content-type') ?? ''
    if (!res.body || !contentType.includes('text/event-stream')) {
      const data = await res.json().catch(() => null)
      const content = this.adapter.parseBuffered(data)
      if (content) onChunk({ delta: content, done: false })
      onChunk({ delta: '', done: true })
      return
    }

    await readSse(
      res.body,
      (data) => {
        // The adapter maps this format's SSE payload onto a normalised event
        // (delta / reasoning / done), or null to ignore it, and throws on an
        // in-band error frame so it surfaces instead of going silent.
        const event = this.adapter.parseStreamData(data)
        if (!event) return
        // Reasoning is forwarded out-of-band (empty delta) so the funnel can show a
        // live "thinking" caption; it must never join the reply text. Emit it
        // before the content delta, matching the pre-adapter ordering.
        if (event.reasoning) onChunk({ delta: '', done: false, reasoning: event.reasoning })
        if (event.delta) onChunk({ delta: event.delta, done: false })
        if (event.done) onChunk({ delta: '', done: true })
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
