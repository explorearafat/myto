import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ContextMeter } from '@renderer/components/ChatPanel'
import { useChatStore } from '@renderer/store/useChatStore'
import type { ContextUsage } from '@shared/types'

/**
 * Phase 4 — the footer meter. Every test here is about the denominator being
 * honest: the bar measures Sylor's OWN fold budget (the only limit that really
 * applies to a run), a model window is named only when Sylor actually knows it,
 * and with nothing measured the chip says it is showing an estimate instead of
 * drawing a bar against a number it never took.
 */
const usage = (over: Partial<ContextUsage> = {}): ContextUsage => ({
  chars: 60_000,
  budget: 240_000,
  systemChars: 20_000,
  historyChars: 20_000,
  assistantChars: 8_000,
  toolChars: 12_000,
  foldSteps: 0,
  ...over
})

/** The clickable meter (absent in the no-run fallback, which is deliberately inert). */
const meter = (): HTMLElement => screen.getByRole('button')

beforeEach(() => {
  useChatStore.setState({ usage: null })
})

describe('ContextMeter', () => {
  it('falls back to the renderer estimate, and says that is what it is', () => {
    render(<ContextMeter estimate={1234} />)

    const chip = screen.getByText('~1.2k tokens')
    expect(chip.getAttribute('title')).toContain('(estimate)')
    expect(chip.getAttribute('title')).toContain('A measured breakdown appears here')
    // No bar without a measurement: there is nothing to draw it against yet.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the measured load once the engine has taken a reading', () => {
    useChatStore.setState({ usage: usage() })
    render(<ContextMeter estimate={9_999} />)

    // 60k of 240k chars = 15k tokens at 25% — and the stale estimate is dropped.
    expect(screen.getByText('~15k tokens')).toBeTruthy()
    expect(screen.queryByText('~10.0k tokens')).toBeNull()
    expect(meter().getAttribute('title')).toBe(
      '25% of the fold budget in use · click for the breakdown'
    )
  })

  it('stays calm below 70%, warms at 70% and goes red at 90%', () => {
    useChatStore.setState({ usage: usage({ chars: 160_000 }) })
    const first = render(<ContextMeter estimate={0} />)
    expect(screen.getByText('~40k tokens').className).toContain('text-muted')
    first.unmount()

    // Exactly 70% of the budget — the boundary belongs to the warning, not below it.
    useChatStore.setState({ usage: usage({ chars: 168_000 }) })
    const second = render(<ContextMeter estimate={0} />)
    expect(screen.getByText('~42k tokens').className).toContain('text-amber-300')
    second.unmount()

    useChatStore.setState({ usage: usage({ chars: 216_000 }) })
    render(<ContextMeter estimate={0} />)
    expect(screen.getByText('~54k tokens').className).toContain('text-red-400')
  })

  it('caps the reading at full rather than reporting more than 100%', () => {
    // Past the budget the engine folds, so a run can genuinely be over it for one
    // step. A 208% bar would be noise; the token count still tells the true story.
    useChatStore.setState({ usage: usage({ chars: 500_000 }) })
    render(<ContextMeter estimate={0} />)

    expect(meter().getAttribute('title')).toBe(
      '100% of the fold budget in use · click for the breakdown'
    )
    expect(screen.getByText('~125k tokens')).toBeTruthy()
  })

  it('breaks the load down into where it actually went', () => {
    useChatStore.setState({ usage: usage({ chars: 216_000 }) })
    render(<ContextMeter estimate={0} />)
    expect(meter().getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(meter())

    expect(meter().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('90% of ~60k')).toBeTruthy()
    expect(screen.getByText('System prompt')).toBeTruthy()
    expect(screen.getByText('Conversation')).toBeTruthy()
    expect(screen.getByText('Sylor this turn')).toBeTruthy()
    expect(screen.getByText('Tool output')).toBeTruthy()
    // Two buckets of 20k chars = 5.0k tokens each, so both rows are found together.
    expect(screen.getAllByText('~5.0k')).toHaveLength(2)
    expect(screen.getByText('~2.0k')).toBeTruthy()
    expect(screen.getByText('~3.0k')).toBeTruthy()
  })

  it('says what the next fold will condense, and says so only when it will', () => {
    useChatStore.setState({ usage: usage() })
    const empty = render(<ContextMeter estimate={0} />)
    fireEvent.click(meter())
    expect(screen.getByText('Nothing is queued to be condensed yet.')).toBeTruthy()
    empty.unmount()

    useChatStore.setState({ usage: usage({ foldSteps: 1 }) })
    const one = render(<ContextMeter estimate={0} />)
    fireEvent.click(meter())
    expect(screen.getByText('Next fold condenses 1 earlier step.')).toBeTruthy()
    one.unmount()

    useChatStore.setState({ usage: usage({ foldSteps: 4 }) })
    render(<ContextMeter estimate={0} />)
    fireEvent.click(meter())
    expect(screen.getByText('Next fold condenses 4 earlier steps.')).toBeTruthy()
  })

  it('calls the model window unknown instead of turning a guess into a percentage', () => {
    useChatStore.setState({ usage: usage() })
    render(<ContextMeter estimate={0} />)
    fireEvent.click(meter())

    expect(
      screen.getByText(
        "This model's real window is unknown to Sylor, so the bar measures its own fold budget."
      )
    ).toBeTruthy()
  })

  it('names the window when Sylor really knows it for that model', () => {
    useChatStore.setState({ usage: usage({ windowTokens: 200_000 }) })
    render(<ContextMeter estimate={0} />)
    fireEvent.click(meter())

    expect(
      screen.getByText("This model's window is ~200k tokens; Sylor folds well before it.")
    ).toBeTruthy()
    expect(screen.queryByText(/unknown to Sylor/)).toBeNull()
  })
})
