/**
 * Pure activity/usage analytics: turns the raw {@link UsageFacts} the DB layer
 * reads out of SQLite into the {@link UsageStats} the zero-state dashboard
 * renders (active days, streaks, peak hour, favourite model, contribution grid).
 *
 * Deliberately free of both `electron` and any DB import so every calendar rule
 * — day bucketing, streak continuity, the grid window — is unit-testable with a
 * fixed clock. All bucketing is in **local** time (the user's own days, not UTC)
 * and uses `Date` field arithmetic rather than adding 86 400 000 ms, so a DST
 * shift can't drop or duplicate a day.
 */
import type { DayBucket, UsageFacts, UsageStats } from './types'

/** Weeks (columns) shown in the contribution grid. */
export const GRID_WEEKS = 20

/** Days per grid column. */
const WEEK_DAYS = 7

/** Local midnight of the day containing `ts`. */
function startOfLocalDay(ts: number): Date {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d
}

/**
 * `delta` days from local midnight `d`, re-normalised to midnight — a DST
 * boundary can shift the wall clock by an hour, which would otherwise leave the
 * cursor at 23:00 the previous day and silently repeat a date.
 */
function shiftDays(d: Date, delta: number): Date {
  const out = new Date(d.getTime())
  out.setDate(out.getDate() + delta)
  out.setHours(0, 0, 0, 0)
  return out
}

/** `YYYY-MM-DD` for a local `Date`. */
function keyOf(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** The local calendar day an instant falls on, as `YYYY-MM-DD`. */
export function dayKey(ts: number): string {
  return keyOf(startOfLocalDay(ts))
}

/** Parse a `YYYY-MM-DD` key back to local midnight. */
function dateOfKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * Longest and current runs of consecutive active days. `current` counts the run
 * that reaches today or yesterday and is 0 otherwise — a streak shouldn't break
 * just because the user hasn't opened Sylor yet this morning, but it also
 * shouldn't keep claiming a run that ended last week.
 */
function streaks(sortedKeys: string[], today: Date): { current: number; longest: number } {
  if (sortedKeys.length === 0) return { current: 0, longest: 0 }

  let longest = 1
  let run = 1
  let runStartIndex = 0
  for (let i = 1; i < sortedKeys.length; i++) {
    const expected = keyOf(shiftDays(dateOfKey(sortedKeys[i - 1]), 1))
    if (sortedKeys[i] === expected) {
      run += 1
    } else {
      run = 1
      runStartIndex = i
    }
    if (run > longest) longest = run
  }

  // The trailing run is "current" only if it touches today or yesterday.
  const last = sortedKeys[sortedKeys.length - 1]
  const todayKey = keyOf(today)
  const yesterdayKey = keyOf(shiftDays(today, -1))
  const live = last === todayKey || last === yesterdayKey
  const current = live ? sortedKeys.length - runStartIndex : 0
  return { current, longest }
}

/**
 * Fold raw facts into the dashboard figures, relative to `now` (injected so
 * tests own the clock).
 */
export function computeUsageStats(facts: UsageFacts, now: number): UsageStats {
  const perDay = new Map<string, number>()
  const perHour = new Array<number>(24).fill(0)
  let lastActiveAt: number | null = null

  for (const ts of facts.timestamps) {
    if (!Number.isFinite(ts) || ts <= 0) continue
    const at = new Date(ts)
    const key = keyOf(at)
    perDay.set(key, (perDay.get(key) ?? 0) + 1)
    perHour[at.getHours()] += 1
    if (lastActiveAt == null || ts > lastActiveAt) lastActiveAt = ts
  }

  // Peak hour: the busiest local hour, earliest on a tie so the value is stable
  // across reads. Null (rendered as an em-dash) when nothing is dated.
  let peakHour: number | null = null
  let peakCount = 0
  for (let h = 0; h < 24; h++) {
    if (perHour[h] > peakCount) {
      peakCount = perHour[h]
      peakHour = h
    }
  }

  let favoriteModel: string | null = null
  let favoriteCount = 0
  for (const entry of facts.models) {
    if (entry.count > favoriteCount || (entry.count === favoriteCount && favoriteModel === null)) {
      favoriteCount = entry.count
      favoriteModel = entry.model
    }
  }

  const today = startOfLocalDay(now)
  const { current, longest } = streaks([...perDay.keys()].sort(), today)

  // Grid window: end on the Saturday of the current week so today's column is
  // the last one and every row is a fixed weekday, then walk back 20 weeks.
  const endOfWeek = shiftDays(today, WEEK_DAYS - 1 - today.getDay())
  const start = shiftDays(endOfWeek, -(GRID_WEEKS * WEEK_DAYS - 1))
  const days: DayBucket[] = []
  for (let i = 0; i < GRID_WEEKS * WEEK_DAYS; i++) {
    const d = shiftDays(start, i)
    const key = keyOf(d)
    days.push({ date: key, count: perDay.get(key) ?? 0, future: d.getTime() > today.getTime() })
  }

  return {
    sessions: facts.sessions,
    messages: facts.messages,
    tokens: facts.tokens,
    activeDays: perDay.size,
    currentStreak: current,
    longestStreak: longest,
    peakHour,
    favoriteModel,
    lastActiveAt,
    days
  }
}

/** An all-zero snapshot (fresh install, or a DB read that failed). */
export function emptyUsageStats(now: number): UsageStats {
  return computeUsageStats(
    { sessions: 0, messages: 0, tokens: 0, timestamps: [], models: [] },
    now
  )
}

/** Active days inside the grid window — what the grid's caption reports. */
export function activeDaysInWindow(days: DayBucket[]): number {
  return days.reduce((n, d) => (d.count > 0 ? n + 1 : n), 0)
}

/** `9 PM`, `12 AM`, or an em-dash when the hour is unknown. */
export function formatPeakHour(hour: number | null): string {
  if (hour == null || !Number.isInteger(hour) || hour < 0 || hour > 23) return '—'
  const suffix = hour < 12 ? 'AM' : 'PM'
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12} ${suffix}`
}

/** Compact count: `940`, `12.3k`, `1.2M`. Mirrors the composer's formatter. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

/**
 * How long ago a day was, in whole units and without locale formatting (so the
 * string is stable everywhere): `today`, `yesterday`, `4 days ago`,
 * `2 months ago`, `1 year ago`.
 */
export function formatRelativeDay(ts: number | null, now: number): string {
  if (ts == null) return 'never'
  const days = Math.round((startOfLocalDay(now).getTime() - startOfLocalDay(ts).getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  if (days < 365) {
    const months = Math.max(1, Math.round(days / 30))
    return `${months} month${months === 1 ? '' : 's'} ago`
  }
  const years = Math.max(1, Math.round(days / 365))
  return `${years} year${years === 1 ? '' : 's'} ago`
}
