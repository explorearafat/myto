import { describe, expect, it } from 'vitest'
import { LEAD, lanesOf, roleLabel } from '@renderer/lib/lanes'
import type { ActivityStep, AgentCardUI } from '@renderer/store/useChatStore'
import type { AgentRole } from '@shared/types'

/**
 * Two surfaces read this — the log's filter strip and the palette's jump list — so
 * the contract that matters is the one in the module's own header: ROWS decide which
 * lanes exist, CARDS supply the role and the live state. Each half is tested with the
 * other half missing, because both cases really happen: a trace restored from disk
 * has rows whose cards are long gone, and a card can arrive a beat before its first
 * row does.
 */
function step(id: string, over: Partial<ActivityStep> = {}): ActivityStep {
  return {
    id,
    at: 1_700_000_000_000,
    kind: 'phase',
    stage: 'reading',
    message: 'Reading src/index.ts',
    done: false,
    ...over
  }
}

function card(agentId: string, over: Partial<AgentCardUI> = {}): AgentCardUI {
  return {
    agentId,
    runId: 'run-1',
    afterMessageId: 'm-1',
    role: 'builder',
    task: 'edit the router',
    status: 'running',
    content: '',
    ...over
  }
}

describe('roleLabel', () => {
  it('title-cases a role and unhyphenates it', () => {
    expect(roleLabel('builder')).toBe('Builder')
    expect(roleLabel('test-writer')).toBe('Test writer')
    expect(roleLabel('code_reviewer' as AgentRole)).toBe('Code reviewer')
  })
})

describe('lanesOf', () => {
  it('always has the lead, even with nothing to show yet', () => {
    expect(lanesOf([], [])).toEqual([
      { key: LEAD, label: 'Sylor', state: null, count: 0, cancelling: false, current: null }
    ])
  })

  it('puts the lead first however late its own first row is', () => {
    const lanes = lanesOf(
      [step('1', { agentId: 'a1', agentRole: 'builder' }), step('2')],
      [card('a1')]
    )
    // The strip reads left to right and the lead is the run, so it leads the list
    // even though a subagent's row came in first.
    expect(lanes.map((l) => l.key)).toEqual([LEAD, 'a1'])
  })

  it('counts each lane’s own rows and quotes its latest message', () => {
    const lanes = lanesOf(
      [
        step('1', { message: 'Reading' }),
        step('2', { agentId: 'a1', agentRole: 'builder', message: 'Editing the router' }),
        step('3', { agentId: 'a1', agentRole: 'builder', message: 'Writing src/router.ts' }),
        step('4', { message: 'Thinking' })
      ],
      [card('a1')]
    )
    expect(lanes[0]).toMatchObject({ count: 2, current: 'Thinking' })
    // `current` answers "what is it doing NOW", so it is the last row, not the first.
    expect(lanes[1]).toMatchObject({ count: 2, current: 'Writing src/router.ts' })
  })

  it('keeps subagent lanes in the order they first appeared', () => {
    const lanes = lanesOf(
      [
        step('1', { agentId: 'b', agentRole: 'reviewer' }),
        step('2', { agentId: 'a', agentRole: 'builder' }),
        step('3', { agentId: 'b', agentRole: 'reviewer' })
      ],
      []
    )
    // First seen, not alphabetical: the strip should not reshuffle itself as a lane
    // that started earlier reports again.
    expect(lanes.map((l) => l.key)).toEqual([LEAD, 'b', 'a'])
  })

  it('names a lane from its rows when the card is gone', () => {
    const lanes = lanesOf([step('1', { agentId: 'a1', agentRole: 'test-writer' })], [])
    // A trace reopened from disk has no live cards, but the rows remember the role.
    expect(lanes[1]).toMatchObject({ key: 'a1', label: 'Test writer', state: null })
  })

  it('falls back to “Subagent” rather than guessing a role', () => {
    const lanes = lanesOf([step('1', { agentId: 'a1' })], [])
    expect(lanes[1].label).toBe('Subagent')
  })

  it('prefers the card’s role, so a renamed lane follows the card', () => {
    const lanes = lanesOf([step('1', { agentId: 'a1', agentRole: 'builder' })], [
      card('a1', { role: 'reviewer' })
    ])
    expect(lanes[1].label).toBe('Reviewer')
  })

  it('reads the live state off the card, and only off the card', () => {
    const rows = [step('1', { agentId: 'a1', agentRole: 'builder' })]
    expect(lanesOf(rows, [card('a1')])[1].state).toBe('running')
    expect(lanesOf(rows, [card('a1', { status: 'complete', ok: true })])[1].state).toBe('done')
    expect(lanesOf(rows, [card('a1', { status: 'complete', ok: false })])[1].state).toBe('failed')
    // A closed card that never said whether it succeeded is done, not failed —
    // `ok === undefined` is silence, and silence is not a failure.
    expect(lanesOf(rows, [card('a1', { status: 'complete' })])[1].state).toBe('done')
    // No card at all means no claim about the state.
    expect(lanesOf(rows, [])[1].state).toBeNull()
  })

  it('carries the stopping flag through so the strip can say “Stopping…”', () => {
    const rows = [step('1', { agentId: 'a1', agentRole: 'builder' })]
    expect(lanesOf(rows, [card('a1', { cancelling: true })])[1]).toMatchObject({
      state: 'running',
      cancelling: true
    })
    // The lead is never cancelling: stopping the run is a different button.
    expect(lanesOf(rows, [card('a1', { cancelling: true })])[0].cancelling).toBe(false)
  })

  it('does not open a lane for a card with no rows', () => {
    // A filter for a lane with no steps would show an empty log, so the rows are the
    // authority for which lanes exist at all.
    expect(lanesOf([step('1')], [card('a1')]).map((l) => l.key)).toEqual([LEAD])
  })
})
