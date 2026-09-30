import type {
  ChatMessage,
  CompletionChunk,
  CompletionOptions,
  GatewayConfig,
  GeneratedMedia,
  ListModelsResult,
  TestConnectionResult
} from '../../shared/types'
import { pickAdapter, type StreamEvent, type WireAdapter } from './adapters'
import { collectCompletion } from './collect'
import {
  generateImages as generateImagesImpl,
  generateVideo as generateVideoImpl,
  type MediaGenOptions
} from './image-gen'
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
    // This URL-only pick is the default for model-less calls (listModels); per-request
    // paths refine it with the model id via adapterFor (a `claude-*` model on a plain
    // `/v1` base is an Anthropic proxy — see pickAdapter).
    this.adapter = pickAdapter(this.baseUrl)
  }

  /**
   * The wire adapter for a specific request. Refines the constructor's URL-only pick
   * with the model id: a bare `claude-*` model means an Anthropic-format proxy even on
   * an ordinary host, so its chat requests hit `/v1/messages` with `x-api-key` instead
   * of the Cloudflare-blocked OpenAI `/chat/completions`. Model-less callers keep the
   * URL-only default.
   */
  private adapterFor(modelId?: string): WireAdapter {
    return modelId && modelId.trim() ? pickAdapter(this.baseUrl, modelId) : this.adapter
  }

  private authHeaders(): Record<string, string> {
    return this.adapter.authHeaders(this.config)
  }

  /**
   * Whether this endpoint's wire format can carry native function-calling (#15).
   * Delegates to the adapter; the reply loop consults it (behind the `nativeTools`
   * opt-in) before advertising tool schemas instead of the ```myto:tool text protocol.
   */
  supportsNativeTools(): boolean {
    return this.adapter.supportsNativeTools
  }

  /**
   * Generate image(s) from a prompt (Feature B) — used when the active model is an
   * image model. Hits the gateway's OpenAI-compatible `/images/generations` with the
   * user's own key; see providers/image-gen. Only ever called for an image-kind turn.
   */
  async generateImages(
    modelId: string,
    prompt: string,
    opts?: MediaGenOptions,
    signal?: AbortSignal
  ): Promise<GeneratedMedia[]> {
    return generateImagesImpl(this.baseUrl, this.config, modelId, prompt, opts ?? {}, signal)
  }

  /** Best-effort video generation (Feature B); see providers/image-gen. */
  async generateVideo(
    modelId: string,
    prompt: string,
    opts?: MediaGenOptions,
    signal?: AbortSignal
  ): Promise<GeneratedMedia[]> {
    return generateVideoImpl(this.baseUrl, this.config, modelId, prompt, opts ?? {}, signal)
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
      const adapter = this.adapterFor(modelId)
      const res = await httpFetch(adapter.chatUrl(this.baseUrl), {
        method: 'POST',
        headers: adapter.authHeaders(this.config),
        timeoutMs: 20_000,
        body: adapter.pingBody(modelId)
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
    const adapter = this.adapterFor(modelId)
    const res = await httpFetch(adapter.chatUrl(this.baseUrl), {
      method: 'POST',
      // `Accept` nudges gateways that decide streaming from request headers to
      // actually stream; the non-SSE fallback below covers those that ignore it.
      headers: { Accept: 'text/event-stream', ...adapter.authHeaders(this.config) },
      timeoutMs: COMPLETION_TIMEOUT_MS,
      signal: guard.signal,
      body: adapter.buildBody(modelId, messages, options)
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
      // Tag the numeric status so the caller's retry loop and humanizer can key off
      // it structurally (429 rate-limit, 5xx transient) instead of scraping the text.
      Object.assign(err, { httpStatus: res.status })
      // Surface Retry-After so the retry loop can honour it (Principle 6 #2).
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
      const content = adapter.parseBuffered(data)
      if (content) onChunk({ delta: content, done: false })
      onChunk({ delta: '', done: true })
      return
    }

    // One stateful parser per response so a native tool call (#15) can be assembled
    // from fragments spread across many SSE lines without leaking state between the
    // concurrent streams that share this module-level adapter singleton. With no tool
    // call in the stream it forwards the same delta / reasoning / done events the old
    // per-line parse did, so the text-protocol path is byte-for-byte unchanged.
    const parser = adapter.createParser()
    const emit = (event: StreamEvent | null): void => {
      if (!event) return
      // Reasoning is forwarded out-of-band (empty delta) so the funnel can show a
      // live "thinking" caption; it must never join the reply text. Emit it before
      // the content delta, matching the pre-adapter ordering.
      if (event.reasoning) onChunk({ delta: '', done: false, reasoning: event.reasoning })
      if (event.delta) onChunk({ delta: event.delta, done: false })
      // A fully-assembled native tool call — forwarded internally only (it never
      // crosses IPC); the reply loop turns it into a ```myto:tool block and aborts.
      if (event.toolCall) onChunk({ delta: '', done: false, toolCall: event.toolCall })
      if (event.done) onChunk({ delta: '', done: true, truncated: event.truncated })
    }
    await readSse(res.body, (data) => emit(parser.push(data)), guard.touch)
    // A stream that ended without the terminal marker that normally releases a tool
    // call (a truncated or [DONE]-less stream) still surfaces the pending call here.
    emit(parser.flush())
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
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          // Re-arm the stall guard only on a real data frame. A dead upstream can keep
          // the socket "warm" with SSE keep-alive comments (`:`-prefixed lines) or
          // blank/empty `data:` heartbeats that carry no tokens; counting those as
          // progress let a generation that died mid-stream (e.g. mid tool call) hang
          // indefinitely instead of failing in STREAM_STALL_MS. A non-empty data frame —
          // including every fragment of a long file the model is still writing — is real
          // forward progress and keeps a genuinely-alive stream armed.
          if (payload) onProgress?.()
          onData(payload)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
