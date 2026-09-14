import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  withRetry,
  isRetryable,
  classifyFailure,
  isAbort,
  pace,
  sleep,
  AbortError,
  MAX_RETRY_ATTEMPTS,
  RETRY_DELAY_BASE_MS,
  RETRY_DELAY_CAP_MS,
  MAX_TIMEOUT_RETRY_ATTEMPTS,
  TIMEOUT_RETRY_DELAY_MS,
  __resetPacing,
  __setRequestsPerMinute,
  type RetryNotice
} from './resilience'

// Only the pacing gate is reset between tests — deliberately NOT the mocks:
// clearing a rejecting mock in beforeEach makes it resolve `undefined` instead of
// throwing, which silently breaks the retry assertions. Each test builds its own.
beforeEach(() => {
  __resetPacing()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('isRetryable', () => {
  it('retries rate limits, timeouts, and transient upstream faults', () => {
    for (const message of [
      'HTTP 429 Too Many Requests',
      'HTTP 503 Service Unavailable',
      'HTTP 502 Bad Gateway',
      'request timed out',
      'socket hang up',
      'fetch failed',
      'ECONNRESET',
      'Model is overloaded, try again',
      'monthly quota exceeded'
    ]) {
      expect(isRetryable(new Error(message)), message).toBe(true)
    }
  })

  it('never retries a permanent failure — waiting cannot fix a bad key or model', () => {
    for (const message of [
      'HTTP 401 Unauthorized',
      'HTTP 403 Forbidden',
      'HTTP 404 model not found',
      'HTTP 400 Bad Request'
    ]) {
      expect(isRetryable(new Error(message)), message).toBe(false)
    }
  })

  it('classifies a permanent status as permanent even when the wording looks transient', () => {
    // A 401 body that happens to mention a timeout must NOT buy ten more minutes.
    expect(isRetryable(new Error('HTTP 401: session timed out, re-authenticate'))).toBe(false)
  })

  it('treats a cancellation as neither retryable nor a failure', () => {
    const aborted = new AbortError()
    expect(isAbort(aborted)).toBe(true)
    expect(isRetryable(aborted)).toBe(false)
  })
})

describe('classifyFailure', () => {
  it('separates a deadline failure from a rejection — only one is fixed by waiting', () => {
    // Accepted-but-too-slow: the clock ran out, nothing was rejected.
    for (const message of [
      'Request timed out after 120000ms',
      'HTTP 408 Request Timeout',
      'HTTP 504 Gateway Timeout',
      'HTTP 524 A timeout occurred',
      'ETIMEDOUT'
    ]) {
      expect(classifyFailure(new Error(message)), message).toBe('timeout')
    }

    // Rejected: a quota rolls over, an overloaded upstream recovers.
    for (const message of [
      'HTTP 429 Too Many Requests',
      'HTTP 503 Service Unavailable',
      'HTTP 502 Bad Gateway',
      'HTTP 522 Connection timed out',
      'socket hang up',
      'ECONNRESET',
      'Model is overloaded, try again'
    ]) {
      expect(classifyFailure(new Error(message)), message).toBe('transient')
    }
  })

  it('keeps a permanent status permanent even when it mentions a timeout', () => {
    expect(classifyFailure(new Error('HTTP 401: session timed out'))).toBe('permanent')
  })
})

describe('withRetry', () => {
  it('returns the value without retrying when the call succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const onRetry = vi.fn()

    await expect(withRetry(fn, { onRetry })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('retries a transient failure and returns the eventual success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 429 rate limit'))
      .mockRejectedValueOnce(new Error('HTTP 503'))
      .mockResolvedValue('recovered')
    const notices: RetryNotice[] = []

    await expect(
      withRetry(fn, { delayBaseMs: 1, delayCapMs: 1, onRetry: (n) => notices.push(n) })
    ).resolves.toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
    // One notice per failure, numbered by the attempt that just failed.
    expect(notices.map((n) => n.attempt)).toEqual([1, 2])
    expect(notices[0].reason).toContain('429')
  })

  it('uses exponential backoff with full jitter by default (Principle 6 #1)', async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValue(new Error('HTTP 429 rate limit'))
    const notices: RetryNotice[] = []

    // Exponential backoff: base 1s → 2 → 4 → 8 … cap 60s, then full jitter.
    // Collect the waits to verify they grow exponentially and are jittered.
    const settled = withRetry(fn, { onRetry: (n) => notices.push(n) }).catch((e: Error) => e)

    // Advance through all 10 attempts. The waits are jittered, so we advance by the
    // cap each time (worst case) to ensure every attempt completes.
    for (let i = 0; i < MAX_RETRY_ATTEMPTS - 1; i++) {
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_CAP_MS)
    }

    const error = await settled
    expect(fn).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS)
    expect(notices).toHaveLength(MAX_RETRY_ATTEMPTS - 1)
    // The waits should be jittered: each is <= the exponential cap at that attempt.
    // Attempt 1: <= 1000, 2: <= 2000, 3: <= 4000, etc., capped at 60000.
    for (let i = 0; i < notices.length; i++) {
      const expectedCap = Math.min(RETRY_DELAY_CAP_MS, RETRY_DELAY_BASE_MS * Math.pow(2, i))
      expect(notices[i].delayMs).toBeLessThanOrEqual(expectedCap)
      expect(notices[i].delayMs).toBeGreaterThanOrEqual(0)
    }
    // The final failure is surfaced, not swallowed, so the turn reports honestly.
    expect((error as Error).message).toContain('429')
  })

  it('does NOT spend the transient budget on a timeout — an unchanged replay hits the same clock', async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValue(new Error('Request timed out after 120000ms'))
    const notices: RetryNotice[] = []

    // The reported bug: this used to burn 10 × 120s + 9 × 60s ≈ 29 minutes to
    // arrive at the identical error. A deadline gets one quick second chance.
    const settled = withRetry(fn, { onRetry: (n) => notices.push(n) }).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(MAX_TIMEOUT_RETRY_ATTEMPTS * TIMEOUT_RETRY_DELAY_MS)

    const error = await settled
    expect(fn).toHaveBeenCalledTimes(MAX_TIMEOUT_RETRY_ATTEMPTS)
    expect(notices).toHaveLength(MAX_TIMEOUT_RETRY_ATTEMPTS - 1)
    // The notice must not promise nine more tries it will never make.
    expect(notices[0]).toMatchObject({
      attempt: 1,
      max: MAX_TIMEOUT_RETRY_ATTEMPTS,
      delayMs: TIMEOUT_RETRY_DELAY_MS,
      kind: 'timeout'
    })
    expect((error as Error).message).toContain('timed out')
  })

  it('still uses exponential backoff for rate limits after a timeout', async () => {
    vi.useFakeTimers()
    // A timeout first, then rate limits: the budget must follow the CURRENT
    // failure, so the 429s still get exponential backoff.
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Request timed out after 120000ms'))
      .mockRejectedValueOnce(new Error('HTTP 429 rate limit'))
      .mockResolvedValue('recovered')
    const notices: RetryNotice[] = []

    const settled = withRetry(fn, { onRetry: (n) => notices.push(n) })
    await vi.advanceTimersByTimeAsync(TIMEOUT_RETRY_DELAY_MS + RETRY_DELAY_CAP_MS)

    await expect(settled).resolves.toBe('recovered')
    expect(notices.map((n) => n.kind)).toEqual(['timeout', 'transient'])
    expect(notices[0].delayMs).toBe(TIMEOUT_RETRY_DELAY_MS)
    // The 429 is attempt 2 overall, so it uses exponential backoff for attempt 2:
    // base * 2^(2-1) = 1000 * 2 = 2000, then jittered to [0, 2000].
    expect(notices[1].delayMs).toBeLessThanOrEqual(2000)
  })

  it('honours Retry-After when the server tells us when to retry (Principle 6 #2)', async () => {
    vi.useFakeTimers()
    const err = new Error('HTTP 429 Too Many Requests')
    Object.assign(err, { retryAfterMs: 5_000 }) // Server says: retry in 5s.
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('recovered')
    const notices: RetryNotice[] = []

    const settled = withRetry(fn, { onRetry: (n) => notices.push(n) })
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(settled).resolves.toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
    // The wait should be exactly 5s (no jitter when Retry-After is present).
    expect(notices[0].delayMs).toBe(5_000)
  })

  it('caps Retry-After at the backoff cap so a malicious server cannot stall for hours', async () => {
    vi.useFakeTimers()
    const err = new Error('HTTP 429 Too Many Requests')
    Object.assign(err, { retryAfterMs: 3_600_000 }) // Server says: retry in 1 hour.
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('recovered')
    const notices: RetryNotice[] = []

    const settled = withRetry(fn, { onRetry: (n) => notices.push(n) })
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_CAP_MS)

    await expect(settled).resolves.toBe('recovered')
    // The wait should be capped at 60s, not 1 hour.
    expect(notices[0].delayMs).toBe(RETRY_DELAY_CAP_MS)
  })

  it('gives up immediately on a permanent failure', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('HTTP 401 Unauthorized'))
    const onRetry = vi.fn()

    await expect(withRetry(fn, { delayBaseMs: 1, delayCapMs: 1, onRetry })).rejects.toThrow('401')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('honours a canRetry veto — a stream that already emitted text is never replayed', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('HTTP 503'))
    const onRetry = vi.fn()

    // Streaming callers veto once bytes have reached the user; replaying would
    // duplicate prose already on screen.
    await expect(
      withRetry(fn, { delayBaseMs: 1, delayCapMs: 1, onRetry, canRetry: () => false })
    ).rejects.toThrow('503')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('stops retrying the moment the run is cancelled', async () => {
    const controller = new AbortController()
    const fn = vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.reject(new Error('HTTP 429'))
    })

    await expect(
      withRetry(fn, { delayBaseMs: 50, delayCapMs: 50, signal: controller.signal })
    ).rejects.toThrow()
    // Aborted during attempt 1: the wait is cut short, so no second attempt.
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('pace (token-bucket rate limiter, Principle 6 #3)', () => {
  it('allows a burst up to the bucket capacity, then throttles at the refill rate', async () => {
    __setRequestsPerMinute(60) // 1 per second; bucket capacity = 60
    try {
      vi.useFakeTimers()
      const released: number[] = []

      // Bucket starts full (capacity = 60). First 60 requests would go through
      // immediately, but we only test 3 for speed.
      await pace()
      released.push(0)
      await pace()
      released.push(1)
      await pace()
      released.push(2)
      expect(released).toEqual([0, 1, 2]) // burst allowed

      // Now the bucket is down to 57 tokens. A 4th request waits for refill.
      const fourth = pace()
      await vi.advanceTimersByTimeAsync(500)
      expect(released).toEqual([0, 1, 2]) // still waiting

      await vi.advanceTimersByTimeAsync(500)
      await fourth
      released.push(3)
      expect(released).toEqual([0, 1, 2, 3]) // refilled after 1s
    } finally {
      __setRequestsPerMinute(Infinity)
    }
  })

  it('does not wait at all when pacing is disabled (Infinity budget)', async () => {
    __setRequestsPerMinute(Infinity)
    const started = Date.now()
    await pace()
    await pace()
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('survives an aborted wait — a cancelled turn must not stall later callers', async () => {
    __setRequestsPerMinute(1) // very slow refill
    try {
      vi.useFakeTimers()
      const controller = new AbortController()
      // Drain the bucket, then abort a waiting caller.
      await pace()
      const rejected = pace(controller.signal)
      controller.abort()
      await expect(rejected).rejects.toThrow(AbortError)

      // The chain must have been re-armed: a fresh caller still gets served.
      __setRequestsPerMinute(Infinity)
      await expect(pace()).resolves.toBeUndefined()
    } finally {
      __setRequestsPerMinute(Infinity)
    }
  })

  it('independent jitter in withRetry breaks lockstep across parallel lanes (Principle 6 #4)', async () => {
    // This test verifies that the jitter is independent per call. We fire 3
    // parallel retries and check that their waits are NOT identical (which would
    // mean they're synchronized). Math.random() is per-invocation, so this is
    // structurally true, but we verify it to document the herd-breaking property.
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValue(new Error('HTTP 429'))
    const waits: number[][] = [[], [], []]

    const all = Promise.all(
      [0, 1, 2].map((i) =>
        withRetry(fn, {
          attempts: 3,
          onRetry: (n) => waits[i].push(n.delayMs)
        }).catch(() => {})
      )
    )

    // Advance through 3 attempts each.
    for (let attempt = 0; attempt < 2; attempt++) {
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_CAP_MS)
    }
    await all

    // Each lane made 3 attempts, so 2 waits each.
    expect(waits[0]).toHaveLength(2)
    expect(waits[1]).toHaveLength(2)
    expect(waits[2]).toHaveLength(2)
    // The waits are jittered (random), so they should NOT all be identical. With
    // full jitter over [0, cap], the chance of all 6 waits being identical is
    // astronomically small. We just check that at least one differs.
    const allWaits = waits.flat()
    const unique = new Set(allWaits)
    expect(unique.size).toBeGreaterThan(1) // not all synchronized
  })
})

describe('sleep', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sleep(10_000, controller.signal)).rejects.toThrow(AbortError)
  })

  it('rejects when the signal fires mid-wait', async () => {
    const controller = new AbortController()
    const waiting = sleep(10_000, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow(AbortError)
  })
})
