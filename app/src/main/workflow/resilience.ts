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

/** How many times a *transient* (rejected) model request is re-attempted. */
export const MAX_RETRY_ATTEMPTS = 10

/**
 * Wait between retry attempts. One minute is long enough for a per-minute token
 * or request quota to roll over, which is the failure this exists for.
 */
export const RETRY_DELAY_MS = 60_000

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
  /** Override the transient inter-attempt wait (tests). */
  delayMs?: number
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
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    signal,
    onRetry,
    canRetry,
    attempts = MAX_RETRY_ATTEMPTS,
    delayMs = RETRY_DELAY_MS,
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
      const wait = isTimeout ? timeoutDelayMs : delayMs
      if (attempt >= max) throw err
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
