import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IDLE_AMBIENT,
  ambientStatus,
  foldAmbient,
  newAmbientTrace,
  onAmbientStatus,
  publishAmbient,
  resetAmbient,
  sameAmbient,
  type AmbientTrace
} from '@main/ambient'
import type { AgentRole, WorkflowEvent } from '@shared/types'

/**
 * The ambient reducer is what the tray tooltip, the taskbar overlay icon and the
 * floating card all read, so the interesting assertions here are about *honesty*
 * rather than plumbing: a pre-approved tool must never claim to be blocked on the
 * user, a closed lane must not be counted as open, a finished run must leave no
 * clock running, and a repeated event must not wake a surface that would draw the
 * same pixels.
 *
 * `foldAmbient` is pure, so most of the file drives it directly and only the
 * publish/subscribe tests touch the module-level hub (torn down after each).
 */

const RUN = 'run-1'

/** Fold a whole sequence, starting from an empty trace. */
function foldAll(events: WorkflowEvent[], now = 1_000): AmbientTrace {
  return events.reduce((trace, event) => foldAmbient(trace, event, now), newAmbientTrace())
}

function status(runId = RUN, message = 'Reading src/index.ts', at = 1_000): WorkflowEvent {
  return { type: 'status', runId, stage: 'reading', message, at }
}

function agentStart(agentId: string, role: AgentRole, task: string, runId = RUN): WorkflowEvent {
  return { type: 'agent-start', runId, agentId, role, task, at: 1_000 }
}

function agentEnd(agentId: string, role: AgentRole, runId = RUN): WorkflowEvent {
  return { type: 'agent-end', runId, agentId, role, report: 'done', ok: true, at: 2_000 }
}

function toolRequest(auto: boolean, runId = RUN): WorkflowEvent {
  return {
    type: 'tool-request',
    runId,
    proposal: { id: 'tool-1', kind: 'read', op: 'read_file', path: 'src/index.ts' },
    auto,
    at: 1_500
  }
}

afterEach(() => {
  resetAmbient()
})

describe('foldAmbient', () => {
  it('starts idle and reports the engine’s own status line verbatim', () => {
    const trace = foldAll([status()])
    expect(newAmbientTrace().status).toEqual(IDLE_AMBIENT)
    expect(trace.status.state).toBe('running')
    // The message is the engine's, never a sentence written in the reducer.
    expect(trace.status.message).toBe('Reading src/index.ts')
    expect(trace.status.runId).toBe(RUN)
  })

  it('stamps the clock from the first event of a run and keeps it for the rest', () => {
    let trace = foldAmbient(newAmbientTrace(), status(RUN, 'first', 5_000), 9_999)
    expect(trace.status.startedAt).toBe(5_000)
    trace = foldAmbient(trace, status(RUN, 'second', 8_000), 9_999)
    expect(trace.status.startedAt).toBe(5_000)
  })

  it('falls back to now when an event carries no stamp', () => {
    const unstamped: WorkflowEvent = { type: 'status', runId: RUN, stage: 'reading', message: 'go' }
    const trace = foldAmbient(newAmbientTrace(), unstamped, 4_242)
    expect(trace.status.startedAt).toBe(4_242)
  })

  it('resets the clock and the lanes when a new run starts', () => {
    const first = foldAll([status(RUN, 'old', 1_000), agentStart('a1', 'builder', 'edit')])
    expect(first.status.agents).toBe(1)

    const second = foldAmbient(first, status('run-2', 'new', 7_000), 7_000)
    expect(second.status.runId).toBe('run-2')
    expect(second.status.startedAt).toBe(7_000)
    // The previous turn's open lane must not be attributed to this one.
    expect(second.status.agents).toBe(0)
    expect(second.live.size).toBe(0)
    expect(second.roles.size).toBe(0)
  })

  it('never says the user is being waited on for a pre-approved tool', () => {
    const trace = foldAll([status(RUN, 'Reading files'), toolRequest(true)])
    expect(trace.status.state).toBe('running')
    // The engine's last true line survives; nothing is invented for an auto tool.
    expect(trace.status.message).toBe('Reading files')
  })

  it('goes to waiting for a gated tool, a question and a plan approval', () => {
    expect(foldAll([status(), toolRequest(false)]).status).toMatchObject({
      state: 'waiting',
      message: 'Waiting for your go-ahead'
    })
    const question: WorkflowEvent = {
      type: 'question',
      runId: RUN,
      question: { id: 'q1', question: 'Which folder?' },
      at: 1_100
    }
    expect(foldAll([status(), question]).status.state).toBe('waiting')
    const approval: WorkflowEvent = {
      type: 'plan-approval',
      runId: RUN,
      approval: { id: 'p1', complexity: 'simple', steps: ['do it'] },
      at: 1_200
    }
    expect(foldAll([status(), approval]).status.state).toBe('waiting')
  })

  it('returns to running on the tool result, under the last real status line', () => {
    const trace = foldAll([status(RUN, 'Editing the router'), toolRequest(false)])
    expect(trace.status.state).toBe('waiting')
    const result: WorkflowEvent = {
      type: 'tool-result',
      runId: RUN,
      result: {
        id: 'tool-1',
        kind: 'read',
        ok: true,
        output: 'export const a = 1',
        truncated: false,
        summary: '40 lines'
      },
      at: 1_600
    }
    const after = foldAmbient(trace, result, 1_600)
    expect(after.status.state).toBe('running')
    // Crucially NOT "Waiting for your go-ahead": that stopped being true the moment
    // they answered, and the reducer keeps the engine's own line to come back to.
    expect(after.status.message).toBe('Editing the router')
  })

  it('does not contradict itself when a tool is proposed before the engine has spoken', () => {
    const trace = foldAll([toolRequest(true)])
    expect(trace.status.state).toBe('running')
    // "Nothing running" under a running dot would be a contradiction, and there is
    // no engine line yet to quote, so it says the one thing that is certainly true.
    expect(trace.status.message).toBe('Working')
  })

  it('counts open lanes, and a duplicate agent-end cannot drive the count negative', () => {
    let trace = foldAll([agentStart('a1', 'builder', 'edit'), agentStart('a2', 'reviewer', 'check')])
    expect(trace.status.agents).toBe(2)

    trace = foldAmbient(trace, agentEnd('a1', 'builder'), 2_000)
    expect(trace.status.agents).toBe(1)
    // The same close arriving twice is a no-op, not a decrement.
    trace = foldAmbient(trace, agentEnd('a1', 'builder'), 2_000)
    expect(trace.status.agents).toBe(1)
    trace = foldAmbient(trace, agentEnd('a2', 'reviewer'), 2_000)
    expect(trace.status.agents).toBe(0)
  })

  it('names the lane a subagent event came from, with its role', () => {
    const trace = foldAll([agentStart('a1', 'test-writer', 'write the specs')])
    expect(trace.status.lane).toBe('a1')
    expect(trace.status.role).toBe('test-writer')
    expect(trace.status.message).toBe('write the specs')
  })

  it('leaves the message where it was when a lane closes, and keeps a block blocked', () => {
    const working = foldAll([
      agentStart('a1', 'builder', 'edit the router'),
      status(RUN, 'Still working on the router')
    ])
    const closed = foldAmbient(working, agentEnd('a1', 'builder'), 2_000)
    // Only the count moves: a finished lane is not news about what is happening.
    expect(closed.status.message).toBe('Still working on the router')
    expect(closed.status.agents).toBe(0)

    const blocked = foldAmbient(foldAll([status(), toolRequest(false)]), agentEnd('a1', 'builder'), 2_000)
    expect(blocked.status.state).toBe('waiting')
  })

  it('zeroes the clock and the lanes when the run finishes or fails', () => {
    const done = foldAmbient(
      foldAll([agentStart('a1', 'builder', 'edit')]),
      { type: 'done', runId: RUN, at: 3_000 },
      3_000
    )
    expect(done.status).toMatchObject({
      state: 'done',
      message: 'Finished',
      startedAt: 0,
      agents: 0,
      lane: null
    })

    const failed = foldAmbient(
      foldAll([status()]),
      { type: 'error', runId: RUN, message: 'the provider refused', at: 3_000 },
      3_000
    )
    expect(failed.status).toMatchObject({
      state: 'failed',
      message: 'the provider refused',
      startedAt: 0
    })
  })

  it('ignores the events that say nothing about who is working', () => {
    const base = foldAll([status(RUN, 'Reading src/index.ts')])
    const quiet: WorkflowEvent[] = [
      { type: 'delta', runId: RUN, text: 'hello', at: 1_100 },
      {
        type: 'context',
        runId: RUN,
        usage: {
          chars: 10,
          budget: 100,
          systemChars: 4,
          historyChars: 3,
          assistantChars: 2,
          toolChars: 1,
          foldSteps: 0
        },
        at: 1_200
      },
      {
        type: 'checkpoint',
        runId: RUN,
        checkpoint: { id: 'c1', at: 1_300, label: 'before a write', kind: 'files' },
        at: 1_300
      }
    ]
    for (const event of quiet) {
      // Identity, not just equality: an ignored event must not even reallocate.
      expect(foldAmbient(base, event, 1_400)).toBe(base)
    }
  })
})

describe('sameAmbient', () => {
  it('is true for equal statuses and false for any single field change', () => {
    const a = foldAll([status()]).status
    expect(sameAmbient(a, { ...a })).toBe(true)
    expect(sameAmbient(a, { ...a, message: 'something else' })).toBe(false)
    expect(sameAmbient(a, { ...a, agents: 1 })).toBe(false)
    expect(sameAmbient(a, { ...a, state: 'waiting' })).toBe(false)
    expect(sameAmbient(a, { ...a, lane: 'a1' })).toBe(false)
    expect(sameAmbient(a, { ...a, role: 'builder' })).toBe(false)
    expect(sameAmbient(a, { ...a, startedAt: 9 })).toBe(false)
    expect(sameAmbient(a, { ...a, runId: 'other' })).toBe(false)
  })
})

describe('publishAmbient', () => {
  it('tells subscribers only when something visible changed', () => {
    const seen = vi.fn()
    onAmbientStatus(seen)

    publishAmbient(status(RUN, 'Reading src/index.ts'))
    expect(seen).toHaveBeenCalledTimes(1)
    expect(ambientStatus().message).toBe('Reading src/index.ts')

    // The same line again folds to an equal (but freshly allocated) status: the
    // value gate is what stops the tray repainting for nothing.
    publishAmbient(status(RUN, 'Reading src/index.ts'))
    expect(seen).toHaveBeenCalledTimes(1)

    publishAmbient(status(RUN, 'Editing src/index.ts'))
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('keeps telling the other surfaces when one of them throws', () => {
    const bad = vi.fn(() => {
      throw new Error('tray is gone')
    })
    const good = vi.fn()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    onAmbientStatus(bad)
    onAmbientStatus(good)

    publishAmbient(status(RUN, 'Reading src/index.ts'))
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it('stops delivering after the disposer runs, and resets to idle', () => {
    const seen = vi.fn()
    const dispose = onAmbientStatus(seen)
    publishAmbient(status(RUN, 'one'))
    dispose()
    publishAmbient(status(RUN, 'two'))
    expect(seen).toHaveBeenCalledTimes(1)

    resetAmbient()
    expect(ambientStatus()).toEqual(IDLE_AMBIENT)
  })
})
