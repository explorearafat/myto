/**
 * The New-Chat zero-state dashboard (items 7, 8). A calm, centered surface shown
 * whenever the chat has no messages yet.
 *
 * Every figure here is real: it comes from `sessions.usageStats()`, which
 * aggregates the actual SQLite history (sessions, messages, per-day activity,
 * per-model turns) in the main process. A fresh install therefore reads as
 * honest zeros, and a used one reads as the user's own record. The only estimate
 * is the token count — Sylor never asks the gateway for usage figures — so it is
 * always shown with a `~`. The greeting uses the OS display name
 * (`window.sylor.userName`) when available and gracefully drops the name when it
 * isn't.
 */
import { useEffect, useState } from 'react'
import type { DayBucket, UsageStats } from '@shared/types'
import {
  activeDaysInWindow,
  formatPeakHour,
  formatRelativeDay,
  formatTokens,
  GRID_WEEKS
} from '@shared/usage'

/** A single labelled metric. `value` is a string so the "no data yet" metrics
 * can render an em-dash rather than a misleading 0. `small` drops the value to a
 * text-sized line for word values (model names), which would otherwise truncate
 * after ~9 characters at the numeral size. */
function Stat({
  label,
  value,
  suffix,
  hint,
  small
}: {
  label: string
  value: string
  suffix?: string
  hint?: string
  small?: boolean
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-xl bg-surface-2/50 px-4 py-3 transition-colors hover:bg-surface-2"
      title={hint}
    >
      <span className="text-[11px] font-normal tracking-wide text-muted">{label}</span>
      <span
        className={`truncate text-text tabular-nums ${
          small
            ? 'text-[14px] font-normal leading-[22px] tracking-normal'
            : 'text-[22px] font-light leading-none tracking-tight'
        }`}
      >
        {value}
        {suffix && <span className="ml-0.5 text-[13px] font-normal text-muted">{suffix}</span>}
      </span>
    </div>
  )
}

/**
 * Five-step intensity for a day cell, scaled against the busiest day in the
 * window so a light week still shows contrast (a fixed scale would leave every
 * cell at the palest shade for most users). Level 0 is "nothing happened".
 */
function shadeLevel(count: number, max: number): number {
  if (count <= 0) return 0
  if (max <= 1) return 4
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4)))
}

const SHADES = [
  'bg-surface-2/70',
  'bg-primary/25',
  'bg-primary/45',
  'bg-primary/70',
  'bg-primary'
] as const

/** Cell count of a full grid — also the placeholder length while stats load. */
const GRID_CELLS = GRID_WEEKS * 7

/**
 * The contribution-style activity grid: one column per week, one row per weekday,
 * ending on the current week. Cells carry a `title` tooltip with the exact day and
 * count; the grid itself stays hidden from assistive tech because the caption
 * beside it states the same summary in words.
 *
 * `days` is null until the stats query resolves — the grid then draws the same
 * number of inert cells so the panel's height never jumps.
 */
function ActivityGrid({ days }: { days: DayBucket[] | null }) {
  const max = days ? days.reduce((m, d) => (d.count > m ? d.count : m), 0) : 0
  const active = days ? activeDaysInWindow(days) : 0
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] tracking-wide text-muted">Activity</span>
        <span className="text-[11px] text-muted">
          {days == null
            ? ''
            : active === 0
              ? 'No activity yet'
              : `${active} active day${active === 1 ? '' : 's'} in the last ${GRID_WEEKS} weeks`}
        </span>
      </div>
      <div
        className="grid grid-flow-col gap-1 overflow-hidden"
        style={{ gridTemplateRows: 'repeat(7, minmax(0, 1fr))' }}
        aria-hidden="true"
      >
        {days
          ? days.map((d) => (
              <span
                key={d.date}
                title={
                  d.future ? undefined : `${d.date} · ${d.count} message${d.count === 1 ? '' : 's'}`
                }
                className={`h-2.5 w-2.5 rounded-[3px] ${
                  d.future ? 'bg-transparent' : SHADES[shadeLevel(d.count, max)]
                }`}
              />
            ))
          : Array.from({ length: GRID_CELLS }).map((_, i) => (
              <span key={i} className="h-2.5 w-2.5 rounded-[3px] bg-surface-2/70" />
            ))}
      </div>
    </div>
  )
}

/** The full zero-state: greeting, real stats, and the activity grid. */
export function ZeroStateDashboard() {
  // The OS display name is a plain sync bridge property (never sent anywhere);
  // fall back to a name-less greeting when it isn't available.
  const name = (typeof window !== 'undefined' && window.sylor?.userName) || ''
  const greeting = name ? `What’s up next, ${name}?` : 'What’s up next?'

  const [stats, setStats] = useState<UsageStats | null>(null)

  // Load once per mount. The zero state only exists between chats, so every New
  // Chat is a natural (and cheap) refresh point — no polling or cache needed.
  useEffect(() => {
    let live = true
    void window.sylor?.sessions
      ?.usageStats()
      .then((s) => {
        if (live) setStats(s)
      })
      .catch(() => {
        // Stats are decoration on a welcome screen; a failure just leaves the
        // placeholders in place rather than surfacing an error here.
      })
    return () => {
      live = false
    }
  }, [])

  // Until the (local, sub-millisecond) query resolves, show em-dashes rather
  // than zeros — a flash of "0 sessions" would misreport a busy history.
  const dash = '—'
  const num = (n: number | undefined): string => (stats ? String(n ?? 0) : dash)
  const hasHistory = (stats?.messages ?? 0) > 0

  const statCards: {
    label: string
    value: string
    suffix?: string
    hint?: string
    small?: boolean
  }[] = [
    { label: 'Sessions', value: num(stats?.sessions), hint: 'Conversations with at least one message' },
    { label: 'Messages', value: num(stats?.messages), hint: 'Your turns and Sylor’s, across all chats' },
    {
      label: 'Total tokens',
      value: stats ? `~${formatTokens(stats.tokens)}` : dash,
      hint: 'Estimated at ~4 characters per token across messages and tool payloads'
    },
    { label: 'Active days', value: num(stats?.activeDays), hint: 'Distinct days you’ve used Sylor' },
    {
      label: 'Current streak',
      value: num(stats?.currentStreak),
      suffix: stats ? 'd' : undefined,
      hint: 'Consecutive days up to today'
    },
    {
      label: 'Longest streak',
      value: num(stats?.longestStreak),
      suffix: stats ? 'd' : undefined,
      hint: 'Your best run of consecutive days'
    },
    {
      label: 'Peak hour',
      value: stats ? formatPeakHour(stats.peakHour) : dash,
      hint: 'The hour of day you send the most'
    },
    {
      label: 'Favorite model',
      value: stats?.favoriteModel ?? dash,
      // Model ids are words, not numerals, so they get the smaller line — at the
      // numeral size a name like "Claude Sonnet 5" truncates mid-word.
      small: true,
      hint: stats?.favoriteModel ?? 'The model behind most of your replies'
    }
  ]

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto px-4 py-8">
      <div className="w-full max-w-2xl motion-safe:animate-[fill-in_.4s_ease-out]">
        {/* Greeting */}
        <div className="mb-6 text-center">
          <h1 className="text-[26px] font-light leading-tight tracking-tight text-text sm:text-[30px]">
            {greeting}
          </h1>
          <p className="mx-auto mt-2 max-w-md text-[13px] font-normal leading-relaxed text-muted">
            {hasHistory && stats
              ? `${stats.activeDays} day${stats.activeDays === 1 ? '' : 's'} of work so far — last active ${formatRelativeDay(stats.lastActiveAt, Date.now())}.`
              : 'This is your space. Start a conversation and your sessions, streaks, and activity will take shape here.'}
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {statCards.map((s) => (
            <Stat
              key={s.label}
              label={s.label}
              value={s.value}
              suffix={s.suffix}
              hint={s.hint}
              small={s.small}
            />
          ))}
        </div>

        {/* Activity */}
        <div className="mt-4 rounded-xl bg-surface/60 p-4">
          <ActivityGrid days={stats?.days ?? null} />
        </div>
      </div>
    </div>
  )
}
