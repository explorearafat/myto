import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusLine } from '@renderer/components/ChatPanel'
import type { ActivityStatus, RunProgressUI } from '@renderer/store/useChatStore'

/**
 * §33 — the live status row must be able to say where the whole build stands
 * (phase, tasks, checks, preview) while staying ONE row. The accumulating ✓
 * timeline was rejected, so these tests pin both halves of that: the chips show
 * up when the engine reports progress, and the row stays a single element that
 * says nothing extra when there's no roadmap behind the turn.
 */
const status: ActivityStatus = { stage: 'generating', message: 'Editing App.tsx…' }

/** The status row itself (the only element carrying the live region). */
const row = (): HTMLElement => screen.getByRole('status')

describe('StatusLine progress chips (§33)', () => {
  it('reports the phase, the task tally, the checks and the preview on one row', () => {
    const progress: RunProgressUI = {
      phase: { n: 3, total: 9, name: 'Core flow' },
      tasks: { done: 2, total: 4 },
      checks: 'PASSING',
      preview: 'RUNNING'
    }
    render(<StatusLine status={status} progress={progress} tokens={4200} />)

    const text = row().textContent ?? ''
    expect(text).toContain('3/9')
    expect(text).toContain('Core flow')
    expect(text).toContain('Editing App.tsx…')
    expect(text).toContain('2/4 tasks')
    expect(text).toContain('checks ✓')
    expect(text).toContain('preview live')
    expect(text).toContain('~4.2k tokens')
    // One row, not a block: the whole thing is a single flex line.
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('says the preview is stale rather than presenting it as current (§23)', () => {
    render(
      <StatusLine
        status={status}
        progress={{ phase: { n: 2, total: 5, name: 'Data' }, checks: 'FAILING', preview: 'STALE' }}
        tokens={0}
      />
    )
    const text = row().textContent ?? ''
    expect(text).toContain('preview stale')
    expect(text).toContain('checks !')
    expect(text).not.toContain('checks ✓')
  })

  it('stays a plain line for a one-off edit with no roadmap behind it', () => {
    render(<StatusLine status={status} progress={null} tokens={0} />)
    const text = row().textContent ?? ''
    expect(text).toContain('Editing App.tsx…')
    expect(text).not.toContain('tasks')
    expect(text).not.toContain('checks')
    expect(text).not.toContain('preview')
  })

  it('omits a check chip the engine could not vouch for', () => {
    render(
      <StatusLine
        status={status}
        progress={{ phase: { n: 1, total: 3, name: 'Foundation' }, checks: 'UNKNOWN' }}
        tokens={0}
      />
    )
    // §34 — nothing ran, so the row claims nothing: no ✓ and no warning either.
    expect(row().textContent).not.toContain('checks')
    expect(row().textContent).toContain('1/3')
  })
})
