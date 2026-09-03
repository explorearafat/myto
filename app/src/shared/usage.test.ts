import { describe, expect, it } from 'vitest'
import {
  activeDaysInWindow,
  computeUsageStats,
  dayKey,
  emptyUsageStats,
  formatPeakHour,
  formatRelativeDay,
  formatTokens,
  GRID_WEEKS
} from '@shared/usage'
import type { UsageFacts } from '@shared/types'

/**
 * All bucketing is in the machine's LOCAL time, so every fixture is built with
 * the local `Date(y, m, d, h)` constructor rather than `Date.UTC` — that keeps
 * the suite timezone-independent instead of accidentally asserting UTC days.
 *
 * The reference "now" is Wednesday 2 September 2026, 10:30 local.
 */
const NOW = new Date(2026, 8, 2, 10, 30).getTime()
const at = (month: number, day: number, hour = 12): number =>
  new Date(2026, month, day, hour).getTime()

const facts = (over: Partial<UsageFacts> = {}): UsageFacts => ({
  sessions: 0,
  messages: 0,
  tokens: 0,
  timestamps: [],
  models: [],
  ...over
})

describe('dayKey', () => {
  it('formats the local calendar day, zero-padded', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05')
  })
})

describe('computeUsageStats', () => {
  it('passes the raw counters straight through', () => {
    const s = computeUsageStats(facts({ sessions: 4, messages: 37, tokens: 12_345 }), NOW)
    expect(s.sessions).toBe(4)
    expect(s.messages).toBe(37)
    expect(s.tokens).toBe(12_345)
  })

  it('counts distinct local days as active days', () => {
    const s = computeUsageStats(
      // Three stamps, two of them on the same day.
      facts({ timestamps: [at(7, 30, 9), at(7, 30, 21), at(8, 1)] }),
      NOW
    )
    expect(s.activeDays).toBe(2)
  })

  it('tracks the last active instant', () => {
    const s = computeUsageStats(facts({ timestamps: [at(8, 1), at(7, 30)] }), NOW)
    expect(s.lastActiveAt).toBe(at(8, 1))
  })

  it('reports no activity for an empty history', () => {
    const s = emptyUsageStats(NOW)
    expect(s.activeDays).toBe(0)
    expect(s.currentStreak).toBe(0)
    expect(s.longestStreak).toBe(0)
    expect(s.peakHour).toBeNull()
    expect(s.favoriteModel).toBeNull()
    expect(s.lastActiveAt).toBeNull()
    expect(activeDaysInWindow(s.days)).toBe(0)
  })

  describe('streaks', () => {
    it('counts a run that reaches today', () => {
      const s = computeUsageStats(facts({ timestamps: [at(7, 31), at(8, 1), at(8, 2)] }), NOW)
      expect(s.currentStreak).toBe(3)
      expect(s.longestStreak).toBe(3)
    })

    it('keeps the streak alive when the last activity was yesterday', () => {
      const s = computeUsageStats(facts({ timestamps: [at(7, 31), at(8, 1)] }), NOW)
      expect(s.currentStreak).toBe(2)
    })

    it('drops the current streak once the run is broken', () => {
      // Ended 2 days before "now" — no longer live.
      const s = computeUsageStats(facts({ timestamps: [at(7, 29), at(7, 30), at(7, 31)] }), NOW)
      expect(s.currentStreak).toBe(0)
      expect(s.longestStreak).toBe(3)
    })

    it('remembers the longest historic run alongside a shorter live one', () => {
      const s = computeUsageStats(
        facts({
          timestamps: [at(6, 1), at(6, 2), at(6, 3), at(6, 4), at(8, 1), at(8, 2)]
        }),
        NOW
      )
      expect(s.longestStreak).toBe(4)
      expect(s.currentStreak).toBe(2)
    })

    it('handles a single active day', () => {
      const s = computeUsageStats(facts({ timestamps: [at(8, 2)] }), NOW)
      expect(s.currentStreak).toBe(1)
      expect(s.longestStreak).toBe(1)
    })
  })

  describe('peak hour', () => {
    it('picks the busiest local hour', () => {
      const s = computeUsageStats(
        facts({ timestamps: [at(8, 1, 9), at(8, 1, 21), at(8, 2, 21)] }),
        NOW
      )
      expect(s.peakHour).toBe(21)
    })

    it('breaks ties toward the earlier hour so the value is stable', () => {
      const s = computeUsageStats(facts({ timestamps: [at(8, 1, 8), at(8, 2, 17)] }), NOW)
      expect(s.peakHour).toBe(8)
    })
  })

  describe('favourite model', () => {
    it('picks the most-used label', () => {
      const s = computeUsageStats(
        facts({
          models: [
            { model: 'Claude Sonnet 5', count: 3 },
            { model: 'Llama 3.1', count: 11 }
          ]
        }),
        NOW
      )
      expect(s.favoriteModel).toBe('Llama 3.1')
    })

    it('stays null when no turn recorded a model', () => {
      expect(computeUsageStats(facts({ messages: 6 }), NOW).favoriteModel).toBeNull()
    })
  })

  describe('contribution grid', () => {
    it('spans whole weeks, starting on a Sunday and ending on this Saturday', () => {
      const { days } = computeUsageStats(facts(), NOW)
      expect(days).toHaveLength(GRID_WEEKS * 7)
      const [y, m, d] = days[0].date.split('-').map(Number)
      expect(new Date(y, m - 1, d).getDay()).toBe(0)
      // "Now" is Wednesday 2 Sep 2026, so the window closes on Saturday the 5th.
      expect(days[days.length - 1].date).toBe('2026-09-05')
    })

    it('marks the days after today as future padding', () => {
      const { days } = computeUsageStats(facts(), NOW)
      // Thursday, Friday and Saturday of the current week haven't happened yet.
      expect(days.filter((x) => x.future)).toHaveLength(3)
      expect(days.find((x) => x.date === '2026-09-02')?.future).toBe(false)
    })

    it('fills each cell with that day’s message count', () => {
      const { days } = computeUsageStats(
        facts({ timestamps: [at(8, 1, 9), at(8, 1, 10), at(8, 2)] }),
        NOW
      )
      expect(days.find((x) => x.date === '2026-09-01')?.count).toBe(2)
      expect(days.find((x) => x.date === '2026-09-02')?.count).toBe(1)
      expect(days.find((x) => x.date === '2026-08-31')?.count).toBe(0)
      expect(activeDaysInWindow(days)).toBe(2)
    })

    it('counts activity older than the window in the all-time total only', () => {
      const old = new Date(2024, 0, 15, 12).getTime()
      const s = computeUsageStats(facts({ timestamps: [old] }), NOW)
      expect(s.activeDays).toBe(1)
      expect(activeDaysInWindow(s.days)).toBe(0)
    })
  })
})

describe('formatters', () => {
  it('renders a 12-hour peak hour', () => {
    expect(formatPeakHour(0)).toBe('12 AM')
    expect(formatPeakHour(9)).toBe('9 AM')
    expect(formatPeakHour(12)).toBe('12 PM')
    expect(formatPeakHour(21)).toBe('9 PM')
    expect(formatPeakHour(null)).toBe('—')
  })

  it('compacts token counts', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(940)).toBe('940')
    expect(formatTokens(1200)).toBe('1.2k')
    expect(formatTokens(12_300)).toBe('12k')
    expect(formatTokens(1_240_000)).toBe('1.2M')
    expect(formatTokens(24_000_000)).toBe('24M')
  })

  it('describes how long ago a day was, locale-free', () => {
    expect(formatRelativeDay(null, NOW)).toBe('never')
    expect(formatRelativeDay(at(8, 2, 8), NOW)).toBe('today')
    expect(formatRelativeDay(at(8, 1), NOW)).toBe('yesterday')
    expect(formatRelativeDay(at(7, 29), NOW)).toBe('4 days ago')
    expect(formatRelativeDay(new Date(2026, 5, 2, 12).getTime(), NOW)).toBe('3 months ago')
    expect(formatRelativeDay(new Date(2025, 8, 2, 12).getTime(), NOW)).toBe('1 year ago')
  })
})
