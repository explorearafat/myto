// Per-user token quota over a rolling window, backed by Upstash Redis via its REST API (plain
// fetch — no SDK, so this runs unchanged on Vercel Edge, in the Vite dev middleware, and under
// tsc). Each user's usage is a sorted set keyed by timestamp; we prune anything older than the
// window, sum the tokens still inside it, and charge new usage after each reply. When Upstash
// credentials are absent (local dev) every call degrades to "unlimited" so the UI still works.

export interface Budget {
  used: number;
  remaining: number;
  limit: number;
  /** Seconds until the oldest in-window usage falls off (enough for the user to see "resets in"). */
  resetSeconds: number;
  blocked: boolean;
}

function cfg() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
    limit: Number(process.env.SYLOR_TOKEN_BUDGET || 300000),
    windowSeconds: Number(process.env.SYLOR_WINDOW_SECONDS || 18000), // 5 hours
  };
}

async function pipeline(
  url: string,
  token: string,
  commands: (string | number)[][],
): Promise<Array<{ result?: unknown; error?: string }>> {
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  return (await res.json()) as Array<{ result?: unknown; error?: string }>;
}

export async function checkBudget(uid: string): Promise<Budget> {
  const { url, token, limit, windowSeconds } = cfg();
  if (!url || !token) return { used: 0, remaining: limit, limit, resetSeconds: 0, blocked: false };

  const key = `sylor:usage:${uid}`;
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;
  try {
    const out = await pipeline(url, token, [
      ['ZREMRANGEBYSCORE', key, '-inf', cutoff],
      ['ZRANGE', key, '0', '-1', 'WITHSCORES'],
    ]);
    // WITHSCORES returns a flat [member, score, member, score, ...] array of strings.
    const arr = Array.isArray(out[1]?.result) ? (out[1].result as string[]) : [];
    let used = 0;
    let minTs = now;
    for (let i = 0; i < arr.length; i += 2) {
      const tok = Number(String(arr[i]).split(':')[1] || 0);
      const score = Number(arr[i + 1]);
      used += Number.isFinite(tok) ? tok : 0;
      if (Number.isFinite(score) && score < minTs) minTs = score;
    }
    const remaining = Math.max(0, limit - used);
    const resetSeconds =
      used > 0 ? Math.max(1, Math.ceil((minTs + windowSeconds * 1000 - now) / 1000)) : 0;
    return { used, remaining, limit, resetSeconds, blocked: remaining <= 0 };
  } catch {
    // Fail open: an infra hiccup in the quota store should not take the chat down.
    return { used: 0, remaining: limit, limit, resetSeconds: 0, blocked: false };
  }
}

export async function charge(uid: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  const { url, token, windowSeconds } = cfg();
  if (!url || !token) return;

  const key = `sylor:usage:${uid}`;
  const now = Date.now();
  const member = `${now}-${Math.random().toString(36).slice(2, 8)}:${Math.round(tokens)}`;
  try {
    await pipeline(url, token, [
      ['ZADD', key, now, member],
      ['EXPIRE', key, windowSeconds],
    ]);
  } catch {
    // Best-effort metering — never fail a reply because charging didn't land.
  }
}
