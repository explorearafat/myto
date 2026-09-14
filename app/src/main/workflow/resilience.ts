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
 *  - **Retry** ({@link withRetry}) — a *retryable* failure is re-attempted, with
 *    the budget chosen by WHY it failed (see {@link classifyFailure}). Auth
 *    errors, bad requests, and user aborts are NOT retried — they can't succeed
 *    by waiting.
 *
 *    The two retryable kinds are deliberately treated differently, because only
 *    one of them is fixed by waiting:
 *
 *      * `transient` (429 / 5xx / connection reset) — the request was *rejected*.
 *        An identical replay a minute later is exactly the right move: a
 *        per-minute quota rolls over, an overloaded upstream recovers. Budget:
 *        {@link MAX_RETRY_ATTEMPTS} attempts, {@link RETRY_DELAY_MS} apart.
 *
 *      * `timeout` (client-side deadline, 408 / 504 / 524) — the request was
 *        *accepted* and simply took longer than the deadline. Nothing about the
 *        request changed, so replaying it identically will overwhelmingly hit the
 *        same wall; ten attempts a minute apart burn half an hour to arrive at
 *        the same error. There is no quota to roll over either, so the long wait
 *        buys nothing. Budget: {@link MAX_TIMEOUT_RETRY_ATTEMPTS} attempts,
 *        {@link TIMEOUT_RETRY_DELAY_MS} apart — one quick second chance for a
 *        genuinely unlucky first attempt (a cold start, a queued request), then
 *        an honest failure the caller can report.
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
 * Token-bucket rate limit for outbound model requests (Principle 6 #3). Specified
 * as an approximate requests-per-minute budget; the bucket refills at this rate
 * and each request consumes one token. A burst of parallel specialists (up to 3)
 * can fire immediately if tokens are available; when empty, callers queue and
 * trickle as tokens refill. Conservative default (30/min = one every 2s) keeps a
 * sustained workload under typical quotas without pre-emptive waits.
 */
export const DEFAULT_REQUESTS_PER_MINUTE = 30

/**
 * The bucket's capacity (max tokens). Set to the per-minute budget so a cold
 * start can fire {@link DEFAULT_REQUESTS_PER_MINUTE} requests immediately, then
 * the refill rate takes over. Prevents a long idle from banking tokens that would
 * let a burst exceed the stated rate.
 */
const BUCKET_CAPACITY = DEFAULT_REQUESTS_PER_MINUTE

/**
 * Current pacing budget (requests per minute). Defaults to
 * {@link DEFAULT_REQUESTS_PER_MINUTE} in production, but starts at Infinity under
 * Vitest (which sets `process.env.VITEST`): the suite fires many provider calls
 * back-to-back under the default 5s per-test timeout, and real rate-limiting
 * would turn that into timeouts. Retry/backoff logic is unaffected — only the
 * bucket is disabled. {@link __setRequestsPerMinute} lets a test opt back into
 * real pacing to exercise it directly.
 */
let requestsPerMinute =
  typeof process !== 'undefined' && process.env?.VITEST ? Infinity : DEFAULT_REQUESTS_PER_MINUTE

/** Test seam: override the pacing budget (Infinity disables pacing entirely). */
export function __setRequestsPerMinute(rpm: number): void {
  requestsPerMinute = rpm
  // Reset the bucket so the new rate takes effect immediately.
  bucketTokens = Math.min(BUCKET_CAPACITY, rpm)
  lastRefillAt = Date.now()
}

/** How many times a *transient* (rejected) model request is re-attempted. */
export const MAX_RETRY_ATTEMPTS = 10

/**
 * Base delay for exponential backoff (Principle 6). First retry waits ~1s (with
 * jitter), second ~2s, third ~4s, etc., capped at {@link RETRY_DELAY_CAP_MS}.
 * Full jitter breaks lockstep and makes early attempts fast.
 */
export const RETRY_DELAY_BASE_MS = 1_000

/**
 * Cap for exponential backoff. One minute is long enough for a per-minute quota
 * to roll over; longer waits buy nothing and only delay the eventual failure.
 */
export const RETRY_DELAY_CAP_MS = 60_000

/**
 * How many times a *timed-out* request is attempted in total. Two, not ten: the
 * request was accepted and ran out of clock, so an identical replay fails the
 * same way. The second attempt only covers a genuinely unlucky first one.
 */
export const MAX_TIMEOUT_RETRY_ATTEMPTS = 2

/**
 * Wait before re-attempting a timed-out request. Short, because there is no
 * quota to roll over — the only thing the pause buys is not hammering an
 * endpoint that is already struggling.
 */
export const TIMEOUT_RETRY_DELAY_MS = 2_000

/** Current tokens in the bucket. Refilled at {@link requestsPerMinute}, consumed by {@link pace}. */
let bucketTokens = BUCKET_CAPACITY

/** Timestamp (ms) the bucket was last refilled. */
let lastRefillAt = Date.now()

/** Serializes {@link pace} callers so requests stay ordered and the bucket is drained fairly. */
let paceChain: Promise<void> = Promise.resolve()

/** Test seam: forget the pacing state so a suite starts from a clean bucket. */
export function __resetPacing(): void {
  bucketTokens = BUCKET_CAPACITY
  lastRefillAt = Date.now()
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
 * Token-bucket rate limiter (Principle 6 #3). Waits until a token is available,
 * then consumes one and releases the caller to issue their request. Callers are
 * served in arrival order; the bucket refills at {@link requestsPerMinute} so
 * sustained load is shaped *before* a 429 happens. Independent jitter in
 * {@link withRetry} breaks lockstep across the 3 parallel lanes (Principle 6 #4).
 */
export function pace(signal?: AbortSignal): Promise<void> {
  const turn = paceChain.then(async () => {
    // Refill tokens based on time elapsed since the last refill.
    const now = Date.now()
    const elapsed = now - lastRefillAt
    if (elapsed > 0 && requestsPerMinute < Infinity) {
      const refill = (elapsed / 60_000) * requestsPerMinute
      bucketTokens = Math.min(BUCKET_CAPACITY, bucketTokens + refill)
      lastRefillAt = now
    }

    // Wait until a token is available. When the bucket is empty, the wait is
    // `60000 / requestsPerMinute` ms (the refill period for one token).
    while (bucketTokens < 1 && requestsPerMinute < Infinity) {
      const waitMs = (60_000 / requestsPerMinute) * (1 - bucketTokens)
      await sleep(waitMs, signal)
      // Refill again after the wait (time has passed).
      const now = Date.now()
      const elapsed = now - lastRefillAt
      const refill = (elapsed / 60_000) * requestsPerMinute
      bucketTokens = Math.min(BUCKET_CAPACITY, bucketTokens + refill)
      lastRefillAt = now
    }

    // Consume one token and release the caller.
    bucketTokens = Math.max(0, bucketTokens - 1)
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
 * Why a request failed, which decides how (and whether) it is worth repeating.
 *
 *  - `permanent` — a user abort, or an error another attempt cannot fix (a bad
 *    key, a malformed request, an unknown model).
 *  - `timeout` — the request was accepted but exceeded a deadline. Retryable,
 *    but only briefly: replaying it unchanged will hit the same deadline.
 *  - `transient` — the request was rejected by a rate limit or a struggling
 *    upstream. Worth replaying identically after a real wait.
 */
export type FailureKind = 'permanent' | 'timeout' | 'transient'

/**
 * Classifies a provider failure. Checked in order of certainty: aborts and
 * permanent HTTP statuses win outright (even when the message *also* contains
 * timeout wording), then deadline failures, then everything transient.
 *
 * `408` (Request Timeout), `504` (Gateway Timeout) and `524` (Cloudflare: origin
 * took too long) are deadline failures, not rejections — something upstream gave
 * up waiting on a generation that was still running, so a replay faces the same
 * clock. `429`/`500`/`502`/`503`/`522` and socket-level faults are rejections.
 */
export function classifyFailure(err: unknown): FailureKind {
  if (isAbort(err)) return 'permanent'
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase()
  // Permanent, even if the wording also matches a pattern below.
  if (/\b(401|403|404|400)\b/.test(text)) return 'permanent'
  if (/\b(408|504|524)\b/.test(text)) return 'timeout'
  if (/\b(429|500|502|503|522)\b/.test(text)) return 'transient'
  if (/timed out|timeout|etimedout|deadline/.test(text)) return 'timeout'
  if (
    /rate.?limit|too many requests|overloaded|capacity|quota|econnreset|econnrefused|enotfound|socket hang up|fetch failed|network|temporarily unavailable/.test(
      text
    )
  ) {
    return 'transient'
  }
  return 'permanent'
}

/**
 * Errors that another attempt could plausibly fix — anything not `permanent`.
 * Kept as the coarse yes/no predicate; {@link classifyFailure} is what decides
 * how many attempts and how long a wait that failure actually earns.
 */
export function isRetryable(err: unknown): boolean {
  return classifyFailure(err) !== 'permanent'
}


/** What {@link withRetry} reports before each wait, for surfacing in the UI. */
export interface RetryNotice {
  /** 1-based attempt number that just failed. */
  attempt: number
  /** Total attempts allowed for THIS failure kind (see {@link classifyFailure}). */
  max: number
  /** How long we're about to wait before the next attempt. */
  delayMs: number
  /** Why it failed (the provider's message, trimmed for display). */
  reason: string
  /** Which budget applied — lets the UI word a deadline failure honestly. */
  kind: FailureKind
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
  /** Override the transient attempt budget (tests). */
  attempts?: number
  /** Override the transient backoff base (tests). Defaults to {@link RETRY_DELAY_BASE_MS}. */
  delayBaseMs?: number
  /** Override the transient backoff cap (tests). Defaults to {@link RETRY_DELAY_CAP_MS}. */
  delayCapMs?: number
  /** Override the timeout attempt budget (tests). */
  timeoutAttempts?: number
  /** Override the timeout inter-attempt wait (tests). */
  timeoutDelayMs?: number
}

/**
 * Runs `fn`, paced and retried. Returns its value, or throws the LAST error once
 * the budget for that failure kind is exhausted / the failure is permanent / a
 * retry was vetoed — so the caller's existing error handling still reports
 * something accurate.
 *
 * Principle 6: exponential backoff with full jitter (base 1s → 2 → 4 → 8 … cap
 * 60s, then `random(0, computed)`), honour `Retry-After`, and independent jitter
 * per call (breaking lockstep for the 3 parallel lanes).
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    signal,
    onRetry,
    canRetry,
    attempts = MAX_RETRY_ATTEMPTS,
    delayBaseMs = RETRY_DELAY_BASE_MS,
    delayCapMs = RETRY_DELAY_CAP_MS,
    timeoutAttempts = MAX_TIMEOUT_RETRY_ATTEMPTS,
    timeoutDelayMs = TIMEOUT_RETRY_DELAY_MS
  } = options

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new AbortError()
    await pace(signal)
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const kind = classifyFailure(err)
      if (kind === 'permanent' || canRetry?.() === false) throw err
      // A deadline failure earns its own (much shorter) budget: replaying an
      // unchanged request against the same clock is not a strategy.
      const isTimeout = kind === 'timeout'
      const max = isTimeout ? Math.min(attempts, Math.max(1, timeoutAttempts)) : attempts
      if (attempt >= max) throw err

      // Honour `Retry-After` if the server told us when to retry (Principle 6 #2).
      // Otherwise use exponential backoff with full jitter (Principle 6 #1).
      const retryAfter = extractRetryAfter(err)
      let wait: number
      if (retryAfter !== null) {
        // Server said when to retry: wait exactly that (capped), no jitter.
        wait = Math.min(retryAfter, delayCapMs)
      } else if (isTimeout) {
        // Timeout: short fixed delay, no backoff (replaying won't help).
        wait = timeoutDelayMs
      } else {
        // Transient: exponential backoff with full jitter. `min(cap, base * 2^(attempt-1))`
        // then `random(0, computed)`. Attempt 1 → ~500ms avg, 2 → ~1s, 3 → ~2s, etc.
        const exponential = Math.min(delayCapMs, delayBaseMs * Math.pow(2, attempt - 1))
        wait = Math.floor(Math.random() * exponential)
      }

      onRetry?.({
        attempt,
        max,
        delayMs: wait,
        reason: (err instanceof Error ? err.message : String(err)).slice(0, 160),
        kind
      })
      await sleep(wait, signal)
    }
  }
  // Unreachable (the loop either returns or throws), but keeps the type honest.
  throw lastError
}

/**
 * Extract `Retry-After` from an error that was thrown at the provider/gateway
 * boundary. Returns milliseconds to wait, or `null` if no header was found.
 * Principle 6 #2: the server knows when its quota rolls over; use that.
 */
function extractRetryAfter(err: unknown): number | null {
  // The error carries `retryAfterMs` when the provider layer read the header.
  const ms = (err as { retryAfterMs?: number } | null)?.retryAfterMs
  return typeof ms === 'number' && ms > 0 ? ms : null
}
