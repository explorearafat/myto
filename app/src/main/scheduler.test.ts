import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { __setDbPathForTest, closeDb } from '@main/db/db'
import { insertScheduledTask, getScheduledTask } from '@main/db/scheduled-tasks'
import { computeNextRun, cronMatches, createScheduler, parseCron } from '@main/scheduler'

/**
 * The cron math is pure and deterministic; the tick path is exercised against the
 * same throwaway-file DB seam the other tables use. All times are LOCAL (cron is),
 * so the assertions read back local calendar fields rather than absolute epochs.
 */

describe('parseCron', () => {
  it('rejects the wrong field count', () => {
    expect(parseCron('* * * *')).toBeNull()
    expect(parseCron('* * * * * *')).toBeNull()
  })
  it('rejects out-of-range values', () => {
    expect(parseCron('60 * * * *')).toBeNull()
    expect(parseCron('* 24 * * *')).toBeNull()
    expect(parseCron('* * 0 * *')).toBeNull() // day-of-month is 1-based
  })
  it('accepts *, lists, ranges, and steps', () => {
    const spec = parseCron('*/15 9-17 1,15 * 1-5')
    expect(spec).not.toBeNull()
    expect([...spec!.minute]).toEqual([0, 15, 30, 45])
    expect(spec!.hour.has(9)).toBe(true)
    expect(spec!.hour.has(18)).toBe(false)
    expect(spec!.dom.has(15)).toBe(true)
  })
  it('normalises dow 7 to Sunday (0)', () => {
    expect(parseCron('0 0 * * 7')!.dow.has(0)).toBe(true)
  })
})

describe('cronMatches — the dom/dow OR rule', () => {
  it('matches EITHER when both day fields are restricted', () => {
    const spec = parseCron('0 0 13 * 5')! // the 13th OR any Friday
    // 2026-02-13 is a Friday: both hit.
    expect(cronMatches(spec, new Date(2026, 1, 13, 0, 0))).toBe(true)
    // 2026-03-13 is the 13th (a Friday too) — pick a non-Friday 13th: 2026-01-13 (Tue).
    expect(cronMatches(spec, new Date(2026, 0, 13, 0, 0))).toBe(true)
    // A Friday that isn't the 13th still matches via dow.
    expect(cronMatches(spec, new Date(2026, 0, 16, 0, 0))).toBe(true) // 2026-01-16 Fri
    // Neither: 2026-01-14 (Wed, not the 13th).
    expect(cronMatches(spec, new Date(2026, 0, 14, 0, 0))).toBe(false)
  })
})

describe('computeNextRun', () => {
  it('returns null for a malformed cron', () => {
    expect(computeNextRun('not a cron', Date.now())).toBeNull()
  })
  it('finds the next quarter-hour', () => {
    const from = new Date(2026, 0, 1, 10, 7, 0).getTime()
    const next = computeNextRun('*/15 * * * *', from)!
    const d = new Date(next)
    expect(d.getMinutes()).toBe(15)
    expect(d.getHours()).toBe(10)
  })
  it('rolls to the next day for a daily time already passed', () => {
    const from = new Date(2026, 0, 1, 10, 0, 0).getTime()
    const next = computeNextRun('30 9 * * *', from)!
    const d = new Date(next)
    expect(d.getDate()).toBe(2)
    expect(d.getHours()).toBe(9)
    expect(d.getMinutes()).toBe(30)
  })
  it('is strictly after `from` (never returns the same minute)', () => {
    const from = new Date(2026, 0, 1, 9, 30, 0).getTime()
    const next = computeNextRun('30 9 * * *', from)!
    expect(next).toBeGreaterThan(from)
    expect(new Date(next).getDate()).toBe(2)
  })
})

describe('scheduler tick', () => {
  let dir: string
  let n = 9000
  const tick = (): number => (n += 1000)

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'myto-sched-'))
  })
  afterAll(() => {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(() => {
    closeDb()
    __setDbPathForTest(join(dir, `t-${n}.db`))
  })

  it('fires a due task and advances its next_run_at', () => {
    const at = new Date(2026, 0, 1, 12, 0, 0).getTime()
    insertScheduledTask({
      id: 'sched-due',
      name: 'nightly',
      prompt: 'do the thing',
      cron: '0 * * * *', // top of every hour
      enabled: true,
      mode: 'cowork',
      createdAt: tick(),
      updatedAt: tick(),
      nextRunAt: at - 60_000 // already due a minute ago
    })
    const fired: string[] = []
    const scheduler = createScheduler({ onFire: (t) => fired.push(t.id), now: () => at })
    scheduler.tick()
    expect(fired).toEqual(['sched-due'])
    const after = getScheduledTask('sched-due')!
    expect(after.lastRunAt).toBe(at)
    expect(after.nextRunAt).toBeGreaterThan(at) // rescheduled forward
  })

  it('skips disabled tasks and future tasks', () => {
    const at = new Date(2026, 0, 1, 12, 0, 0).getTime()
    insertScheduledTask({
      id: 'sched-off',
      name: 'off',
      prompt: 'x',
      cron: '0 * * * *',
      enabled: false,
      mode: 'chat',
      createdAt: tick(),
      updatedAt: tick(),
      nextRunAt: at - 60_000
    })
    insertScheduledTask({
      id: 'sched-future',
      name: 'later',
      prompt: 'y',
      cron: '0 * * * *',
      enabled: true,
      mode: 'chat',
      createdAt: tick(),
      updatedAt: tick(),
      nextRunAt: at + 3_600_000
    })
    const fired: string[] = []
    const scheduler = createScheduler({ onFire: (t) => fired.push(t.id), now: () => at })
    scheduler.tick()
    expect(fired).toEqual([])
  })

  it('start/stop drive the interval without throwing', () => {
    vi.useFakeTimers()
    try {
      const scheduler = createScheduler({ onFire: () => {}, now: () => Date.now(), intervalMs: 1000 })
      scheduler.start()
      scheduler.start() // idempotent
      vi.advanceTimersByTime(2500)
      scheduler.stop()
      scheduler.stop() // idempotent
    } finally {
      vi.useRealTimers()
    }
  })
})
