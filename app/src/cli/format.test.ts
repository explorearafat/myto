import { describe, it, expect } from 'vitest'
import type {
  ReadProposal,
  RunCommandProposal,
  WorkflowEvent,
  WriteFileProposal
} from '../shared/types'
import { deltaForStdout, formatEventForStderr, headlessDecision } from './format'

const RUN = 'run-1'

describe('deltaForStdout', () => {
  it('returns the text of a LEAD delta (no agentId)', () => {
    const e: WorkflowEvent = { type: 'delta', runId: RUN, text: 'Hello' }
    expect(deltaForStdout(e)).toBe('Hello')
  })

  it('ignores a subagent delta (has an agentId)', () => {
    const e: WorkflowEvent = { type: 'delta', runId: RUN, text: 'noise', agentId: 'a1' }
    expect(deltaForStdout(e)).toBeNull()
  })

  it('ignores non-delta events', () => {
    expect(deltaForStdout({ type: 'done', runId: RUN })).toBeNull()
  })
})

describe('formatEventForStderr — status', () => {
  it('renders a plain status line', () => {
    expect(
      formatEventForStderr({ type: 'status', runId: RUN, stage: 'generating', message: 'Working' })
    ).toBe('… Working')
  })

  it('flags a retry', () => {
    expect(
      formatEventForStderr({
        type: 'status',
        runId: RUN,
        stage: 'generating',
        message: 'Rate limited',
        retrying: true
      })
    ).toBe('… Rate limited (retrying)')
  })
})

describe('formatEventForStderr — tool-request', () => {
  const write: WriteFileProposal = {
    id: 'p1',
    kind: 'write_file',
    path: 'src/a.ts',
    oldContent: '',
    newContent: 'x',
    exists: false
  }
  const cmd: RunCommandProposal = { id: 'p2', kind: 'run_command', command: 'npm test' }

  it('marks an auto-approved proposal with the gear glyph and its target', () => {
    expect(
      formatEventForStderr({ type: 'tool-request', runId: RUN, proposal: write, auto: true })
    ).toBe('⚙ write_file src/a.ts')
  })

  it('marks a gated proposal with the hourglass glyph', () => {
    expect(
      formatEventForStderr({ type: 'tool-request', runId: RUN, proposal: cmd, auto: false })
    ).toBe('⏳ run_command npm test')
  })

  it('prefixes a subagent proposal with its agentId', () => {
    expect(
      formatEventForStderr({
        type: 'tool-request',
        runId: RUN,
        proposal: cmd,
        auto: false,
        agentId: 'builder-1'
      })
    ).toBe('⏳ builder-1 run_command npm test')
  })
})

describe('formatEventForStderr — tool-result', () => {
  it('treats run_command exit 0 as success', () => {
    expect(
      formatEventForStderr({
        type: 'tool-result',
        runId: RUN,
        result: { id: 'p2', kind: 'run_command', exitCode: 0, output: '', truncated: false }
      })
    ).toBe('✓ run_command')
  })

  it('treats a non-zero run_command exit as failure', () => {
    expect(
      formatEventForStderr({
        type: 'tool-result',
        runId: RUN,
        result: { id: 'p2', kind: 'run_command', exitCode: 1, output: '', truncated: false }
      })
    ).toBe('✗ run_command')
  })

  it('reads the ok flag for tools that carry one', () => {
    expect(
      formatEventForStderr({
        type: 'tool-result',
        runId: RUN,
        result: {
          id: 'p1',
          kind: 'write_file',
          ok: false,
          error: 'sandbox'
        }
      })
    ).toBe('✗ write_file')
  })
})

describe('formatEventForStderr — orchestration + errors', () => {
  it('renders agent-start and agent-end', () => {
    expect(
      formatEventForStderr({
        type: 'agent-start',
        runId: RUN,
        agentId: 'a1',
        role: 'builder',
        task: 'implement X'
      })
    ).toBe('▶ builder: implement X')
    expect(
      formatEventForStderr({
        type: 'agent-end',
        runId: RUN,
        agentId: 'a1',
        role: 'builder',
        report: 'done',
        ok: true
      })
    ).toBe('✓ builder finished')
  })

  it('summarises a plan', () => {
    expect(
      formatEventForStderr({ type: 'plan', runId: RUN, complexity: 'medium', tasks: [] })
    ).toBe('plan: 0 task(s) [medium]')
  })

  it('renders an error', () => {
    expect(formatEventForStderr({ type: 'error', runId: RUN, message: 'boom' })).toBe(
      'error: boom'
    )
  })

  it('returns null for lead deltas and done (no stderr line)', () => {
    expect(formatEventForStderr({ type: 'delta', runId: RUN, text: 'hi' })).toBeNull()
    expect(formatEventForStderr({ type: 'done', runId: RUN })).toBeNull()
  })
})

describe('headlessDecision', () => {
  const cmd: RunCommandProposal = { id: 'p9', kind: 'run_command', command: 'rm -rf x' }
  const read: ReadProposal = { id: 'p0', kind: 'read', op: 'read_file', path: 'a.ts' }

  it('rejects a gated proposal in the default (non-autonomous) posture', () => {
    expect(
      headlessDecision({ type: 'tool-request', runId: RUN, proposal: cmd, auto: false }, 'auto-edit')
    ).toEqual({ toolId: 'p9', decision: 'reject' })
  })

  it('approves a gated proposal only in autonomous mode', () => {
    expect(
      headlessDecision(
        { type: 'tool-request', runId: RUN, proposal: cmd, auto: false },
        'autonomous'
      )
    ).toEqual({ toolId: 'p9', decision: 'approve' })
  })

  it('returns null for an already auto-approved proposal', () => {
    expect(
      headlessDecision({ type: 'tool-request', runId: RUN, proposal: read, auto: true }, 'auto-edit')
    ).toBeNull()
  })

  it('returns null for a non-tool-request event', () => {
    expect(headlessDecision({ type: 'done', runId: RUN }, 'autonomous')).toBeNull()
  })
})
