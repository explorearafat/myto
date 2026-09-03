import { describe, it, expect } from 'vitest'
import {
  parseCron,
  isValidCron,
  cronMatches,
  nextRun,
  Scheduler,
  type ScheduledTaskStore
} from '@main/scheduler'
import type { ScheduledTask } from '@shared/types'

// ── Cron parser ──────────────────────────────────────────────────────────────

describe('parseCron', () => {
  it('parses a bare five-star expression as "every minute"', () => {
    const s = parseCron('* * * * *')
    expect(s).not.toBeNull()
    expect(s!.minute.size).toBe(60)
    expect(s!.hour.size).toBe(24)
    expect(s!.domStar).toBe(true)
    expect(s!.dowStar).toBe(true)
  })

  it('parses single values', () => {
    const s = parseCron('30 9 * * *')!
    expect([...s.minute]).toEqual([30])
    expect([...s.hour]).toEqual([9])
    expect(s.domStar).toBe(true)
    expect(s.dowStar).toBe(true)
  })

  it('parses ranges, lists, steps, and range-steps', () => {
    expect([...parseCron('0-5 * * * *')!.minute]).toEqual([0, 1, 2, 3, 4, 5])
    expect([...parseCron('0,15,30,45 * * * *')!.minute]).toEqual([0, 15, 30, 45])
    expect([...parseCron('*/15 * * * *')!.minute]).toEqual([0, 15, 30, 45])
    expect([...parseCron('0-30/10 * * * *')!.minute]).toEqual([0, 10, 20, 30])
  })

  it('treats a bare "a/step" as a-to-max (Vixie semantics)', () => {
    // 40/10 in the minute field → 40, 50 (up to the field max of 59).
    expect([...parseCron('40/10 * * * *')!.minute]).toEqual([40, 50])
  })

  it('normalizes day-of-week 7 to 0 (both Sunday) and accepts 0-6', () => {
    expect([...parseCron('0 0 * * 7')!.dow]).toEqual([0])
    expect([...parseCron('0 0 * * 0')!.dow]).toEqual([0])
    expect([...parseCron('0 0 * * 1-5')!.dow]).toEqual([1, 2, 3, 4, 5])
  })

  it('tolerates extra whitespace between fields', () => {
    expect(parseCron('  0   9  *  *  1  ')).not.toBeNull()
  })

  it('rejects malformed expressions', () => {
    expect(parseCron('* * * *')).toBeNull() // too few fields
    expect(parseCron('* * * * * *')).toBeNull() // too many fields
    expect(parseCron('60 * * * *')).toBeNull() // minute out of range
    expect(parseCron('* 24 * * *')).toBeNull() // hour out of range
    expect(parseCron('* * 0 * *')).toBeNull() // dom below 1
    expect(parseCron('* * 32 * *')).toBeNull() // dom above 31
    expect(parseCron('* * * 13 *')).toBeNull() // month above 12
    expect(parseCron('* * * * 8')).toBeNull() // dow above 7
    expect(parseCron('*/0 * * * *')).toBeNull() // zero step
    expect(parseCron('5-1 * * * *')).toBeNull() // inverted range
    expect(parseCron('abc * * * *')).toBeNull() // non-numeric
    expect(parseCron('')).toBeNull()
  })

  it('exposes validity via isValidCron', () => {
    expect(isValidCron('*/5 * * * *')).toBe(true)
    expect(isValidCron('nope')).toBe(false)
  })
})

describe('cronMatches', () => {
  it('matches an exact minute/hour', () => {
    const s = parseCron('30 9 * * *')!
    // Local time is used; construct with local components.
    expect(cronMatches(s, new Date(2026, 0, 1, 9, 30))).toBe(true)
    expect(cronMatches(s, new Date(2026, 0, 1, 9, 31))).toBe(false)
    expect(cronMatches(s, new Date(2026, 0, 1, 10, 30))).toBe(false)
  })

  it('applies the DOM/DOW OR rule when both are restricted', () => {
    // "0 0 13 * 5" → midnight on the 13th OR any Friday.
    const s = parseCron('0 0 13 * 5')!
    // 2026-02-13 is a Friday — matches on both counts.
    expect(cronMatches(s, new Date(2026, 1, 13, 0, 0))).toBe(true)
    // 2026-03-13 is a Friday — matches via DOW even though it's the 13th too.
    expect(cronMatches(s, new Date(2026, 2, 13, 0, 0))).toBe(true)
    // 2026-01-13 is a Tuesday — matches via DOM only.
    expect(cronMatches(s, new Date(2026, 0, 13, 0, 0))).toBe(true)
    // A non-Friday, non-13th day does not match.
    expect(cronMatches(s, new Date(2026, 0, 14, 0, 0))).toBe(false)
  })

  it('requires only DOW when DOM is a star', () => {
    const s = parseCron('0 0 * * 1')! // every Monday
    // 2026-01-05 is a Monday.
    expect(cronMatches(s, new Date(2026, 0, 5, 0, 0))).toBe(true)
    // 2026-01-06 is a Tuesday.
    expect(cronMatches(s, new Date(2026, 0, 6, 0, 0))).toBe(false)
  })

  it('honors the month field', () => {
    const s = parseCron('0 0 1 1 *')! // Jan 1st
    expect(cronMatches(s, new Date(2026, 0, 1, 0, 0))).toBe(true)
    expect(cronMatches(s, new Date(2026, 1, 1, 0, 0))).toBe(false)
  })
})

describe('nextRun', () => {
  it('finds the next matching minute strictly after the given time', () => {
    const s = parseCron('*/15 * * * *')!
    const from = new Date(2026, 0, 1, 9, 7).getTime()
    expect(new Date(nextRun(s, from)!)).toEqual(new Date(2026, 0, 1, 9, 15))
  })

  it('never returns the current minute even when it matches', () => {
    const s = parseCron('* * * * *')!
    const from = new Date(2026, 0, 1, 9, 0, 0, 0).getTime()
    // Already on a matching minute → the *next* one, not this one.
    expect(new Date(nextRun(s, from)!)).toEqual(new Date(2026, 0, 1, 9, 1))
  })

  it('rolls across an hour and day boundary', () => {
    const s = parseCron('0 0 * * *')! // midnight
    const from = new Date(2026, 0, 1, 12, 0).getTime()
    expect(new Date(nextRun(s, from)!)).toEqual(new Date(2026, 0, 2, 0, 0))
  })

  it('returns null for an impossible schedule', () => {
    // The 31st of February never occurs.
    const s = parseCron('0 0 31 2 *')!
    expect(nextRun(s, new Date(2026, 0, 1).getTime())).toBeNull()
  })
})

// ── Scheduler ────────────────────────────────────────────────────────────────

/** A clock the test advances by hand. */
class FakeClock {
  constructor(private ms: number) {}
  now(): number {
    return this.ms
  }
  set(ms: number): void {
    this.ms = ms
  }
  advance(ms: number): void {
    this.ms += ms
  }
}

/** An in-memory durable store that records every write for assertions. */
function memoryStore(seed: ScheduledTask[] = []): ScheduledTaskStore & { tasks: Map<string, ScheduledTask> } {
  const tasks = new Map<string, ScheduledTask>(seed.map((t) => [t.id, t]))
  return {
    tasks,
    list: () => [...tasks.values()],
    upsert: (t) => {
      tasks.set(t.id, t)
    },
    remove: (id) => {
      tasks.delete(id)
    }
  }
}

describe('Scheduler', () => {
  it('fires a task once its next run time has passed and reschedules it', () => {
    // Start at 2026-01-01 09:00 local; task runs every 15 minutes.
    const clock = new FakeClock(new Date(2026, 0, 1, 9, 0).getTime())
    const fired: string[] = []
    const scheduler = new Scheduler({
      clock,
      store: memoryStore(),
      fire: (task) => fired.push(task.id)
    })

    const task = scheduler.add({ name: 'ping', prompt: 'do the thing', cron: '*/15 * * * *' })
    // First run should be scheduled for 09:15.
    expect(task.nextRunAt).toBe(new Date(2026, 0, 1, 9, 15).getTime())

    // Not due yet at 09:10 — nothing fires.
    clock.set(new Date(2026, 0, 1, 9, 10).getTime())
    scheduler.tick()
    expect(fired).toEqual([])

    // At 09:15 it fires and reschedules to 09:30.
    clock.set(new Date(2026, 0, 1, 9, 15).getTime())
    scheduler.tick()
    expect(fired).toEqual([task.id])
    const after = scheduler.list()[0]
    expect(after.lastRunAt).toBe(new Date(2026, 0, 1, 9, 15).getTime())
    expect(after.nextRunAt).toBe(new Date(2026, 0, 1, 9, 30).getTime())

    // A tick before the new time does nothing more.
    clock.set(new Date(2026, 0, 1, 9, 20).getTime())
    scheduler.tick()
    expect(fired).toEqual([task.id])
  })

  it('does not fire a paused task, and resumes it when re-enabled', () => {
    const clock = new FakeClock(new Date(2026, 0, 1, 9, 0).getTime())
    const fired: string[] = []
    const scheduler = new Scheduler({
      clock,
      store: memoryStore(),
      fire: (t) => fired.push(t.id)
    })
    const task = scheduler.add({ name: 'x', prompt: 'p', cron: '*/5 * * * *', enabled: false })
    expect(task.nextRunAt).toBeUndefined()

    clock.set(new Date(2026, 0, 1, 9, 30).getTime())
    scheduler.tick()
    expect(fired).toEqual([])

    scheduler.setEnabled(task.id, true)
    expect(scheduler.list()[0].nextRunAt).toBe(new Date(2026, 0, 1, 9, 35).getTime())
    clock.set(new Date(2026, 0, 1, 9, 35).getTime())
    scheduler.tick()
    expect(fired).toEqual([task.id])
  })

  it('persists only durable tasks to the store', () => {
    const clock = new FakeClock(new Date(2026, 0, 1, 9, 0).getTime())
    const store = memoryStore()
    const scheduler = new Scheduler({ clock, store, fire: () => {} })

    const durable = scheduler.add({ name: 'keep', prompt: 'p', cron: '0 * * * *', durable: true })
    scheduler.add({ name: 'ephemeral', prompt: 'p', cron: '0 * * * *' })

    expect([...store.tasks.keys()]).toEqual([durable.id])
  })

  it('rehydrates durable tasks from the store and recomputes nextRunAt', () => {
    const clock = new FakeClock(new Date(2026, 0, 1, 9, 0).getTime())
    const seeded: ScheduledTask = {
      id: 'sched-seed-1',
      name: 'seeded',
      prompt: 'p',
      cron: '30 9 * * *',
      enabled: true,
      durable: true,
      createdAt: new Date(2025, 0, 1).getTime(),
      updatedAt: new Date(2025, 0, 1).getTime(),
      // A stale nextRunAt from a prior process; must be recomputed on load.
      nextRunAt: new Date(2025, 0, 1, 9, 30).getTime()
    }
    const scheduler = new Scheduler({ clock, store: memoryStore([seeded]), fire: () => {} })
    const loaded = scheduler.list()[0]
    expect(loaded.id).toBe('sched-seed-1')
    expect(loaded.nextRunAt).toBe(new Date(2026, 0, 1, 9, 30).getTime())
  })

  it('drops a durable task from the store on removal', () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    const scheduler = new Scheduler({ clock, store, fire: () => {} })
    const t = scheduler.add({ name: 'temp', prompt: 'p', cron: '0 * * * *', durable: true })
    expect(store.tasks.has(t.id)).toBe(true)
    scheduler.remove(t.id)
    expect(store.tasks.has(t.id)).toBe(false)
    expect(scheduler.list()).toEqual([])
  })

  it('reconciles the store when an update flips durability off', () => {
    const clock = new FakeClock(0)
    const store = memoryStore()
    const scheduler = new Scheduler({ clock, store, fire: () => {} })
    const t = scheduler.add({ name: 'd', prompt: 'p', cron: '0 * * * *', durable: true })
    expect(store.tasks.has(t.id)).toBe(true)
    scheduler.update(t.id, { name: 'd', prompt: 'p', cron: '0 * * * *', durable: false })
    expect(store.tasks.has(t.id)).toBe(false)
  })

  it('throws on an invalid cron in add and update', () => {
    const scheduler = new Scheduler({ clock: new FakeClock(0), store: memoryStore(), fire: () => {} })
    expect(() => scheduler.add({ name: 'bad', prompt: 'p', cron: 'not a cron' })).toThrow(/cron/i)
    const ok = scheduler.add({ name: 'ok', prompt: 'p', cron: '0 * * * *' })
    expect(() => scheduler.update(ok.id, { name: 'ok', prompt: 'p', cron: '99 * * * *' })).toThrow(
      /cron/i
    )
  })

  it('keeps sweeping when one task’s fire callback throws', () => {
    const clock = new FakeClock(new Date(2026, 0, 1, 9, 0).getTime())
    const fired: string[] = []
    const scheduler = new Scheduler({
      clock,
      store: memoryStore(),
      fire: (t) => {
        if (t.name === 'boom') throw new Error('kaboom')
        fired.push(t.id)
      }
    })
    scheduler.add({ name: 'boom', prompt: 'p', cron: '*/5 * * * *' })
    const good = scheduler.add({ name: 'good', prompt: 'p', cron: '*/5 * * * *' })

    clock.set(new Date(2026, 0, 1, 9, 5).getTime())
    // Should not throw despite the first task's callback throwing.
    expect(() => scheduler.tick()).not.toThrow()
    expect(fired).toContain(good.id)
  })

  it('returns null from update/setEnabled for an unknown id', () => {
    const scheduler = new Scheduler({ clock: new FakeClock(0), store: memoryStore(), fire: () => {} })
    expect(scheduler.update('nope', { name: 'x', prompt: 'p', cron: '0 * * * *' })).toBeNull()
    expect(scheduler.setEnabled('nope', true)).toBeNull()
  })
})
