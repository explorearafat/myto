// Per-provider wire-format adapters for the web chat gateway — the Edge-side
// mirror of the desktop seam (app/src/main/providers/adapters.ts), trimmed to
// what this gateway actually needs: no image parts (WireMessage is text-only),
// no reasoning channel (the gateway forwards only visible tokens), no model
// listing (the picker reads that from Firestore, not the gateway).
//
// A single BYOK config (base URL + key + auth scheme) can point at an
// OpenAI-compatible endpoint OR the native Anthropic Messages API — two
// different HTTP wire formats. This isolates ONLY the format-specific bits:
// endpoint URL, auth headers, request body, per-SSE-line parse, buffered parse.
// Everything else in the gateway (the same-origin/SSRF guards, the bounded tool
// loop, the SSE reader, the `data: {t:'token'|'done'|'error'}` client protocol)
// is provider-agnostic and stays put — so an Anthropic endpoint rides the exact
// same loop an OpenAI one does.
//
// The adapters are PURE (no I/O) and Edge-safe (no Node APIs), so they unit-test
// trivially and run identically on Vercel Edge and in the Vite dev middleware.

import type { ByokConfig } from '../shared/byok';
import type { WireMessage, ReasoningEffort } from './gateway';

/** The format-specific surface the gateway delegates to. Every method is pure. */
export interface WebWireAdapter {
  /** Absolute chat endpoint for a base URL that has had trailing slashes trimmed. */
  upstreamUrl(base: string): string;
  /** Absolute model-list endpoint (GET) for a base URL with trailing slashes trimmed. */
  modelsUrl(base: string): string;
  /** Auth (and any always-required) headers. `content-type`/`Accept` stay in the gateway. */
  upstreamHeaders(cfg: ByokConfig): Record<string, string>;
  /**
   * The streaming request body (always `stream: true`). `effort`, when set, is a
   * reasoning-effort hint the mobile composer opted into: OpenAI-family endpoints
   * receive it as `reasoning_effort`; the Anthropic adapter ignores it. Absent =
   * unchanged body, so the web chat (which never sends it) is byte-for-byte identical.
   */
  buildBody(
    model: string,
    messages: WireMessage[],
    maxTokens: number,
    effort?: ReasoningEffort,
  ): Record<string, unknown>;
  /**
   * Visible reply text from one SSE `data:` payload, or '' when there is nothing
   * to forward (a terminal sentinel, a non-text event, reasoning, or partial JSON).
   */
  parseStreamLine(data: string): string;
  /** Visible reply text from a buffered (non-streaming) JSON body, or '' if none. */
  parseBuffered(json: unknown): string;
  /** Model ids from a buffered model-list JSON body, or [] when none/unparseable. */
  parseModels(json: unknown): string[];
}

/** Both OpenAI (`/models`) and Anthropic (`/v1/models`) return `{ data: [{ id }] }`. */
function parseModelsList(json: unknown): string[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const m of data) {
    const id = (m as { id?: unknown })?.id;
    if (typeof id === 'string' && id.trim()) ids.push(id.trim());
  }
  return ids;
}

// ── OpenAI-compatible adapter ────────────────────────────────────────────────
// Reproduces the gateway's previous behaviour byte-for-byte, so every
// OpenAI-compatible endpoint and proxy behaves exactly as it did before the seam.

export const openAiWebAdapter: WebWireAdapter = {
  upstreamUrl: (base) => `${base}/chat/completions`,

  modelsUrl: (base) => `${base}/models`,

  upstreamHeaders(cfg) {
    if (!cfg.apiKey || cfg.authSchema === 'none') return {};
    if (cfg.authSchema === 'header') return { [cfg.authHeaderName || 'Authorization']: cfg.apiKey };
    return { Authorization: `Bearer ${cfg.apiKey}` };
  },

  buildBody: (model, messages, maxTokens, effort) => ({
    model,
    stream: true,
    stream_options: { include_usage: true },
    messages,
    max_tokens: maxTokens,
    // Only present when the caller opted into an effort — reasoning models (o-series,
    // GPT-5) honour it; a plain model may reject an unknown field, so we never send a
    // default. The Anthropic adapter deliberately drops it (different thinking model).
    ...(effort ? { reasoning_effort: effort } : {}),
  }),

  parseStreamLine(data) {
    if (data === '[DONE]') return '';
    try {
      const j = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
      const delta = j?.choices?.[0]?.delta?.content;
      return typeof delta === 'string' ? delta : '';
    } catch {
      // Partial JSON across chunks — the remainder stays buffered for the next read.
      return '';
    }
  },

  parseBuffered(json) {
    const data = json as { choices?: { message?: { content?: string } }[] } | null;
    return data?.choices?.[0]?.message?.content ?? '';
  },

  parseModels: parseModelsList,
};

// ── Anthropic (Claude Messages) adapter ───────────────────────────────────────
// Native Anthropic Messages API: different endpoint, dual auth headers, a hoisted
// top-level `system` string, a mandatory `max_tokens`, and named SSE events (no
// `[DONE]`). Reasoning (`thinking_delta`) is intentionally dropped — this gateway
// has no out-of-band reasoning channel, so it forwards visible text only.

/** Anthropic requires this on every request; a dated API version, not a secret. */
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Build `<root>/v1/<path>` for the Anthropic Messages API, whatever endpoint-ish
 * suffix the saved base URL carries. A third-party Claude proxy is commonly entered
 * as the full `…/v1/messages` — which is also the value that forces this adapter via
 * {@link pickWebAdapter} — so naively appending `/v1/messages` would double the path
 * (`…/v1/messages/v1/messages`) and 404. Strip a trailing `messages`/`models` segment
 * and a trailing `/v1` first, then re-append exactly one `/v1/<path>`. Handles a bare
 * host, `…/v1`, `…/v1/messages`, `…/messages`, and `…/v1/models` alike.
 */
function anthropicJoin(base: string, path: string): string {
  const root = base
    .replace(/\/(?:messages|models)\/*$/i, '')
    .replace(/\/v1\/*$/i, '');
  return `${root}/v1/${path}`;
}

export const anthropicWebAdapter: WebWireAdapter = {
  upstreamUrl: (base) => anthropicJoin(base, 'messages'),

  modelsUrl: (base) => anthropicJoin(base, 'models'),

  upstreamHeaders(cfg) {
    // Anthropic ignores the config's authSchema — the format is known from the
    // URL and always needs BOTH headers. The key rides `x-api-key` (only when set).
    const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };
    if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;
    return headers;
  },

  buildBody(model, messages, maxTokens) {
    // Hoist every system turn (the injected tools prompt + the last-turn nudge)
    // into the top-level `system` string; the messages array is user/assistant
    // only, which Anthropic requires.
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = { model, stream: true, max_tokens: maxTokens, messages: turns };
    if (system) body.system = system;
    return body;
  },

  parseStreamLine(data) {
    let parsed: { type?: string; delta?: { type?: string; text?: string } };
    try {
      parsed = JSON.parse(data) as typeof parsed;
    } catch {
      return '';
    }
    if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && parsed.delta.text) {
      return parsed.delta.text;
    }
    // thinking_delta (reasoning) / message_start / message_stop / ping / error — nothing visible.
    return '';
  },

  parseBuffered(json) {
    const data = json as { content?: { type?: string; text?: string }[] } | null;
    if (data && Array.isArray(data.content)) {
      return data.content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
    }
    return '';
  },

  parseModels: parseModelsList,
};

/**
 * A bare Claude model id — `claude-opus-4-8`, `claude-3-5-sonnet-20241022` — is a
 * strong, zero-config signal that the endpoint is a Claude proxy speaking the native
 * Anthropic Messages format, even on an ordinary host with a plain `/v1` base. The id
 * must START with `claude`; that discriminates against an OpenAI-compatible aggregator
 * like OpenRouter, whose ids keep a vendor prefix (`anthropic/claude-3.5-sonnet`) and
 * must stay OpenAI-compatible. Empirically these proxies implement `/v1/messages`
 * (often ONLY that — their WAF 403s the OpenAI `/chat/completions` path), so this
 * routes them right without the user knowing the `/v1/messages` escape hatch.
 */
export function looksLikeClaudeModel(model: string | undefined | null): boolean {
  return typeof model === 'string' && /^claude(?:[-.]|$)/i.test(model.trim());
}

/**
 * Auto-detect the wire format — host-based first, mirroring the desktop `pickAdapter`.
 * The real Anthropic API lives at `*.anthropic.com`. Then two signals for a third-party
 * Claude proxy on an ordinary host: an explicit `/v1/messages` (or bare `/messages`) in
 * the URL — the manual escape hatch — and a bare `claude-*` model id (see
 * {@link looksLikeClaudeModel}) — the zero-config path, so the user's plain `/v1` base
 * URL just works. Everything else is OpenAI-compatible. A malformed URL falls back to
 * OpenAI (the gateway rejects a bad base URL separately). Selection is invisible to the
 * saved BYOK contract.
 */
export function pickWebAdapter(baseUrl: string, model?: string): WebWireAdapter {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // Not a parseable URL; the path check below still works on the raw string.
  }
  if (host === 'anthropic.com' || host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) {
    return anthropicWebAdapter;
  }
  if (/\/v1\/messages\b/.test(baseUrl) || /\/messages\/*$/i.test(baseUrl)) return anthropicWebAdapter;
  // Zero-config: a bare Claude model id means an Anthropic-format proxy.
  if (looksLikeClaudeModel(model)) return anthropicWebAdapter;
  return openAiWebAdapter;
}
