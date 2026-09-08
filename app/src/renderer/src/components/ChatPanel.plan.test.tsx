import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PlanApprovalBar } from '@renderer/components/ChatPanel'
import type { PendingPlan } from '@shared/types'

/**
 * #2 — the "Plan first" checkpoint. With the toggle on, the run plans and then
 * parks here before it touches a file. The bar has one job: show what is about to
 * happen accurately enough to say yes or no to. These pin that it lists every step,
 * tells the truth about what has been written so far, and reports both decisions.
 */
const plan: PendingPlan = {
  id: 'plan-1',
  complexity: 'complex',
  steps: ['Backend Engineer: the login endpoint', 'Frontend Engineer: the sign-in form'],
  planPath: '.sylor/plan.md'
}

describe('PlanApprovalBar', () => {
  it('lists every step, numbered, with the sized team', () => {
    render(<PlanApprovalBar approval={plan} onDecide={() => {}} />)
    expect(screen.getByText('Plan ready for your go-ahead')).toBeTruthy()
    expect(screen.getByText('Backend Engineer: the login endpoint')).toBeTruthy()
    expect(screen.getByText('Frontend Engineer: the sign-in form')).toBeTruthy()
    expect(screen.getByText('2 steps · complex')).toBeTruthy()
    expect(screen.getByText('1.')).toBeTruthy()
    expect(screen.getByText('2.')).toBeTruthy()
  })

  it('names the phase when the run is a staged one', () => {
    render(
      <PlanApprovalBar
        approval={{ ...plan, phase: { n: 2, total: 9, name: 'Design system and shell' } }}
        onDecide={() => {}}
      />
    )
    expect(screen.getByText('Plan — phase 2 of 9: Design system and shell')).toBeTruthy()
  })

  it('says where the plan was written, and that nothing else was touched', () => {
    render(<PlanApprovalBar approval={plan} onDecide={() => {}} />)
    expect(
      screen.getByText('Full plan written to .sylor/plan.md — nothing else has been touched yet.')
    ).toBeTruthy()
  })

  it('does not claim a file exists when no plan was written', () => {
    const { steps, complexity, id } = plan
    render(<PlanApprovalBar approval={{ id, complexity, steps }} onDecide={() => {}} />)
    expect(screen.getByText('Nothing has been written yet.')).toBeTruthy()
  })

  it('reads "1 step" for a single-node plan', () => {
    render(
      <PlanApprovalBar
        approval={{ ...plan, complexity: 'simple', steps: ['Engineer: fix the typo'] }}
        onDecide={() => {}}
      />
    )
    expect(screen.getByText('1 step · simple')).toBeTruthy()
  })

  it('approves on "Build it"', () => {
    const onDecide = vi.fn()
    render(<PlanApprovalBar approval={plan} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Build it' }))
    expect(onDecide).toHaveBeenCalledWith('approve')
  })

  it('rejects on "Reject"', () => {
    const onDecide = vi.fn()
    render(<PlanApprovalBar approval={plan} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(onDecide).toHaveBeenCalledWith('reject')
  })
})
