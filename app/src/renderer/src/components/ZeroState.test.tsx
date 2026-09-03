import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import { ZeroStateDashboard } from '@renderer/components/ZeroState'
import { computeUsageStats, emptyUsageStats, GRID_WEEKS } from '@shared/usage'
import type { UsageFacts } from '@shared/types'

/**
 * Wiring test for the zero-state dashboard: it must render whatever
 * `sessions.usageStats()` reports, not the hard-coded zeros it used to show. The
 * calendar maths itself is covered by `shared/usage.test.ts`, so the fixture goes
 * through the real `computeUsageStats` and the assertions here are about what
 * reaches the screen.
 *
 * Timestamps are built relative to the machine's own "today" (local noon, so no
 * DST edge can shift a day) — that keeps `today`/`yesterday` copy deterministic
 * whenever the suite runs.
 */
const usageStats = (): Mock => window.sylor.sessions.usageStats as unknown as Mock

const noonToday = (): Date => {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  return d
}

const daysAgo = (n: number): number => {
  const d = noonToday()
  d.setDate(d.getDate() - n)
  d.setHours(12, 0, 0, 0)
  return d.getTime()
}

const facts: UsageFacts = {
  sessions: 12,
  messages: 48,
  tokens: 9600,
  // Two on today, one yesterday, one last week → 3 active days, 2-day streak.
  timestamps: [daysAgo(0), daysAgo(0), daysAgo(1), daysAgo(5)],
  models: [
    { model: 'Claude Sonnet 5', count: 9 },
    { model: 'llama3.1:8b', count: 2 }
  ]
}

/** The Stat card wrapping a label, so a value can be asserted next to its name. */
const card = (label: string): HTMLElement => screen.getByText(label).parentElement as HTMLElement

describe('ZeroStateDashboard', () => {
  it('renders the real figures reported by the main process', async () => {
    usageStats().mockResolvedValue(computeUsageStats(facts, Date.now()))
    render(<ZeroStateDashboard />)

    await waitFor(() => expect(card('Sessions')).toHaveTextContent('12'))
    expect(card('Messages')).toHaveTextContent('48')
    // Tokens are an estimate, so they must stay marked with a tilde.
    expect(card('Total tokens')).toHaveTextContent('~9.6k')
    expect(card('Active days')).toHaveTextContent('3')
    expect(card('Current streak')).toHaveTextContent('2')
    expect(card('Longest streak')).toHaveTextContent('2')
    expect(card('Peak hour')).toHaveTextContent('12 PM')
    expect(card('Favorite model')).toHaveTextContent('Claude Sonnet 5')
  })

  it('swaps the intro copy once there is history', async () => {
    usageStats().mockResolvedValue(computeUsageStats(facts, Date.now()))
    render(<ZeroStateDashboard />)

    await waitFor(() => expect(screen.getByText(/3 days of work so far/)).toBeInTheDocument())
    expect(screen.getByText(/last active today/)).toBeInTheDocument()
  })

  it('draws one grid cell per day of the window and captions the active ones', async () => {
    usageStats().mockResolvedValue(computeUsageStats(facts, Date.now()))
    const { container } = render(<ZeroStateDashboard />)

    await waitFor(() =>
      expect(screen.getByText(`3 active days in the last ${GRID_WEEKS} weeks`)).toBeInTheDocument()
    )
    const cells = container.querySelectorAll('[aria-hidden="true"] > span')
    expect(cells).toHaveLength(GRID_WEEKS * 7)
  })

  it('keeps the honest fresh-install state when there is no history', async () => {
    usageStats().mockResolvedValue(emptyUsageStats(Date.now()))
    render(<ZeroStateDashboard />)

    await waitFor(() => expect(screen.getByText('No activity yet')).toBeInTheDocument())
    expect(card('Sessions')).toHaveTextContent('0')
    expect(card('Peak hour')).toHaveTextContent('—')
    expect(card('Favorite model')).toHaveTextContent('—')
    expect(screen.getByText(/This is your space/)).toBeInTheDocument()
  })

  it('shows placeholders instead of zeros while the query is in flight', () => {
    usageStats().mockReturnValue(new Promise(() => {}))
    render(<ZeroStateDashboard />)

    // A flash of "0 sessions" would misreport a busy history, so unloaded stats
    // read as em-dashes and the grid keeps its shape with inert cells.
    expect(card('Sessions')).toHaveTextContent('—')
    expect(card('Messages')).toHaveTextContent('—')
  })

  it('leaves the placeholders in place when the stats read fails', async () => {
    usageStats().mockRejectedValue(new Error('db locked'))
    render(<ZeroStateDashboard />)

    await waitFor(() => expect(card('Sessions')).toHaveTextContent('—'))
  })
})
