/**
 * Request pacing + bounded retry for provider (model) calls.
 *
 * Two independent concerns, both about surviving a rate-limited or flaky
 * endpoint without losing the user's turn:
 *
 *  - **Pacing** ({@link pace}) — outbound model requests are spaced by at least
 *    {@link MIN_REQUEST_GAP_MS}. The gate is a serialized promise chain, so the
 *    orchestrator's parallel specialists (up to MAX_PARALLEL at once) can't all
 *    fire simultaneously and trip a per-minute quota; they queue and trickle.
 *
 *  - **Retry** ({@link withRetry}) — a *retryable* failure (429 / 408 / 5xx /
 *    timeout / connection reset) is retried up to {@link MAX_RETRY_ATTEMPTS}
 *    times, waiting {@link RETRY_DELAY_MS} between attempts. Auth errors, bad
 *    requests, and user aborts are NOT retried — they can't succeed by waiting.
 *
 * Streaming safety: a stream that already emitted content is never retried,
 * because replaying it would duplicate text the user has read. `canRetry` lets
 * the caller veto on exactly that condition, so in practice retries cover the
 * case that matters — the request rejected *before* the first token, which is
 * what a rate limit looks like.
 *
 * Pure timing + error classification; no Electron/provider imports, so it is
 * unit-testable in isolation.
 */

/**
 * Minimum gap between two outbound model requests. Deliberately modest: enough
 * to keep a burst of parallel specialists from hitting a per-second quota, small
 * enough that a normal think → act → think loop doesn't feel throttled.
 */
export const MIN_REQUEST_GAP_MS = 1_200

/**
 * The gap actually enforced by {@link pace}. Defaults to {@link MIN_REQUEST_GAP_MS}
 * in production, but starts at 0 under Vitest (which sets `process.env.VITEST`):
 * the suite fires many provider calls back-to-back under the default 5s per-test
 * timeout, and real 1.2s gaps would turn that into timeouts. Retry/backoff logic
 * is unaffected — only the inter-request spacing is zeroed. {@link __setRequestGap}
 * lets a test opt back into real pacing to exercise it directly.
 */
let requestGapMs = typeof process !== 'undefined' && process.env?.VITEST ? 0 : MIN_REQUEST_GAP_MS

/** Test seam: override the inter-request gap (0 disables pacing entirely). */
export function __setRequestGap(ms: number): void {
  requestGapMs = ms
}

/** How many times a retryable model request is re-attempted before giving up. */
export const MAX_RETRY_ATTEMPTS = 10

/**
 * Wait between retry attempts. One minute is long enough for a per-minute token
 * or request quota to roll over, which is the failure this exists for.
 */
export const RETRY_DELAY_MS = 60_000

/** Timestamp (ms) the last outbound request was released by {@link pace}. */
let lastRequestAt = 0

/** Serializes {@link pace} callers so the gap is enforced across concurrent agents. */
let paceChain: Promise<void> = Promise.resolve()

/** Test seam: forget the pacing history so a suite starts from a clean gate. */
export function __resetPacing(): void {
  lastRequestAt = 0
  paceChain = Promise.resolve()
}

/** Raised by {@link sleep} when the run is cancelled mid-wait. */
export class AbortError extends Error {
  constructor() {
    super('Aborted')
    this.name = 'AbortError'
  }
}

/** Abort-aware delay: rejects with {@link AbortError} if `signal` fires first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AbortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new AbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Waits until it is this caller's turn to issue a request AND at least
 * {@link MIN_REQUEST_GAP_MS} has passed since the previous one was released.
 * Callers are served in arrival order.
 */
export function pace(signal?: AbortSignal): Promise<void> {
  const turn = paceChain.then(async () => {
    const wait = lastRequestAt + requestGapMs - Date.now()
    if (wait > 0) await sleep(wait, signal)
    lastRequestAt = Date.now()
  })
  // The chain must survive a rejected turn (an aborted wait), or every later
  // caller would inherit that rejection and never get a slot.
  paceChain = turn.then(
    () => {},
    () => {}
  )
  return turn
}

/** True when the error is a user/run cancellation rather than a real failure. */
export function isAbort(err: unknown): boolean {
  if (err instanceof AbortError) return true
  const name = (err as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'CanceledError'
}

/**
 * Errors that another attempt could plausibly fix: rate limits (429), request
 * timeouts (408), transient upstream faults (5xx), and socket-level failures.
 * A 401/403 (bad key), 400 (bad request), or 404 (bad model) is permanent —
 * retrying it just burns ten minutes for the same error.
 */
export function isRetryable(err: unknown): boolean {
  if (isAbort(err)) return false
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase()
  // Permanent, even if the wording also matches a pattern below.
  if (/\b(401|403|404|400)\b/.test(text)) return false
  if (/\b(429|408|500|502|503|504|522|524)\b/.test(text)) return true
  return /rate.?limit|too many requests|overloaded|capacity|quota|timed out|timeout|econnreset|etimedout|econnrefused|enotfound|socket hang up|fetch failed|network|temporarily unavailable/.test(
    text
  )
}

/** What {@link withRetry} reports before each wait, for surfacing in the UI. */
export interface RetryNotice {
  /** 1-based attempt number that just failed. */
  attempt: number
  /** Total attempts allowed ({@link MAX_RETRY_ATTEMPTS}). */
  max: number
  /** How long we're about to wait before the next attempt. */
  delayMs: number
  /** Why it failed (the provider's message, trimmed for display). */
  reason: string
}

export interface RetryOptions {
  /** Cancels both the in-flight attempt and any pending wait. */
  signal?: AbortSignal
  /** Called once per failure, just before the wait; drives the UI notice. */
  onRetry?: (notice: RetryNotice) => void
  /**
   * Vetoes a retry the caller knows is unsafe — used by streaming callers to
   * refuse a replay once content has already reached the user. Defaults to
   * "always safe".
   */
  canRetry?: () => boolean
  /** Override the attempt budget (tests). */
  attempts?: number
  /** Override the inter-attempt wait (tests). */
  delayMs?: number
}

/**
 * Runs `fn`, paced and retried. Returns its value, or throws the LAST error once
 * the budget is exhausted / the failure is permanent / a retry was vetoed — so
 * the caller's existing error handling still reports something accurate.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    signal,
    onRetry,
    canRetry,
    attempts = MAX_RETRY_ATTEMPTS,
    delayMs = RETRY_DELAY_MS
  } = options

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new AbortError()
    await pace(signal)
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const isLast = attempt >= attempts
      if (isAbort(err) || !isRetryable(err) || isLast || canRetry?.() === false) throw err
      onRetry?.({
        attempt,
        max: attempts,
        delayMs,
        reason: (err instanceof Error ? err.message : String(err)).slice(0, 160)
      })
      await sleep(delayMs, signal)
    }
  }
  // Unreachable (the loop either returns or throws), but keeps the type honest.
  throw lastError
}
