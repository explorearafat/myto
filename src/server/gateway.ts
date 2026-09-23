// The chat gateway: a runtime-agnostic Web handler (Request -> Response) so the exact same code
// runs as a Vercel Edge function (api/chat.ts) and inside the Vite dev middleware. It is a thin,
// credential-passing PROXY: the browser and the mobile app can't call an arbitrary OpenAI-compatible
// endpoint directly (browser CORS; and keeping one place to run the tool loop), so they POST their
// own bring-your-own-key config — { baseUrl, apiKey, authSchema, authHeaderName, model, messages } —
// and this handler streams the upstream reply back as a tiny SSE protocol:
// `data: {"t":"token","v":"…"}`, then `{"t":"done"}`, or `{"t":"error",…}`.
//
// Security posture: the credentials come from the caller, not the server — there is no server-held
// secret to leak. The one risk this adds is SSRF (a same-origin caller pointing us at an internal
// host), so we require https and refuse private/loopback/metadata hosts via isBlockedHost. The
// same-origin guard blocks cross-site browser abuse. It can still reach arbitrary *public* HTTPS
// hosts on the caller's behalf — inherent to a BYOK proxy.

import { isBlockedHost } from './tools';
import {
  createToolCallParser,
  runTool,
  toolResultBlock,
  toolsEnabled,
  toolsSystemPrompt,
  type ToolCall,
  type ToolCallParser,
} from './tools';
import { normalizeByokConfig, type ByokConfig } from '../shared/byok';
import { pickWebAdapter, type WebWireAdapter } from './adapters';

export interface WireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Hard ceiling on model turns per reply. Each turn is a full upstream generation plus (usually) one
// tool fetch, and this runs on Edge with a wall-clock budget, so keep it small: up to two tool
// calls then a forced final answer. Also guarantees the agentic loop always terminates.
const MAX_TOOL_TURNS = 3;

const MAX_MESSAGES = 24;
const MAX_CHARS = 8000;
const MAX_OUTPUT_TOKENS = Number(process.env.SYLOR_MAX_OUTPUT_TOKENS || 1536);

function json(status: number, body: unknown, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(extra || {}) },
  });
}

// Cheap CSRF/abuse guard: reject an explicit cross-origin POST. A same-origin fetch either omits
// Origin or matches the request host; a native app (curl, the mobile client) sends no Origin and is
// allowed (it can't ride a user's cookie, and it carries its own credentials).
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

// Trust nothing from the client but user/assistant turns of bounded size; a client-supplied
// system role is folded to user so the caller can't inject a privileged instruction.
function sanitizeMessages(input: unknown): WireMessage[] {
  if (!Array.isArray(input)) return [];
  const out: WireMessage[] = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || typeof m.content !== 'string') continue;
    const role: WireMessage['role'] = m.role === 'assistant' ? 'assistant' : 'user';
    const content = m.content.slice(0, MAX_CHARS).trim();
    if (content) out.push({ role, content });
  }
  return out;
}

// Open the upstream stream against the caller's own endpoint. The adapter supplies the format's URL,
// auth headers, and request body; everything else (Accept, failure handling) is provider-agnostic.
// There is a single endpoint, so there is no failover; a non-OK status or a transport error simply
// surfaces as an in-stream error.
async function openUpstream(
  cfg: ByokConfig,
  model: string,
  messages: WireMessage[],
  adapter: WebWireAdapter,
): Promise<Response | null> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(adapter.upstreamUrl(base), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Accept: 'text/event-stream',
        ...adapter.upstreamHeaders(cfg),
      },
      body: JSON.stringify(adapter.buildBody(model, messages, MAX_OUTPUT_TOKENS)),
    });
    if (res.ok && res.body) return res;
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
  } catch {
    // Network/timeout — nothing to fail over to with a single endpoint.
  }
  return null;
}

// Consume one upstream reply, forwarding visible text as `token` events. When `parser` is set it
// also watches for a tool-call fence, holding that block back and returning the parsed call so the
// loop can run it (the block itself is written to the reply by the loop, not here). Returns the
// visible text and the call (if any). Does NOT send `done`.
async function readTurn(
  upstream: Response,
  send: (obj: unknown) => void,
  parser: ToolCallParser | null,
  adapter: WebWireAdapter,
): Promise<{ visible: string; call: ToolCall | null }> {
  let visible = '';
  let call: ToolCall | null = null;

  const emit = (text: string): void => {
    if (!text || call) return; // once a call is found, ignore the tail
    if (parser) {
      const r = parser.push(text);
      if (r.text) {
        visible += r.text;
        send({ t: 'token', v: r.text });
      }
      if (r.call && !call) call = r.call;
    } else {
      visible += text;
      send({ t: 'token', v: text });
    }
  };

  const ct = upstream.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    // Buffered fallback: the gateway ignored `stream:true` and answered with one JSON blob.
    const data = await upstream.json().catch(() => null);
    emit(adapter.parseBuffered(data));
  } else {
    const reader = upstream.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const text = adapter.parseStreamLine(line.slice(5).trim());
        if (text) emit(text);
      }
      if (call) {
        // A complete tool call arrived — stop this turn early and hand back to the loop.
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
  }

  if (parser && !call) {
    const tail = parser.flush();
    if (tail) {
      visible += tail;
      send({ t: 'token', v: tail });
    }
  }
  return { visible, call };
}

// The bounded agentic loop, run inside the streamed Response. Each turn opens an upstream, streams
// its visible text, and — while tools are on and we haven't hit the last turn — runs any tool the
// model calls, writing the call + result blocks into the reply so both clients render a card, then
// re-prompts. Tool blocks ride the existing `token` protocol, so the client SSE contract is unchanged.
function buildAgentStream(
  base: WireMessage[],
  cfg: ByokConfig,
  model: string,
  toolsOn: boolean,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const abort = new AbortController();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      // Auto-detect the wire format once per reply from the caller's base URL.
      const adapter = pickWebAdapter(cfg.baseUrl);
      const messages: WireMessage[] = [...base];
      let errored = false;
      try {
        for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
          const isLast = turn === MAX_TOOL_TURNS - 1;
          if (toolsOn && isLast) {
            messages.push({
              role: 'system',
              content: 'Answer the user now using what you already have. Do not call any more tools.',
            });
          }
          const upstream = await openUpstream(cfg, model, messages, adapter);
          if (!upstream) {
            send({ t: 'error', code: 'upstream' });
            errored = true;
            break;
          }
          const parser = toolsOn && !isLast ? createToolCallParser() : null;
          const { visible, call } = await readTurn(upstream, send, parser, adapter);
          if (!call) break; // the model wrote its final answer

          const name = call.name ?? 'tool';
          send({ t: 'token', v: `\n${call.block}\n` });
          const result = await runTool(call, abort.signal);
          send({ t: 'token', v: toolResultBlock(name, result) });
          messages.push({
            role: 'assistant',
            content: (visible.trimEnd() ? `${visible.trimEnd()}\n` : '') + call.block,
          });
          messages.push({
            role: 'user',
            content: `Tool result for ${name}:\n${result}\n\nUse this to answer the user's request, or call another tool if you still need more. Do not repeat an identical call.`,
          });
        }
        if (!errored) send({ t: 'done' });
        controller.close();
      } catch {
        try {
          send({ t: 'error', code: 'upstream' });
        } catch {
          /* controller may already be closed */
        }
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });
}

export async function handleChat(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!sameOrigin(req)) return json(403, { error: 'forbidden' });

  let payload: { model?: unknown; messages?: unknown } & Partial<ByokConfig>;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: 'bad_json' });
  }

  const history = sanitizeMessages(payload.messages);
  if (history.length === 0) return json(400, { error: 'no_messages' });

  // The caller supplies its own endpoint + key + model (bring-your-own-key).
  const cfg = normalizeByokConfig(payload);
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  if (!cfg.baseUrl || !model) return json(400, { error: 'no_config' });

  // SSRF guard: only public HTTPS endpoints — no loopback/private/metadata hosts.
  let host: string;
  try {
    const u = new URL(cfg.baseUrl);
    if (u.protocol !== 'https:') return json(400, { error: 'bad_base_url' });
    host = u.hostname;
  } catch {
    return json(400, { error: 'bad_base_url' });
  }
  if (isBlockedHost(host)) return json(400, { error: 'bad_base_url' });

  const toolsOn = toolsEnabled();
  const messages: WireMessage[] = [
    ...(toolsOn ? [{ role: 'system' as const, content: toolsSystemPrompt() }] : []),
    ...history,
  ];

  const stream = buildAgentStream(messages, cfg, model, toolsOn);

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
