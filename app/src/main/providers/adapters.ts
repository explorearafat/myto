// Per-provider wire-format adapters for the remote gateway.
//
// A single BYOK config (base URL + key + auth scheme + model list) can point at
// endpoints that speak *different* HTTP wire formats. Most are OpenAI-compatible
// (`POST /chat/completions`, `choices[].delta.content`, `[DONE]`); the real
// Anthropic API is not (`POST /v1/messages`, `x-api-key` + `anthropic-version`, a
// top-level `system` string, a mandatory `max_tokens`, named SSE events). Forcing
// Anthropic through the OpenAI path breaks it at every layer.
//
// A {@link WireAdapter} isolates ONLY the format-specific bits — endpoint URLs,
// auth headers, request-body assembly, per-SSE-line parse, buffered parse, and the
// models-list parse. All the shared plumbing (fetch, the stall guard, the SSE line
// reader, content-type sniffing, the Cloudflare/HTML block detection, Retry-After,
// the tool loop, the status/reasoning funnel) stays in {@link GatewayProvider} and
// is identical for every adapter. Adding a new format (Gemini, etc.) is a new
// object here plus a branch in {@link pickAdapter}; nothing else changes.
//
// The adapters are PURE (no I/O), so they unit-test trivially.

import type { ChatMessage, CompletionOptions, GatewayConfig, ModelInfo } from '../../shared/types'
import { modelInfo } from './provider'

/** One parsed SSE `data:` line, normalised across formats. All fields optional. */
export interface StreamEvent {
  /** Visible reply text to append. */
  delta?: string
  /** Out-of-band chain-of-thought (a reasoning model's "thinking"); never reply text. */
  reasoning?: string
  /** True on the format's terminal event (OpenAI `[DONE]`; Anthropic has no sentinel). */
  done?: boolean
}

/**
 * The format-specific surface {@link GatewayProvider} delegates to. Every method
 * is pure; the provider owns all I/O and shared error handling.
 */
export interface WireAdapter {
  /** Absolute chat-completion endpoint for a normalised base URL. */
  chatUrl(base: string): string
  /** Absolute models-list endpoint for a normalised base URL. */
  modelsUrl(base: string): string
  /** Auth (and any always-required) headers for this format. `Accept`/`content-type` stay in the provider. */
  authHeaders(config: GatewayConfig): Record<string, string>
  /** The streaming request body (always `stream: true`). */
  buildBody(modelId: string, messages: ChatMessage[], options?: CompletionOptions): Record<string, unknown>
  /**
   * Parse ONE SSE `data:` payload into a {@link StreamEvent}, or `null` to ignore
   * it (keep-alive, an event this format doesn't surface). MUST throw on an
   * in-band error frame so the provider reports it instead of going silent.
   */
  parseStreamData(data: string): StreamEvent | null
  /**
   * Extract the reply text from a buffered (non-streaming) JSON body — the case
   * where a gateway ignored `stream: true` and answered with one JSON blob. MUST
   * throw on an error shape or an unrecognised body (so silence never masquerades
   * as an empty answer).
   */
  parseBuffered(json: unknown): string
  /** Parse the models-list response into {@link ModelInfo}[]. */
  parseModels(json: unknown): ModelInfo[]
  /** A minimal 1-token request body for the Test Connection probe. */
  pingBody(modelId: string): Record<string, unknown>
}

// ── OpenAI-compatible adapter ────────────────────────────────────────────────
// Reproduces the previous GatewayProvider behaviour byte-for-byte, so every
// OpenAI-compatible endpoint (and the many proxies that speak that dialect)
// behaves exactly as it did before the seam existed.

/**
 * OpenAI sampling fields. We prefer `reasoning_effort` (a capable gateway maps it
 * to the model's extended-thinking budget — the single biggest quality lever) and,
 * because Anthropic-backed proxies reject a custom temperature while thinking is
 * on, send `temperature` ONLY when no reasoning effort is requested. `max_tokens`
 * is orthogonal to both and is added whenever the caller sets it (the `max` tier).
 */
function openAiSamplingBody(options?: CompletionOptions): Record<string, unknown> {
  if (!options) return {}
  const body: Record<string, unknown> = {}
  if (options.reasoningEffort) {
    // 'max' is Myto-internal; the wire vocabulary tops out at 'high'.
    body.reasoning_effort = options.reasoningEffort === 'max' ? 'high' : options.reasoningEffort
  } else if (typeof options.temperature === 'number') {
    body.temperature = options.temperature
  }
  if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens
  return body
}

/**
 * Expand {@link ChatMessage}[] into the OpenAI chat wire format. A text-only
 * message passes straight through (`{role, content: string}`); a message carrying
 * images becomes a multimodal parts array — one `text` part plus an `image_url`
 * part per image, each a `data:<mime>;base64,<bytes>` URL.
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

interface OpenAiModelsResponse {
  data?: Array<{ id: string }>
}
interface OpenAiBufferedResponse {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string }
}
interface OpenAiStreamChunk {
  choices?: Array<{ delta?: { content?: string; reasoning?: string } }>
  error?: { message?: string }
}

export const openAiAdapter: WireAdapter = {
  chatUrl: (base) => `${base}/chat/completions`,
  modelsUrl: (base) => `${base}/models`,

  authHeaders(config) {
    const { authSchema, apiKey, authHeaderName } = config
    if (!apiKey) return {}
    if (authSchema === 'bearer') return { Authorization: `Bearer ${apiKey}` }
    if (authSchema === 'header' && authHeaderName.trim()) return { [authHeaderName.trim()]: apiKey }
    return {}
  },

  buildBody(modelId, messages, options) {
    return { model: modelId, stream: true, messages: toOpenAiMessages(messages), ...openAiSamplingBody(options) }
  },

  parseStreamData(data) {
    if (data === '[DONE]') return { done: true }
    let parsed: OpenAiStreamChunk
    try {
      parsed = JSON.parse(data) as OpenAiStreamChunk
    } catch {
      return null
    }
    if (parsed.error?.message) throw new Error(parsed.error.message)
    const event: StreamEvent = {}
    // Reasoning models stream chain-of-thought in `delta.reasoning` while
    // `delta.content` stays empty; forward it out-of-band, never as reply text.
    const reasoning = parsed.choices?.[0]?.delta?.reasoning
    if (reasoning) event.reasoning = reasoning
    const delta = parsed.choices?.[0]?.delta?.content
    if (delta) event.delta = delta
    return event
  },

  parseBuffered(json) {
    const data = json as OpenAiBufferedResponse | null
    if (data?.error?.message) throw new Error(data.error.message)
    if (data && Array.isArray(data.choices)) return data.choices[0]?.message?.content ?? ''
    throw new Error(
      'The gateway returned a non-streaming response with no recognisable message content. ' +
        'The model id may not be valid for chat completions on this endpoint.'
    )
  },

  parseModels(json) {
    const data = json as OpenAiModelsResponse | null
    return (data?.data ?? []).map((m) => modelInfo(m.id))
  },

  pingBody: (modelId) => ({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
}

// ── Anthropic (Claude Messages) adapter ───────────────────────────────────────
// The native Anthropic Messages API: a different endpoint, dual auth headers, a
// hoisted top-level `system` string, a mandatory `max_tokens`, and named SSE
// events (no `[DONE]`).

/** Anthropic requires this on every request; the value is a dated API version, not a secret. */
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Anthropic requires `max_tokens`. The interactive stream currently passes no cap
 * (only `reasoningEffort`), so this default is what most turns use. 4096 is
 * accepted by *every* Claude model (including the Claude 3 family, which caps
 * there), so it can never 400 for being too high; the `max` tier lifts it via
 * `options.maxTokens` when a caller sets one.
 */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096

/**
 * Join a path onto a base that may or may not already end in `/v1`. `…/v1` +
 * `messages` → `…/v1/messages`; a bare host → `…/v1/messages`. Avoids a doubled
 * `/v1/v1` when a user includes it (Anthropic's own docs show the bare host).
 */
function anthropicJoin(base: string, path: string): string {
  return /\/v1$/.test(base) ? `${base}/${path}` : `${base}/v1/${path}`
}

/**
 * Expand a single message's content into Anthropic's shape. Text-only → a plain
 * string; with images → a content-blocks array (text block first, then one
 * `image` block per attachment using a base64 `source`).
 */
function anthropicContent(m: ChatMessage): unknown {
  if (!m.images || m.images.length === 0) return m.content
  const blocks: unknown[] = [{ type: 'text', text: m.content }]
  for (const img of m.images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 }
    })
  }
  return blocks
}

interface AnthropicModelsResponse {
  data?: Array<{ id: string; display_name?: string }>
}
interface AnthropicBufferedResponse {
  content?: Array<{ type?: string; text?: string }>
  error?: { message?: string }
  type?: string
}
interface AnthropicStreamEvent {
  type?: string
  delta?: { type?: string; text?: string; thinking?: string }
  error?: { message?: string }
}

export const anthropicAdapter: WireAdapter = {
  chatUrl: (base) => anthropicJoin(base, 'messages'),
  modelsUrl: (base) => anthropicJoin(base, 'models'),

  authHeaders(config) {
    // Anthropic ignores the config's authSchema — the format is known from the
    // URL and always needs BOTH headers. The key rides `x-api-key` (only when set).
    const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION }
    if (config.apiKey) headers['x-api-key'] = config.apiKey
    return headers
  },

  buildBody(modelId, messages, options) {
    // Hoist every system turn into the top-level `system` string; the messages
    // array is user/assistant only (Anthropic rejects a system role there).
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: anthropicContent(m) }))
    const body: Record<string, unknown> = {
      model: modelId,
      stream: true,
      max_tokens: typeof options?.maxTokens === 'number' ? options.maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: turns
    }
    if (system) body.system = system
    // No `reasoning_effort` (Anthropic rejects the unknown field). Temperature is
    // forwarded only when explicitly requested and no effort is set (Anthropic
    // rejects a custom temperature while extended thinking is on).
    if (!options?.reasoningEffort && typeof options?.temperature === 'number') {
      body.temperature = options.temperature
    }
    return body
  },

  parseStreamData(data) {
    let parsed: AnthropicStreamEvent
    try {
      parsed = JSON.parse(data) as AnthropicStreamEvent
    } catch {
      return null
    }
    // An `error` event carries the failure in-band (e.g. overloaded, invalid request).
    if (parsed.type === 'error') throw new Error(parsed.error?.message ?? 'Anthropic stream error')
    if (parsed.type === 'message_stop') return { done: true }
    if (parsed.type === 'content_block_delta') {
      if (parsed.delta?.type === 'text_delta' && parsed.delta.text) return { delta: parsed.delta.text }
      // Extended-thinking output arrives as `thinking_delta`; surface it as
      // out-of-band reasoning, never as reply text.
      if (parsed.delta?.type === 'thinking_delta' && parsed.delta.thinking) {
        return { reasoning: parsed.delta.thinking }
      }
    }
    // message_start / content_block_start / content_block_stop / message_delta / ping — nothing to emit.
    return null
  },

  parseBuffered(json) {
    const data = json as AnthropicBufferedResponse | null
    if (data?.type === 'error' || data?.error?.message) {
      throw new Error(data?.error?.message ?? 'Anthropic returned an error')
    }
    if (data && Array.isArray(data.content)) {
      return data.content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
    }
    throw new Error(
      'The endpoint returned a non-streaming response with no recognisable message content. ' +
        'The model id may not be valid for this Anthropic endpoint.'
    )
  },

  parseModels(json) {
    const data = json as AnthropicModelsResponse | null
    return (data?.data ?? []).map((m) => modelInfo(m.id, m.display_name))
  },

  pingBody: (modelId) => ({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
}

/**
 * Auto-detect the wire format from the base URL. Host-based: the real Anthropic
 * API lives at `api.anthropic.com` (and any `*.anthropic.com`); everything else is
 * treated as OpenAI-compatible. As a fallback for a proxy that mirrors Anthropic's
 * path on another host, an explicit `/v1/messages` in the URL also selects
 * Anthropic. A malformed URL falls back to OpenAI (the provider surfaces the URL
 * error later). Selection is invisible to the shared BYOK config — nothing in the
 * saved contract changes.
 */
export function pickAdapter(baseUrl: string): WireAdapter {
  let host = ''
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    // Not a parseable URL yet; the path check below still works on the raw string.
  }
  if (host === 'anthropic.com' || host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) {
    return anthropicAdapter
  }
  if (/\/v1\/messages\b/.test(baseUrl)) return anthropicAdapter
  return openAiAdapter
}
