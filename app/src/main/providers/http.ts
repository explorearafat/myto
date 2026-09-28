export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Request timed out after ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

/**
 * Raised when a response *started* arriving and then went quiet for longer than
 * the no-progress window. Distinct from {@link TimeoutError} because the cure is
 * different: a stall means the connection is alive but the generation died
 * upstream, so there is nothing to wait for.
 */
export class StallError extends Error {
  constructor(ms: number) {
    super(
      `The model stopped responding — the stream stalled with no new data for ${Math.round(
        ms / 1000
      )}s. It may have hit an output limit or dropped upstream. Use Rewrite (↻) below to try again.`
    )
    this.name = 'StallError'
  }
}
/** Numeric HTTP status tagged onto a provider error by the gateway/ollama throw. */
export function httpStatusOf(err: unknown): number | undefined {
  const s = (err as { httpStatus?: unknown } | null)?.httpStatus
  return typeof s === 'number' ? s : undefined
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof TimeoutError || err instanceof StallError) return err.message
  if (err instanceof Error) {
    // A rate-limit is the single most common free-tier failure; the raw "HTTP 429
    // Too Many Requests" is opaque, so spell out the cause and the two ways out.
    if (httpStatusOf(err) === 429)
      return 'The model endpoint is rate-limiting requests (HTTP 429). Free-tier models cap how many requests you can make per minute — wait a few seconds, then use Rewrite (↻) below to try again, or switch to a different model on the Myto website → Authentication page.'
    const cause = (err as { cause?: { code?: string } }).cause
    if (cause?.code === 'ECONNREFUSED') return 'Connection refused — is the server running?'
    if (cause?.code === 'ENOTFOUND') return 'Host not found — check the Base URL.'
    if (cause?.code === 'ECONNRESET') return 'Connection reset by the server.'
    return err.message
  }
  return String(err)
}

/** Longest a rate-limit / transient failure is retried before giving up. */
export const MAX_RATE_LIMIT_RETRIES = 3
/** Cap on any single backoff wait, so a hostile Retry-After can't freeze the turn. */
export const MAX_RETRY_WAIT_MS = 30_000

/** Statuses worth retrying: 429 rate-limit + transient upstream 5xx (incl. Anthropic 529). */
function isRetryableStatus(status: number | undefined): boolean {
  return (
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 529
  )
}

/**
 * Decide whether a failed generation attempt should be retried and, if so, how long
 * to wait first — returns the delay in ms, or `null` to stop.
 *
 * Retries only rate-limit (429) and transient upstream (502/503/504/529) failures — the
 * symptoms of a busy free-tier endpoint or an overloaded Anthropic backend (529) — and only up to `maxRetries` times. Honours a
 * server `Retry-After` (surfaced as `retryAfterMs`) when present, capped at
 * {@link MAX_RETRY_WAIT_MS}; otherwise backs off exponentially (1s, 2s, 4s…) with a
 * little jitter so many clients rate-limited at once don't resynchronise their retries.
 * `attempt` is 0-based (0 on the first failure). Safe to retry only when the caller has
 * emitted nothing yet — these errors all throw at the headers stage, before any token.
 */
export function rateLimitRetryDelay(
  err: unknown,
  attempt: number,
  maxRetries = MAX_RATE_LIMIT_RETRIES
): number | null {
  if (attempt >= maxRetries) return null
  if (!isRetryableStatus(httpStatusOf(err))) return null
  const retryAfterMs = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs
  if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) return Math.min(retryAfterMs, MAX_RETRY_WAIT_MS)
  const backoff = Math.min(1000 * 2 ** attempt, MAX_RETRY_WAIT_MS)
  return backoff + Math.floor(Math.random() * 250)
}

/** Auth failures — the fallback shares the same credentials, so a switch can't help. */
function isAuthStatus(status: number | undefined): boolean {
  return status === 401 || status === 403
}

/**
 * Decide whether an exhausted (or non-retryable) *pristine* generation failure should
 * fail over to a configured second model — the piece {@link rateLimitRetryDelay} does
 * not cover. Retry re-issues the *same* request; failover switches the model instead,
 * for when the primary is down, gone (404 model-not-found), or persistently overloaded
 * after its retries ran out. Kept deliberately narrow and one-shot:
 *
 * - **Pristine only.** A mid-stream failure already emitted tokens; switching models
 *   would replay them, so we never fail over once output has begun (mirrors the retry rule).
 * - **Once per turn.** `triedFallback` guards against a fallback that itself fails looping.
 * - **A real, different target.** Empty or primary-equal `fallbackModel` is a no-op.
 * - **Not on auth errors.** 401/403 mean bad credentials; the fallback shares them, so
 *   a switch just burns a second doomed request.
 *
 * Returns the trimmed fallback model id to switch to, or `null` to surface the error.
 * The caller gives the fallback its own fresh retry budget.
 */
export function planFailover(opts: {
  pristine: boolean
  err: unknown
  fallbackModel: string | undefined
  activeModel: string
  triedFallback: boolean
}): string | null {
  const { pristine, err, fallbackModel, activeModel, triedFallback } = opts
  if (!pristine || triedFallback) return null
  const fb = fallbackModel?.trim()
  if (!fb || fb === activeModel.trim()) return null
  if (isAuthStatus(httpStatusOf(err))) return null
  return fb
}

export function normaliseBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/**
 * Headers deadline for a model generation call (see {@link FetchOptions.timeoutMs}).
 *
 * Ten minutes, not two. `fetch` resolves at the status line, so for a
 * `stream:false` request — and for the many gateways that ignore `stream:true`
 * and answer with one buffered JSON blob — this number *is* the whole-generation
 * budget. A large plan or a whole-file write at high reasoning effort routinely
 * needs several minutes; the old 120s ceiling cut those off and, because the
 * failure looks like a timeout, sent the retry loop off to replay an identical
 * request against the identical clock.
 *
 * A generous ceiling is safe because it is not the only guard: a user Stop
 * aborts immediately, a streaming body is watched by {@link stallGuard}, and a
 * genuinely dead endpoint fails at the TCP layer long before this.
 */
export const COMPLETION_TIMEOUT_MS = 600_000

/**
 * No-progress window for a streaming response body. Sixty seconds of total
 * silence *after* tokens started flowing means the generation died upstream;
 * waiting longer only leaves the app looking frozen with no way to tell whether
 * it is still working. Reset by every non-empty `data:` frame, so a long-but-
 * alive stream is never cut off — only a genuinely silent one is aborted.
 *
 * Kept in step with the renderer's alarm threshold
 * (`renderer/src/lib/liveness.ts` STALL_ALARM_MS = 60s): the amber "may have
 * stalled" note and the automatic stop land at the same moment, so a hung model
 * stream ends itself (→ StallError + Rewrite) instead of hanging indefinitely.
 * Long-running *tools* are not covered here (they have no active stream); they
 * enforce their own deadlines (COMMAND_TIMEOUT_MS / GIT_TIMEOUT_MS).
 */
export const STREAM_STALL_MS = 60_000

interface FetchOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: unknown
  /**
   * Deadline for the response **headers** to arrive — not for the whole body.
   * `fetch` resolves as soon as the status line lands, so this is time-to-first-
   * byte for a streaming call and (because the body then arrives in one go)
   * effectively the whole-generation budget for a `stream:false` call. Size it
   * accordingly at the call site; a streaming body is watched by
   * {@link stallGuard} instead.
   */
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * A no-progress watchdog for a response body.
 *
 * `httpFetch`'s `timeoutMs` can only cover the headers — once `fetch` resolves,
 * the timer is gone and a body that stops mid-stream would hang forever. A guard
 * fixes that without needing a total deadline (which would kill a legitimately
 * long generation): the clock is reset by every chunk, so a stream that keeps
 * producing tokens can run for an hour, while one that goes silent fails in
 * `idleMs`.
 *
 * The guard's `signal` is what gets handed to {@link httpFetch}, so firing it
 * aborts the in-flight read; `expired` then tells the caller to report a
 * {@link StallError} rather than a plain cancellation.
 *
 * @param idleMs  Longest silence tolerated. `0` disables the guard entirely.
 * @param outer   The caller's cancellation signal, chained in so a user Stop
 *                still aborts the request.
 */
export interface StallGuard {
  /** Pass to {@link httpFetch}; aborts on stall or on the outer signal. */
  readonly signal: AbortSignal
  /** Call on every byte of progress — re-arms the clock. */
  touch(): void
  /** Stop watching (normal end, or an error we're already reporting). */
  stop(): void
  /** True once the guard itself fired, as opposed to the outer signal. */
  readonly expired: boolean
}
export function stallGuard(idleMs: number, outer?: AbortSignal): StallGuard {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false

  const stop = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const touch = (): void => {
    if (idleMs <= 0 || controller.signal.aborted) return
    stop()
    timer = setTimeout(() => {
      expired = true
      controller.abort(new StallError(idleMs))
    }, idleMs)
  }

  if (outer) {
    if (outer.aborted) controller.abort()
    else
      outer.addEventListener(
        'abort',
        () => {
          stop()
          controller.abort()
        },
        { once: true }
      )
  }

  return {
    signal: controller.signal,
    touch,
    stop,
    get expired() {
      return expired
    }
  }
}

/**
 * A browser-like User-Agent for every provider request. Node/Electron's `fetch`
 * (undici) sends NO `User-Agent` by default, and a growing number of BYOK endpoints
 * — especially third-party Claude proxies — sit behind Cloudflare's bot-fight, which
 * treats a UA-less request as a bot and answers with an HTML 403 challenge instead of
 * the API. That is the exact "blocked by Cloudflare" failure users hit on stricter
 * proxies while the same key works in a desktop client that does send a UA. A real UA
 * clears the naive check; mirrors the browser UA the web-search path already uses
 * (main/tools/web.ts) for the same reason. Callers can still override it.
 */
const PROVIDER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export async function httpFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const { method = 'GET', headers = {}, body, timeoutMs = 15_000, signal } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new TimeoutError(timeoutMs)), timeoutMs)
  if (signal) {
    // Forward the reason too, so a caller-side deadline (see {@link stallGuard})
    // is still recognisable as a timeout rather than a bare cancellation.
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }

  try {
    // A string body is sent verbatim (the caller pre-encoded it and sets its own
    // content-type, e.g. a form POST); any other value is JSON-encoded and gets the
    // JSON content-type unless the caller overrode it. The UA is a default the caller
    // can also override; both sit before `...headers` so an explicit value wins.
    const rawBody = typeof body === 'string'
    const defaults: Record<string, string> = { 'User-Agent': PROVIDER_UA }
    if (body != null && !rawBody) defaults['content-type'] = 'application/json'
    return await fetch(url, {
      method,
      headers: { ...defaults, ...headers },
      body: body == null ? undefined : rawBody ? (body as string) : JSON.stringify(body),
      signal: controller.signal
    })
  } catch (err) {
    const reason: unknown = controller.signal.reason
    if (reason instanceof TimeoutError || reason instanceof StallError) throw reason
    throw err
  } finally {
    clearTimeout(timer)
  }
}
export async function httpJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const res = await httpFetch(url, options)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`)
  }
  return (await res.json()) as T
}
