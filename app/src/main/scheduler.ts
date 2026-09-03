import type { ScheduledTask, ScheduledTaskInput } from '../shared/types'

/**
 * Scheduled tasks (Phase 4) — the pure, Electron-free scheduler core.
 *
 * Two concerns live here, both unit-testable with no Electron, DB, or real
 * clock:
 *
 *  1. A small standard-cron parser ({@link parseCron} / {@link cronMatches} /
 *     {@link nextRun}) covering the 5-field `min hour dom month dow` grammar
 *     with `*`, ranges, lists, and steps.
 *  2. The {@link Scheduler} — holds the task list, advances each task's
 *     `nextRunAt`, and calls an *injected* `fire` callback when one comes due.
 *     Time comes from an injected {@link SchedulerClock} and durable persistence
 *     from an injected {@link ScheduledTaskStore}, so a test drives it with a
 *     fake clock + in-memory store and `tick()` by hand.
 *
 * The main process wires the real clock (`Date.now`), the DB-backed store, and a
 * `fire` that asks the renderer to open a chat and send the prompt.
 */

// ── Cron parsing ───────────────────────────────────────────────────────────

/** A parsed cron expression: the allowed values per field, in LOCAL time. */
export interface CronSchedule {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  /** True when the day-of-month field was a bare `*` (drives the DOM/DOW rule). */
  domStar: boolean
  /** True when the day-of-week field was a bare `*`. */
  dowStar: boolean
}

interface FieldSpec {
  min: number
  max: number
}

const FIELDS: Record<'minute' | 'hour' | 'dom' | 'month' | 'dow', FieldSpec> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 6 }
}

/** Parse a non-negative integer, or null if the token isn't a clean integer. */
function toInt(token: string): number | null {
  if (!/^\d+$/.test(token)) return null
  return Number.parseInt(token, 10)
}

/**
 * Parse one cron field into the set of matching values, honoring `*`, `a`,
 * `a-b`, and a `/step` suffix on `*`, `a` (a→max), or `a-b`, comma-joined. Returns null
 * on any malformed token or out-of-range value, so the whole expression is
 * rejected rather than half-parsed. `dow` normalizes `7` to `0` (both Sunday).
 */
function parseField(raw: string, spec: FieldSpec, isDow: boolean): Set<number> | null {
  const out = new Set<number>()
  const norm = (n: number): number => (isDow && n === 7 ? 0 : n)
  for (const part of raw.split(',')) {
    if (part === '') return null
    const [rangePart, stepPart, ...rest] = part.split('/')
    if (rest.length > 0) return null
    let step = 1
    if (stepPart !== undefined) {
      const s = toInt(stepPart)
      if (s === null || s < 1) return null
      step = s
    }
    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = spec.min
      hi = spec.max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-')
      const ai = toInt(a)
      const bi = toInt(b)
      if (ai === null || bi === null) return null
      lo = ai
      hi = bi
    } else {
      const v = toInt(rangePart)
      if (v === null) return null
      lo = v
      // A bare `a/step` runs from a to the field max (Vixie semantics); a plain
      // `a` is just the single value (step stays 1, hi === lo).
      hi = stepPart !== undefined ? spec.max : v
    }
    // Validate against the field's real bounds (allowing 7 for dow before norm).
    const upper = isDow ? 7 : spec.max
    if (lo < spec.min || hi > upper || lo > hi) return null
    for (let n = lo; n <= hi; n += step) out.add(norm(n))
  }
  return out.size > 0 ? out : null
}

/**
 * Parse a standard 5-field cron expression (`min hour dom month dow`) into a
 * {@link CronSchedule}, or null when it's malformed. Extra whitespace between
 * fields is tolerated. Only the classic 5-field form is supported (no seconds,
 * `@daily`, or names like `MON`) — deliberately small and predictable.
 */
export function parseCron(expr: string): CronSchedule | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hour, dom, month, dow] = parts
  const minute = parseField(min, FIELDS.minute, false)
  const hourSet = parseField(hour, FIELDS.hour, false)
  const domSet = parseField(dom, FIELDS.dom, false)
  const monthSet = parseField(month, FIELDS.month, false)
  const dowSet = parseField(dow, FIELDS.dow, true)
  if (!minute || !hourSet || !domSet || !monthSet || !dowSet) return null
  return {
    minute,
    hour: hourSet,
    dom: domSet,
    month: monthSet,
    dow: dowSet,
    domStar: dom === '*',
    dowStar: dow === '*'
  }
}

/** Whether `expr` is a valid 5-field cron expression. */
export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null
}

/**
 * Does `date` (interpreted in LOCAL time) match `schedule`? Implements the
 * classic day-of-month / day-of-week rule: when both are restricted (neither is
 * `*`) a match on *either* is enough; when only one is restricted only that one
 * must match; when both are `*` any day matches.
 */
export function cronMatches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minute.has(date.getMinutes())) return false
  if (!schedule.hour.has(date.getHours())) return false
  if (!schedule.month.has(date.getMonth() + 1)) return false

  const domMatch = schedule.dom.has(date.getDate())
  const dowMatch = schedule.dow.has(date.getDay())
  let dayOk: boolean
  if (schedule.domStar && schedule.dowStar) dayOk = true
  else if (!schedule.domStar && !schedule.dowStar) dayOk = domMatch || dowMatch
  else if (!schedule.domStar) dayOk = domMatch
  else dayOk = dowMatch
  return dayOk
}

/** Upper bound on the minute-by-minute search — 4 years covers Feb-29 schedules. */
const MAX_LOOKAHEAD_MINUTES = 1461 * 24 * 60

/**
 * The next epoch-ms strictly after `afterMs` at which `schedule` fires, or null
 * when no match exists within {@link MAX_LOOKAHEAD_MINUTES} (an impossible
 * schedule, e.g. day 31 restricted to February). Aligned to the start of a
 * minute; scans minute by minute, which is simple and exactly correct for the
 * cadences a task scheduler uses.
 */
export function nextRun(schedule: CronSchedule, afterMs: number): number | null {
  const d = new Date(afterMs)
  // Advance to the start of the next whole minute (strictly after `afterMs`).
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  for (let i = 0; i < MAX_LOOKAHEAD_MINUTES; i++) {
    if (cronMatches(schedule, d)) return d.getTime()
    d.setMinutes(d.getMinutes() + 1)
  }
  return null
}

// ── Scheduler ────────────────────────────────────────────────────────────────

/** Time source (injected so tests use a fake clock). */
export interface SchedulerClock {
  now(): number
}

/** Durable persistence for tasks flagged `durable` (DB-backed in production). */
export interface ScheduledTaskStore {
  /** All durable tasks (loaded once at construction). */
  list(): ScheduledTask[]
  /** Insert or replace a durable task. */
  upsert(task: ScheduledTask): void
  /** Delete a durable task by id (no-op if absent). */
  remove(id: string): void
}

/** Everything the {@link Scheduler} needs from the outside world. */
export interface SchedulerDeps {
  clock: SchedulerClock
  store: ScheduledTaskStore
  /** Called when a task comes due — enqueue/run it. Must not throw. */
  fire: (task: ScheduledTask) => void
}

/**
 * Holds all scheduled tasks (durable ones loaded from the store, session-only
 * ones added at runtime), advances their `nextRunAt`, and fires each when due.
 *
 * `tick()` is the heart: called on an interval in production, and by hand in
 * tests with a fake clock. It fires every enabled task whose `nextRunAt` has
 * passed, records `lastRunAt`, then recomputes the following `nextRunAt`.
 */
export class Scheduler {
  private readonly clock: SchedulerClock
  private readonly store: ScheduledTaskStore
  private readonly fire: (task: ScheduledTask) => void
  private readonly tasks = new Map<string, ScheduledTask>()
  private idCounter = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: SchedulerDeps) {
    this.clock = deps.clock
    this.store = deps.store
    this.fire = deps.fire
    // Rehydrate durable tasks, recomputing each nextRunAt against "now" so a task
    // that was due while the app was closed fires promptly on the next tick.
    for (const task of this.store.list()) {
      this.tasks.set(task.id, { ...task, nextRunAt: this.computeNext(task) })
    }
  }

  /** Next fire time for a task, or undefined when it's paused or its cron is impossible. */
  private computeNext(task: ScheduledTask): number | undefined {
    if (!task.enabled) return undefined
    const schedule = parseCron(task.cron)
    if (!schedule) return undefined
    return nextRun(schedule, this.clock.now()) ?? undefined
  }

  private nextId(now: number): string {
    this.idCounter += 1
    return `sched-${now}-${this.idCounter}`
  }

  /** All tasks, soonest-due first (paused/never-due tasks sort last). */
  list(): ScheduledTask[] {
    return [...this.tasks.values()].sort((a, b) => {
      const an = a.nextRunAt ?? Number.POSITIVE_INFINITY
      const bn = b.nextRunAt ?? Number.POSITIVE_INFINITY
      if (an !== bn) return an - bn
      return a.createdAt - b.createdAt
    })
  }

  /** Add a task. Throws on an invalid cron so the caller can surface the error. */
  add(input: ScheduledTaskInput): ScheduledTask {
    if (!isValidCron(input.cron)) throw new Error(`Invalid cron expression: ${input.cron}`)
    const now = this.clock.now()
    const task: ScheduledTask = {
      id: this.nextId(now),
      name: input.name.trim() || 'Untitled task',
      prompt: input.prompt,
      cron: input.cron.trim(),
      enabled: input.enabled ?? true,
      durable: input.durable ?? false,
      ...(input.mode ? { mode: input.mode } : {}),
      createdAt: now,
      updatedAt: now
    }
    task.nextRunAt = this.computeNext(task)
    this.tasks.set(task.id, task)
    if (task.durable) this.store.upsert(task)
    return task
  }

  /** Replace a task's editable fields. Returns the updated task, or null if unknown. */
  update(id: string, input: ScheduledTaskInput): ScheduledTask | null {
    const existing = this.tasks.get(id)
    if (!existing) return null
    if (!isValidCron(input.cron)) throw new Error(`Invalid cron expression: ${input.cron}`)
    const wasDurable = existing.durable
    const next: ScheduledTask = {
      ...existing,
      name: input.name.trim() || existing.name,
      prompt: input.prompt,
      cron: input.cron.trim(),
      enabled: input.enabled ?? existing.enabled,
      durable: input.durable ?? existing.durable,
      mode: input.mode ?? existing.mode,
      updatedAt: this.clock.now()
    }
    next.nextRunAt = this.computeNext(next)
    this.tasks.set(id, next)
    this.persistAfterUpdate(next, wasDurable)
    return next
  }

  /** Pause or resume a task. Returns the updated task, or null if unknown. */
  setEnabled(id: string, enabled: boolean): ScheduledTask | null {
    const existing = this.tasks.get(id)
    if (!existing) return null
    const next: ScheduledTask = { ...existing, enabled, updatedAt: this.clock.now() }
    next.nextRunAt = this.computeNext(next)
    this.tasks.set(id, next)
    if (next.durable) this.store.upsert(next)
    return next
  }

  /** Delete a task (from memory and, if it was durable, from the store). */
  remove(id: string): void {
    const existing = this.tasks.get(id)
    if (!existing) return
    this.tasks.delete(id)
    if (existing.durable) this.store.remove(id)
  }

  /** Reconcile the store after an update that may have flipped `durable`. */
  private persistAfterUpdate(task: ScheduledTask, wasDurable: boolean): void {
    if (task.durable) this.store.upsert(task)
    else if (wasDurable) this.store.remove(task.id)
  }

  /**
   * Fire every enabled task that has come due, then schedule its next run. A task
   * whose cron became impossible (nextRun → null) is left with `nextRunAt`
   * undefined so it stops firing rather than spinning. `fire` is guarded so one
   * throwing task can't abort the sweep.
   */
  tick(): void {
    const now = this.clock.now()
    for (const task of this.tasks.values()) {
      if (!task.enabled || task.nextRunAt === undefined) continue
      if (task.nextRunAt > now) continue
      task.lastRunAt = now
      const schedule = parseCron(task.cron)
      task.nextRunAt = schedule ? (nextRun(schedule, now) ?? undefined) : undefined
      task.updatedAt = now
      if (task.durable) this.store.upsert(task)
      try {
        this.fire(task)
      } catch (err) {
        console.error('[sylor] scheduled task fire failed:', err)
      }
    }
  }

  /** Begin ticking every `intervalMs`. Idempotent (a running timer is replaced). */
  start(intervalMs: number): void {
    this.stop()
    this.timer = setInterval(() => this.tick(), intervalMs)
    // Don't let the interval keep the process alive on its own (main-process only).
    this.timer.unref?.()
  }

  /** Stop ticking. Safe to call when not started. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
