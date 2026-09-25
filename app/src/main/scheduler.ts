import type { ScheduledTask } from '../shared/types'
import { listDueScheduledTasks, markScheduledTaskFired } from './db/scheduled-tasks'

/**
 * The scheduled-tasks runtime (#12): a lightweight cron tick that fires durable
 * tasks when they come due. Deliberately electron-free — it depends only on the DB
 * layer and a `onFire` callback the IPC layer wires to the renderer — so the cron
 * math is unit-testable without a window or a native module.
 *
 * Cron is a standard 5-field expression `min hour dom month dow` evaluated in LOCAL
 * time. Fields accept `*`, a number, a list `a,b`, a range `a-b`, and a step suffix
 * `/n` (on `*` or a range). When BOTH day-of-month and day-of-week are restricted the
 * match is on EITHER (the traditional Vixie-cron rule). `dow` is 0–6 with 0 = Sunday
 * (7 also accepted for Sunday).
 */

interface CronSpec {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  /** True when the field was `*` — needed for the dom/dow OR rule. */
  domStar: boolean
  dowStar: boolean
}

/** Parse one cron field into the set of matching values, or null if malformed. */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    if (part === '') return null
    const [rangePart, stepPart] = part.split('/')
    let step = 1
    if (stepPart !== undefined) {
      step = Number(stepPart)
      if (!Number.isInteger(step) || step <= 0) return null
    }
    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = min
      hi = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-')
      lo = Number(a)
      hi = Number(b)
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null
    } else {
      lo = Number(rangePart)
      hi = lo
      if (!Number.isInteger(lo)) return null
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size > 0 ? out : null
}

/** Parse a 5-field cron expression, or null if it is malformed. */
export function parseCron(expr: string): CronSpec | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minute = parseField(fields[0], 0, 59)
  const hour = parseField(fields[1], 0, 23)
  const dom = parseField(fields[2], 1, 31)
  const month = parseField(fields[3], 1, 12)
  // Accept 7 as Sunday, then normalise to 0 so matching only checks 0–6.
  const dowRaw = parseField(fields[4], 0, 7)
  if (!minute || !hour || !dom || !month || !dowRaw) return null
  const dow = new Set<number>([...dowRaw].map((d) => (d === 7 ? 0 : d)))
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domStar: fields[2] === '*',
    dowStar: fields[4] === '*'
  }
}

/** Whether a given local Date matches a parsed cron spec. */
export function cronMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getMinutes())) return false
  if (!spec.hour.has(d.getHours())) return false
  if (!spec.month.has(d.getMonth() + 1)) return false
  const domHit = spec.dom.has(d.getDate())
  const dowHit = spec.dow.has(d.getDay())
  // Vixie rule: if both day fields are restricted, either one matching is enough;
  // otherwise the (single) restricted field must match.
  if (!spec.domStar && !spec.dowStar) return domHit || dowHit
  if (!spec.domStar) return domHit
  if (!spec.dowStar) return dowHit
  return true
}

/**
 * The next epoch-ms firing time strictly after `from`, or null if the cron is
 * malformed or nothing matches within a year. Scans minute-by-minute from the next
 * whole minute — simple and exact, and a year is a safe bound for a 5-field cron.
 */
export function computeNextRun(expr: string, from: number): number | null {
  const spec = parseCron(expr)
  if (!spec) return null
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const limit = 366 * 24 * 60 // minutes in a (leap) year
  for (let i = 0; i < limit; i++) {
    if (cronMatches(spec, d)) return d.getTime()
    d.setMinutes(d.getMinutes() + 1)
  }
  return null
}

/** The scheduler handle returned by {@link createScheduler}. */
export interface Scheduler {
  /** Begin ticking (idempotent). */
  start: () => void
  /** Stop ticking and clear the interval. */
  stop: () => void
  /** Run one due-check immediately (also called on each interval). */
  tick: () => void
}

export interface SchedulerOptions {
  /** Called for each task that comes due; wired to push a fire to the renderer. */
  onFire: (task: ScheduledTask) => void
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Tick cadence in ms. Defaults to 30s — cron resolution is a minute. */
  intervalMs?: number
}

/**
 * Build the scheduler. Each tick reads the due tasks, fires them, and stamps each
 * with its recomputed `next_run_at`. Firing is fail-soft: a throw from `onFire` (or
 * a bad cron that yields no next run) never wedges the loop for other tasks.
 */
export function createScheduler(opts: SchedulerOptions): Scheduler {
  const now = opts.now ?? Date.now
  const intervalMs = opts.intervalMs ?? 30_000
  let timer: ReturnType<typeof setInterval> | null = null

  const tick = (): void => {
    const at = now()
    let due: ScheduledTask[]
    try {
      due = listDueScheduledTasks(at)
    } catch {
      return // DB not ready / transient fault — try again next tick.
    }
    for (const task of due) {
      // Reschedule first so a throwing onFire can't cause a tight re-fire loop.
      const next = computeNextRun(task.cron, at)
      try {
        markScheduledTaskFired(task.id, at, next)
      } catch {
        // best-effort — a persistence hiccup shouldn't drop the fire.
      }
      try {
        opts.onFire(task)
      } catch {
        // A renderer that isn't listening yet must not break the tick.
      }
    }
  }

  return {
    start: () => {
      if (timer) return
      timer = setInterval(tick, intervalMs)
    },
    stop: () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    tick
  }
}
