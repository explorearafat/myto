// The browser side of the chat: POST the conversation to our own /api/chat and read the SSE
// protocol the gateway emits (`{t:'token'|'done'|'error'}`). Keys and upstream URLs live only on
// the server; this file only ever talks to the same-origin gateway.

export interface ChatWireMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamHandlers {
  onToken: (chunk: string) => void;
  onDone: (usage?: number) => void;
  /** code is 'quota' | 'upstream' | 'network'; info.resetSeconds is set for quota. */
  onError: (code: string, info?: { resetSeconds?: number }) => void;
}

export interface StreamOptions extends StreamHandlers {
  model: string;
  messages: ChatWireMessage[];
  signal?: AbortSignal;
}

export async function streamChat(opts: StreamOptions): Promise<void> {
  const { model, messages, signal, onToken, onDone, onError } = opts;

  let res: Response;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages }),
      signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return;
    onError('network');
    return;
  }

  if (res.status === 429) {
    const j = (await res.json().catch(() => ({}))) as { resetSeconds?: number };
    onError('quota', { resetSeconds: j.resetSeconds });
    return;
  }
  if (!res.ok || !res.body) {
    onError('upstream');
    return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!raw.startsWith('data:')) continue;
        const line = raw.slice(5).trim();
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as {
            t: 'token' | 'done' | 'error';
            v?: string;
            usage?: number;
            code?: string;
            resetSeconds?: number;
          };
          if (ev.t === 'token' && ev.v) onToken(ev.v);
          else if (ev.t === 'done') {
            onDone(ev.usage);
            return;
          } else if (ev.t === 'error') {
            onError(ev.code || 'upstream', { resetSeconds: ev.resetSeconds });
            return;
          }
        } catch {
          // Ignore a malformed event; keep reading.
        }
      }
    }
    onDone();
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return;
    onError('network');
  }
}
