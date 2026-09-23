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
import type { WireMessage } from './gateway';

/** The format-specific surface the gateway delegates to. Every method is pure. */
export interface WebWireAdapter {
  /** Absolute chat endpoint for a base URL that has had trailing slashes trimmed. */
  upstreamUrl(base: string): string;
  /** Auth (and any always-required) headers. `content-type`/`Accept` stay in the gateway. */
  upstreamHeaders(cfg: ByokConfig): Record<string, string>;
  /** The streaming request body (always `stream: true`). */
  buildBody(model: string, messages: WireMessage[], maxTokens: number): Record<string, unknown>;
  /**
   * Visible reply text from one SSE `data:` payload, or '' when there is nothing
   * to forward (a terminal sentinel, a non-text event, reasoning, or partial JSON).
   */
  parseStreamLine(data: string): string;
  /** Visible reply text from a buffered (non-streaming) JSON body, or '' if none. */
  parseBuffered(json: unknown): string;
}

// ── OpenAI-compatible adapter ────────────────────────────────────────────────
// Reproduces the gateway's previous behaviour byte-for-byte, so every
// OpenAI-compatible endpoint and proxy behaves exactly as it did before the seam.

export const openAiWebAdapter: WebWireAdapter = {
  upstreamUrl: (base) => `${base}/chat/completions`,

  upstreamHeaders(cfg) {
    if (!cfg.apiKey || cfg.authSchema === 'none') return {};
    if (cfg.authSchema === 'header') return { [cfg.authHeaderName || 'Authorization']: cfg.apiKey };
    return { Authorization: `Bearer ${cfg.apiKey}` };
  },

  buildBody: (model, messages, maxTokens) => ({
    model,
    stream: true,
    stream_options: { include_usage: true },
    messages,
    max_tokens: maxTokens,
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
};

// ── Anthropic (Claude Messages) adapter ───────────────────────────────────────
// Native Anthropic Messages API: different endpoint, dual auth headers, a hoisted
// top-level `system` string, a mandatory `max_tokens`, and named SSE events (no
// `[DONE]`). Reasoning (`thinking_delta`) is intentionally dropped — this gateway
// has no out-of-band reasoning channel, so it forwards visible text only.

/** Anthropic requires this on every request; a dated API version, not a secret. */
const ANTHROPIC_VERSION = '2023-06-01';

/** Join a path onto a base that may or may not already end in `/v1`, avoiding `/v1/v1`. */
function anthropicJoin(base: string, path: string): string {
  return /\/v1$/.test(base) ? `${base}/${path}` : `${base}/v1/${path}`;
}

export const anthropicWebAdapter: WebWireAdapter = {
  upstreamUrl: (base) => anthropicJoin(base, 'messages'),

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
};

/**
 * Auto-detect the wire format from the base URL — host-based, mirroring the
 * desktop `pickAdapter`. The real Anthropic API lives at `*.anthropic.com`;
 * everything else is OpenAI-compatible. A proxy that mirrors Anthropic's path on
 * another host is caught by an explicit `/v1/messages` in the URL. A malformed
 * URL falls back to OpenAI (the gateway rejects a bad base URL separately).
 * Selection is invisible to the saved BYOK contract.
 */
export function pickWebAdapter(baseUrl: string): WebWireAdapter {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // Not a parseable URL; the path check below still works on the raw string.
  }
  if (host === 'anthropic.com' || host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) {
    return anthropicWebAdapter;
  }
  if (/\/v1\/messages\b/.test(baseUrl)) return anthropicWebAdapter;
  return openAiWebAdapter;
}
