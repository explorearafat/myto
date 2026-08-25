import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  withRetry,
  isRetryable,
  isAbort,
  pace,
  sleep,
  AbortError,
  MAX_RETRY_ATTEMPTS,
  RETRY_DELAY_MS,
  __resetPacing,
  __setRequestGap,
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

    await expect(withRetry(fn, { delayMs: 1, onRetry: (n) => notices.push(n) })).resolves.toBe(
      'recovered'
    )
    expect(fn).toHaveBeenCalledTimes(3)
    // One notice per failure, numbered by the attempt that just failed.
    expect(notices.map((n) => n.attempt)).toEqual([1, 2])
    expect(notices[0].reason).toContain('429')
  })

  it('makes 10 attempts a minute apart by default, then throws the last error', async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValue(new Error('HTTP 429 rate limit'))
    const notices: RetryNotice[] = []

    // The user's requirement verbatim: 10 tries, one minute between them.
    const settled = withRetry(fn, { onRetry: (n) => notices.push(n) }).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync((MAX_RETRY_ATTEMPTS - 1) * RETRY_DELAY_MS)

    const error = await settled
    expect(fn).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS)
    expect(notices).toHaveLength(MAX_RETRY_ATTEMPTS - 1)
    expect(notices[0]).toMatchObject({ attempt: 1, max: 10, delayMs: 60_000 })
    // The final failure is surfaced, not swallowed, so the turn reports honestly.
    expect((error as Error).message).toContain('429')
  })

  it('gives up immediately on a permanent failure', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('HTTP 401 Unauthorized'))
    const onRetry = vi.fn()

    await expect(withRetry(fn, { delayMs: 1, onRetry })).rejects.toThrow('401')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('honours a canRetry veto — a stream that already emitted text is never replayed', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('HTTP 503'))
    const onRetry = vi.fn()

    // Streaming callers veto once bytes have reached the user; replaying would
    // duplicate prose already on screen.
    await expect(withRetry(fn, { delayMs: 1, onRetry, canRetry: () => false })).rejects.toThrow(
      '503'
    )
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('stops retrying the moment the run is cancelled', async () => {
    const controller = new AbortController()
    const fn = vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.reject(new Error('HTTP 429'))
    })

    await expect(withRetry(fn, { delayMs: 50, signal: controller.signal })).rejects.toThrow()
    // Aborted during attempt 1: the wait is cut short, so no second attempt.
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('pace', () => {
  it('spaces successive requests by the configured gap', async () => {
    __setRequestGap(1_000)
    try {
      vi.useFakeTimers()
      const released: number[] = []

      // Three concurrent callers — the orchestrator's parallel specialists.
      const all = Promise.all([0, 1, 2].map((i) => pace().then(() => released.push(i))))

      await vi.advanceTimersByTimeAsync(0)
      expect(released).toEqual([0]) // first goes straight through

      await vi.advanceTimersByTimeAsync(1_000)
      expect(released).toEqual([0, 1])

      await vi.advanceTimersByTimeAsync(1_000)
      await all
      // Arrival order preserved, one per gap — a burst becomes a trickle.
      expect(released).toEqual([0, 1, 2])
    } finally {
      __setRequestGap(0)
    }
  })

  it('does not wait at all when pacing is disabled', async () => {
    const started = Date.now()
    await pace()
    await pace()
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('survives an aborted wait — a cancelled turn must not stall later callers', async () => {
    __setRequestGap(1_000)
    try {
      const controller = new AbortController()
      // Claim the slot so the next caller has to wait, then abort that wait.
      await pace()
      const rejected = pace(controller.signal)
      controller.abort()
      await expect(rejected).rejects.toThrow(AbortError)

      // The chain must have been re-armed: a fresh caller still gets served.
      __setRequestGap(0)
      await expect(pace()).resolves.toBeUndefined()
    } finally {
      __setRequestGap(0)
    }
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
