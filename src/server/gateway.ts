// The chat gateway: a runtime-agnostic Web handler (Request -> Response) so the exact same code
// runs as a Vercel Edge function (api/chat.ts) and inside the Vite dev middleware. It holds the
// upstream keys (server-only, from env), enforces the per-user quota, fails a request over across
// a pool of (model, key) combinations, and streams the reply back to the browser as a tiny SSE
// protocol: `data: {"t":"token","v":"…"}`, then `{"t":"done","usage":N}`, or `{"t":"error",…}`.

import { isOraculumModel, DEFAULT_MODEL_ID } from '../shared/models';
import { resolveIdentity } from './userId';
import { checkBudget, charge } from './ratelimit';

export interface WireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// The upstream models are branded away behind the two Oraculum ids; both facades draw on this
// same pool, tried in order with key rotation until one answers.
const DEFAULT_MODELS = 'hy3,mimo-v2.5,glm-5.3-flash,qwen3.8-flash';

const PERSONA =
  'You are Oraculum, the assistant on the website for Sylor — a local-first AI coding workspace. ' +
  'Be concise, warm, and genuinely helpful, and use Markdown when it aids clarity. When asked ' +
  'about Sylor: it reads your project, shows every edit as a diff you approve before it touches ' +
  'disk, and runs your build to verify its own work. It runs any local Ollama model or any ' +
  'OpenAI-compatible endpoint, and includes the Sylorium browser, sub-agents, hooks, scheduled ' +
  'tasks, SYLOR.md project memory, and a headless CLI. Windows is available today; macOS and ' +
  'Linux are planned. The app is free — you only pay whatever model provider you choose.';

const MAX_MESSAGES = 24;
const MAX_CHARS = 8000;

function env() {
  const base = (process.env.B_AI_BASE_URL || 'https://api.b.ai/v1/').replace(/\/+$/, '');
  const keys = (process.env.B_AI_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const models = (process.env.B_AI_MODELS || DEFAULT_MODELS)
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const maxTokens = Number(process.env.SYLOR_MAX_OUTPUT_TOKENS || 1536);
  return { base, keys, models, maxTokens };
}

function json(status: number, body: unknown, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(extra || {}) },
  });
}

// Cheap CSRF/abuse guard: reject an explicit cross-origin POST. A same-origin fetch either omits
// Origin or matches the request host; curl without Origin is allowed (it can't ride a user's cookie).
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
// system role is folded to user so the persona can't be overridden.
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

// A capped, key-rotated list of (model, key) attempts: each model paired with up to two keys,
// starting from a random key so load spreads across the pool.
function buildAttempts(models: string[], keys: string[]): { model: string; key: string }[] {
  const start = Math.floor(Math.random() * keys.length);
  const cap = Math.min(6, models.length * keys.length);
  const out: { model: string; key: string }[] = [];
  for (let i = 0; i < models.length && out.length < cap; i++) {
    for (let j = 0; j < Math.min(2, keys.length) && out.length < cap; j++) {
      out.push({ model: models[i], key: keys[(start + i + j) % keys.length] });
    }
  }
  return out;
}

// 400/422 mean the request body itself is wrong — retrying other combos won't help.
function isFatalStatus(s: number): boolean {
  return s === 400 || s === 422;
}

// Open an upstream stream, failing over across the pool. Failover happens BEFORE we hand a
// Response to the client, so once we return an upstream we never silently switch mid-stream.
async function openUpstream(messages: WireMessage[]): Promise<Response | null> {
  const { base, keys, models, maxTokens } = env();
  if (keys.length === 0) return null;

  for (const { model, key } of buildAttempts(models, keys)) {
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          messages,
          max_tokens: maxTokens,
        }),
      });
      if (res.ok && res.body) return res;
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      if (isFatalStatus(res.status)) break;
    } catch {
      // Network/timeout — try the next combination.
    }
  }
  return null;
}

// Re-emit the upstream reply as our own SSE protocol while metering tokens. Charging happens
// before we close, so the Edge function isn't torn down mid-charge.
function buildClientStream(
  upstream: Response,
  uid: string,
  inputChars: number,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      let outChars = 0;
      let usage = 0;
      try {
        const ct = upstream.headers.get('content-type') || '';
        if (!ct.includes('text/event-stream')) {
          // Buffered fallback: the whole JSON body, emitted as one token.
          const data = (await upstream.json().catch(() => null)) as {
            choices?: { message?: { content?: string } }[];
            usage?: { total_tokens?: number };
          } | null;
          const text = data?.choices?.[0]?.message?.content ?? '';
          if (text) {
            send({ t: 'token', v: text });
            outChars += text.length;
          }
          usage = Number(data?.usage?.total_tokens) || 0;
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
              const data = line.slice(5).trim();
              if (data === '[DONE]') continue;
              try {
                const j = JSON.parse(data) as {
                  choices?: { delta?: { content?: string } }[];
                  usage?: { total_tokens?: number };
                };
                const delta = j?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string' && delta) {
                  send({ t: 'token', v: delta });
                  outChars += delta.length;
                }
                const u = j?.usage?.total_tokens;
                if (typeof u === 'number') usage = u;
              } catch {
                // Partial JSON across chunks — the remainder stays buffered for the next read.
              }
            }
          }
        }
        const billed = usage > 0 ? usage : Math.ceil((inputChars + outChars) / 4);
        await charge(uid, billed);
        send({ t: 'done', usage: billed });
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
      try {
        upstream.body?.cancel();
      } catch {
        /* ignore */
      }
    },
  });
}

export async function handleChat(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!sameOrigin(req)) return json(403, { error: 'forbidden' });

  let payload: { model?: unknown; messages?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: 'bad_json' });
  }

  // The model is a facade; validate it but the pool is the same for both.
  const _modelId = isOraculumModel(payload.model) ? payload.model : DEFAULT_MODEL_ID;
  const history = sanitizeMessages(payload.messages);
  if (history.length === 0) return json(400, { error: 'no_messages' });

  const { uid, setCookie } = resolveIdentity(req);
  const cookieHeader = setCookie ? { 'set-cookie': setCookie } : undefined;

  const budget = await checkBudget(uid);
  if (budget.blocked) {
    return json(
      429,
      { error: 'quota', resetSeconds: budget.resetSeconds, limit: budget.limit },
      cookieHeader,
    );
  }

  const messages: WireMessage[] = [{ role: 'system', content: PERSONA }, ...history];
  const upstream = await openUpstream(messages);
  if (!upstream) return json(502, { error: 'upstream' }, cookieHeader);

  const inputChars = messages.reduce((n, m) => n + m.content.length, 0);
  const stream = buildClientStream(upstream, uid, inputChars);

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      ...(cookieHeader || {}),
    },
  });
}
