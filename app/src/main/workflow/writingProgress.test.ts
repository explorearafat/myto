import { describe, expect, it } from 'vitest'
import type { WorkflowEvent } from '../../shared/types'
import { writingProgress, writingSummary } from './writingProgress'

/** Collects emitted events and exposes just the status messages, in order. */
function sink(): { events: WorkflowEvent[]; emit: (e: WorkflowEvent) => void; messages: () => string[] } {
  const events: WorkflowEvent[] = []
  return {
    events,
    emit: (e) => events.push(e),
    messages: () =>
      events.flatMap((e) => (e.type === 'status' && e.message ? [e.message] : []))
  }
}

const LABEL = 'Writing the plan for phase 1 — Discovery…'

describe('writingSummary', () => {
  it('counts markdown sections once the document has any', () => {
    expect(writingSummary('# Plan\n\n## One\ntext\n\n## Two\ntext')).toBe('2 sections')
  })

  it('says one section, singular', () => {
    expect(writingSummary('## Only\nbody')).toBe('1 section')
  })

  it('falls back to characters before the first heading', () => {
    expect(writingSummary(`intro ${'x'.repeat(1500)}`)).toBe('1.5k characters')
  })

  it('stays quiet while there is too little to report', () => {
    expect(writingSummary('starting to think about it')).toBeNull()
    expect(writingSummary('')).toBeNull()
  })
})

describe('writingProgress', () => {
  it('names the work immediately, before a single byte arrives', () => {
    const out = sink()
    writingProgress({ runId: 'r1', label: LABEL, emit: out.emit, now: () => 0 })
    expect(out.messages()).toEqual([LABEL])
    expect(out.events[0]).toMatchObject({ type: 'status', runId: 'r1', stage: 'planning' })
  })

  it('re-labels with real progress once the throttle window has passed', () => {
    let t = 0
    const out = sink()
    const p = writingProgress({ runId: 'r1', label: LABEL, emit: out.emit, now: () => t })

    t = 2000
    p.onProgress('## A\nbody\n\n## B\nbody')
    expect(out.messages()).toEqual([LABEL, `${LABEL} 2 sections`])
  })

  it('ignores chunks inside the throttle window', () => {
    let t = 0
    const out = sink()
    const p = writingProgress({ runId: 'r1', label: LABEL, emit: out.emit, now: () => t })

    t = 500
    p.onProgress('## A\nbody')
    expect(out.messages()).toEqual([LABEL])
  })

  it('does not repeat a count that has not changed', () => {
    let t = 0
    const out = sink()
    const p = writingProgress({ runId: 'r1', label: LABEL, emit: out.emit, now: () => t })

    t = 2000
    p.onProgress('## A\nbody')
    t = 4000
    p.onProgress('## A\nbody and more body')
    t = 6000
    p.onProgress('## A\nbody\n\n## B\n')
    expect(out.messages()).toEqual([LABEL, `${LABEL} 1 section`, `${LABEL} 2 sections`])
  })

  it('goes silent after stop, so a replayed retry cannot narrate over the next stage', () => {
    let t = 0
    const out = sink()
    const p = writingProgress({ runId: 'r1', label: LABEL, emit: out.emit, now: () => t })

    p.stop()
    t = 9000
    p.onProgress('## A\n\n## B\n\n## C\n')
    expect(out.messages()).toEqual([LABEL])
  })
})
