import { describe, it, expect } from 'vitest';
import {
  pickWebAdapter,
  looksLikeClaudeModel,
  openAiWebAdapter,
  anthropicWebAdapter,
  type WebWireAdapter,
} from './adapters';
import type { ByokConfig } from '../shared/byok';
import type { WireMessage } from './gateway';

function cfg(over: Partial<ByokConfig> = {}): ByokConfig {
  return {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'secret',
    authSchema: 'bearer',
    authHeaderName: 'Authorization',
    models: [],
    updatedAt: 0,
    ...over,
  };
}

describe('pickWebAdapter', () => {
  it('selects Anthropic for the real API host and any *.anthropic.com', () => {
    expect(pickWebAdapter('https://api.anthropic.com')).toBe(anthropicWebAdapter);
    expect(pickWebAdapter('https://api.anthropic.com/v1')).toBe(anthropicWebAdapter);
    expect(pickWebAdapter('https://gw.anthropic.com/v1')).toBe(anthropicWebAdapter);
  });

  it('selects Anthropic for an explicit /v1/messages path off-domain', () => {
    expect(pickWebAdapter('https://proxy.example.com/v1/messages')).toBe(anthropicWebAdapter);
  });

  it('selects Anthropic for a third-party Claude proxy pointed at the messages endpoint', () => {
    // The escape hatch for a Claude proxy on an ordinary host: point the base URL at
    // /v1/messages (or a bare /messages) to force the Anthropic wire format.
    expect(pickWebAdapter('https://api.justwoker.icu/v1/messages')).toBe(anthropicWebAdapter);
    expect(pickWebAdapter('https://api.justwoker.icu/messages')).toBe(anthropicWebAdapter);
    expect(pickWebAdapter('https://api.justwoker.icu/v1/messages/')).toBe(anthropicWebAdapter);
    // …but a bare host or a plain /v1 stays OpenAI-compatible (ambiguous → the common case).
    expect(pickWebAdapter('https://api.justwoker.icu/v1')).toBe(openAiWebAdapter);
  });

  it('keeps OpenAI for ordinary hosts and an unparseable URL', () => {
    expect(pickWebAdapter('https://api.openai.com/v1')).toBe(openAiWebAdapter);
    expect(pickWebAdapter('https://myproxy.dev/anthropic')).toBe(openAiWebAdapter);
    expect(pickWebAdapter('not a url')).toBe(openAiWebAdapter);
  });

  it('routes a bare claude-* model to Anthropic on a plain /v1 base (zero-config)', () => {
    // The real fix: the user's saved base URL is a plain `/v1` (or bare host) and the
    // model is `claude-opus-4-8`. The model id alone selects Anthropic, so chat POSTs to
    // /v1/messages (200) not /chat/completions (Cloudflare 403) — no URL editing needed.
    expect(pickWebAdapter('https://api.justwoker.icu/v1', 'claude-opus-4-8')).toBe(anthropicWebAdapter);
    expect(pickWebAdapter('https://api.justwoker.icu', 'claude-3-5-sonnet-20241022')).toBe(anthropicWebAdapter);
    // A non-Claude model on the same ambiguous host stays OpenAI-compatible.
    expect(pickWebAdapter('https://api.justwoker.icu/v1', 'gpt-4o')).toBe(openAiWebAdapter);
    // OpenRouter keeps its vendor prefix on Claude models → OpenAI-compatible (correct).
    expect(pickWebAdapter('https://openrouter.ai/api/v1', 'anthropic/claude-3.5-sonnet')).toBe(openAiWebAdapter);
    // No model → the bare host stays the OpenAI default.
    expect(pickWebAdapter('https://api.justwoker.icu/v1')).toBe(openAiWebAdapter);
  });
});

describe('looksLikeClaudeModel', () => {
  it('matches a bare claude-* id and rejects vendor-prefixed or non-Claude ids', () => {
    expect(looksLikeClaudeModel('claude-opus-4-8')).toBe(true);
    expect(looksLikeClaudeModel('claude-3-5-sonnet-20241022')).toBe(true);
    expect(looksLikeClaudeModel('Claude-Opus')).toBe(true);
    expect(looksLikeClaudeModel('  claude-opus-4-8  ')).toBe(true);
    expect(looksLikeClaudeModel('anthropic/claude-3.5-sonnet')).toBe(false);
    expect(looksLikeClaudeModel('gpt-4o')).toBe(false);
    expect(looksLikeClaudeModel('claudexyz')).toBe(false);
    expect(looksLikeClaudeModel('')).toBe(false);
    expect(looksLikeClaudeModel(undefined)).toBe(false);
    expect(looksLikeClaudeModel(null)).toBe(false);
  });
});

describe('openAiWebAdapter', () => {
  const a: WebWireAdapter = openAiWebAdapter;

  it('builds the chat URL, auth headers, and OpenAI body', () => {
    expect(a.upstreamUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions');
    expect(a.upstreamHeaders(cfg())).toEqual({ Authorization: 'Bearer secret' });
    expect(a.upstreamHeaders(cfg({ authSchema: 'header', authHeaderName: 'x-api-key' }))).toEqual({ 'x-api-key': 'secret' });
    expect(a.upstreamHeaders(cfg({ authSchema: 'none' }))).toEqual({});
    const msgs: WireMessage[] = [{ role: 'user', content: 'hi' }];
    expect(a.buildBody('gpt-4o', msgs, 1536)).toEqual({
      model: 'gpt-4o',
      stream: true,
      stream_options: { include_usage: true },
      messages: msgs,
      max_tokens: 1536,
    });
  });

  it('forwards reasoning_effort only when the caller opts in', () => {
    const msgs: WireMessage[] = [{ role: 'user', content: 'hi' }];
    // No effort → the body is byte-for-byte what the web chat has always sent.
    expect(a.buildBody('gpt-5', msgs, 1536).reasoning_effort).toBeUndefined();
    // An opted-in effort rides through as OpenAI's reasoning_effort field.
    expect(a.buildBody('gpt-5', msgs, 1536, 'high').reasoning_effort).toBe('high');
    expect(a.buildBody('gpt-5', msgs, 1536, 'low').reasoning_effort).toBe('low');
  });

  it('parses SSE deltas, the [DONE] sentinel, and buffered content', () => {
    expect(a.parseStreamLine('[DONE]')).toBe('');
    expect(a.parseStreamLine(JSON.stringify({ choices: [{ delta: { content: 'He' } }] }))).toBe('He');
    expect(a.parseStreamLine(JSON.stringify({ choices: [{ delta: {} }] }))).toBe('');
    expect(a.parseStreamLine('{bad json')).toBe('');
    expect(a.parseBuffered({ choices: [{ message: { content: 'full' } }] })).toBe('full');
    expect(a.parseBuffered(null)).toBe('');
  });
});

describe('anthropicWebAdapter', () => {
  const a: WebWireAdapter = anthropicWebAdapter;

  it('joins the messages path without doubling /v1', () => {
    expect(a.upstreamUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages');
    expect(a.upstreamUrl('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/messages');
    // A proxy base already spelling out the endpoint must not double the path.
    expect(a.upstreamUrl('https://api.justwoker.icu/v1/messages')).toBe('https://api.justwoker.icu/v1/messages');
    expect(a.upstreamUrl('https://api.justwoker.icu/messages')).toBe('https://api.justwoker.icu/v1/messages');
    // …and the models endpoint collapses to the same single /v1 root.
    expect(a.modelsUrl('https://api.justwoker.icu/v1/messages')).toBe('https://api.justwoker.icu/v1/models');
    expect(a.modelsUrl('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/models');
  });

  it('sends both required headers and never a bearer, whatever the schema says', () => {
    const headers = a.upstreamHeaders(cfg({ baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant' }));
    expect(headers['x-api-key']).toBe('sk-ant');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.Authorization).toBeUndefined();
  });

  it('hoists system turns and emits an Anthropic body (max_tokens, no reasoning_effort)', () => {
    const msgs: WireMessage[] = [
      { role: 'system', content: 'sys A' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'system', content: 'sys B' },
      { role: 'user', content: 'more' },
    ];
    const body = a.buildBody('claude-3-5-sonnet', msgs, 1536);
    expect(body.system).toBe('sys A\n\nsys B');
    expect(body.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'more' },
    ]);
    expect(body.max_tokens).toBe(1536);
    expect(body.stream).toBe(true);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('omits system when there are no system turns', () => {
    expect(a.buildBody('m', [{ role: 'user', content: 'hi' }], 1536).system).toBeUndefined();
  });

  it('ignores a reasoning effort — Anthropic uses a thinking budget, not this field', () => {
    const body = a.buildBody('claude-3-5-sonnet', [{ role: 'user', content: 'hi' }], 1536, 'high');
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('forwards only text_delta, dropping thinking/other events and bad JSON', () => {
    const textDelta = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } });
    const thinking = JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } });
    expect(a.parseStreamLine(textDelta)).toBe('Hi');
    expect(a.parseStreamLine(thinking)).toBe('');
    expect(a.parseStreamLine(JSON.stringify({ type: 'message_stop' }))).toBe('');
    expect(a.parseStreamLine(JSON.stringify({ type: 'error', error: { message: 'boom' } }))).toBe('');
    expect(a.parseStreamLine('{bad')).toBe('');
  });

  it('joins buffered content[] text blocks and ignores non-text bodies', () => {
    expect(
      a.parseBuffered({ content: [{ type: 'text', text: 'a' }, { type: 'thinking', text: 'x' }, { type: 'text', text: 'b' }] }),
    ).toBe('ab');
    expect(a.parseBuffered({ type: 'error', error: { message: 'bad' } })).toBe('');
    expect(a.parseBuffered(null)).toBe('');
  });
});
