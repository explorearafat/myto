import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RunLog } from '@renderer/components/canvas/RunLog'
import {
  useChatStore,
  type ActivityStep,
  type AgentCardUI,
  type ToolCardUI
} from '@renderer/store/useChatStore'
import { formatClock } from '@renderer/lib/duration'

/**
 * The Run Log is the harness's receipts surface, so the things worth pinning are
 * the honesty rules rather than the layout: a step whose time was never recorded
 * must SAY so instead of rendering the Unix epoch, a duration appears only when
 * both stamps exist, and the swimlane strip only shows up once a subagent has
 * actually run (an empty filter row would imply parallelism that never happened).
 */
const step = (over: Partial<ActivityStep> & { id: string }): ActivityStep => ({
  at: 1_700_000_000_000,
  kind: 'tool',
  stage: 'generating',
  message: 'Creating App.tsx',
  done: true,
  ...over
})

const card = (over: Partial<ToolCardUI> & { id: string }): ToolCardUI => ({
  runId: 'run-1',
  afterMessageId: 'm-1',
  proposal: { id: over.id, kind: 'run_command', command: 'npm test' },
  auto: true,
  status: 'complete',
  ...over
})

/** Seed only the fields the log reads, leaving the rest of the store alone. */
function seed(state: {
  activity: ActivityStep[]
  tools?: ToolCardUI[]
  agents?: AgentCardUI[]
  running?: boolean
}): void {
  useChatStore.setState({
    activity: state.activity,
    tools: state.tools ?? [],
    agents: state.agents ?? [],
    running: state.running ?? false
  })
}

beforeEach(() => {
  seed({ activity: [] })
})

describe('RunLog', () => {
  it('says nothing has run rather than showing an empty frame', () => {
    render(<RunLog />)
    expect(screen.getByText('Nothing has run yet.')).toBeTruthy()
  })

  it('shows a real clock for a stamped row and --:--:-- for one that was never timed', () => {
    const at = 1_700_000_000_000
    seed({
      activity: [
        step({ id: 'a1', at }),
        // `at: 0` is what a pre-v9 persisted op rebuilds to — no clock was ever
        // recorded, so printing 01:00:00 (the epoch in local time) would be a lie.
        step({ id: 'a2', at: 0, message: 'Running npm ci' })
      ]
    })
    render(<RunLog />)

    expect(screen.getByText(formatClock(at))).toBeTruthy()
    expect(screen.getByText('--:--:--')).toBeTruthy()
  })

  it('shows a duration only for an op with both stamps', () => {
    seed({
      activity: [
        step({ id: 'a1', toolId: 'op-timed' }),
        step({ id: 'a2', toolId: 'op-untimed', message: 'Running npm ci' })
      ],
      tools: [
        card({ id: 'op-timed', startedAt: 1_000, endedAt: 3_400 }),
        card({ id: 'op-untimed', startedAt: 1_000 })
      ]
    })
    render(<RunLog />)

    expect(screen.getByText('2.4s')).toBeTruthy()
    // Nothing invented for the half-timed one — no "0ms", no dash pretending to
    // be a measurement.
    expect(screen.queryByText('0ms')).toBeNull()
  })

  it('keeps the lane strip hidden until a subagent has actually run', () => {
    seed({ activity: [step({ id: 'a1' })] })
    const { unmount } = render(<RunLog />)
    expect(screen.queryByText('All')).toBeNull()
    unmount()

    seed({
      activity: [
        step({ id: 'a1', message: 'Reading App.tsx' }),
        step({
          id: 'a2',
          kind: 'agent',
          agentId: 'ag-1',
          agentRole: 'reviewer',
          message: 'reviewer · check the diff'
        })
      ],
      agents: [
        {
          agentId: 'ag-1',
          runId: 'run-1',
          afterMessageId: 'm-1',
          role: 'reviewer',
          task: 'check the diff',
          status: 'running',
          content: ''
        }
      ]
    })
    render(<RunLog />)
    expect(screen.getByText('All')).toBeTruthy()
    expect(screen.getByText('Reviewer')).toBeTruthy()
  })

  it('filters to one lane, hiding the rows it did not cause', () => {
    seed({
      activity: [
        step({ id: 'a1', message: 'Reading App.tsx' }),
        step({
          id: 'a2',
          kind: 'agent',
          agentId: 'ag-1',
          agentRole: 'builder',
          message: 'builder · add the route'
        })
      ],
      agents: [
        {
          agentId: 'ag-1',
          runId: 'run-1',
          afterMessageId: 'm-1',
          role: 'builder',
          task: 'add the route',
          status: 'complete',
          ok: true,
          content: ''
        }
      ]
    })
    render(<RunLog />)
    expect(screen.getByText('Reading App.tsx')).toBeTruthy()

    fireEvent.click(screen.getByText('Builder'))
    expect(screen.queryByText('Reading App.tsx')).toBeNull()
    expect(screen.getByText('builder · add the route')).toBeTruthy()
  })

  it('only offers a disclosure on rows that have more to show', () => {
    seed({
      activity: [
        // A phase row IS the whole fact — an arrow on it would promise detail that
        // does not exist.
        step({ id: 'a1', kind: 'phase', message: 'Reading files…' }),
        step({ id: 'a2', toolId: 'op-1' })
      ],
      tools: [card({ id: 'op-1' })]
    })
    render(<RunLog />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toContain('Creating App.tsx')
  })
})

/**
 * Phase 3 — stopping ONE lane. The requirement is that a subagent can be cancelled
 * without killing the run, so the affordance has to be on the lane itself, and it
 * has to be honest about the gap: the engine owns the closing event, so the chip
 * reads "stopping…" until that arrives rather than pretending it already stopped.
 */
describe('RunLog lane cancel', () => {
  const lane = (over: Partial<AgentCardUI> & { agentId: string }): AgentCardUI => ({
    runId: 'run-1',
    afterMessageId: 'm-1',
    role: 'builder',
    task: 'add the route',
    status: 'running',
    content: '',
    ...over
  })

  const laneStep = (agentId: string): ActivityStep =>
    step({ id: `s-${agentId}`, kind: 'agent', agentId, agentRole: 'builder', message: 'builder · add the route' })

  function seedLane(agents: AgentCardUI[]): void {
    seed({ activity: [step({ id: 'a1' }), ...agents.map((a) => laneStep(a.agentId))], agents, running: true })
    useChatStore.setState({ runId: 'run-1' })
  }

  it('offers a stop on a running lane and asks the engine to stop just that one', () => {
    seedLane([lane({ agentId: 'ag-1' })])
    const cancel = window.sylor.workflow.cancelAgent as unknown as ReturnType<typeof vi.fn>
    cancel.mockClear()
    render(<RunLog />)

    const stop = screen.getByRole('button', { name: 'Stop the Builder subagent' })
    expect(stop.getAttribute('title')).toBe(
      'Stop the Builder subagent — the rest of the run continues'
    )
    fireEvent.click(stop)
    expect(cancel).toHaveBeenCalledWith('run-1', 'ag-1')
  })

  it('says "stopping…" and takes the stop away once it has been asked for', () => {
    seedLane([lane({ agentId: 'ag-1', cancelling: true })])
    render(<RunLog />)

    expect(screen.getByText('stopping…')).toBeTruthy()
    // No second click: the request is in, and offering it again would suggest the
    // first one didn't land.
    expect(screen.queryByRole('button', { name: 'Stop the Builder subagent' })).toBeNull()
  })

  it('offers no stop on a lane that has already finished', () => {
    seedLane([lane({ agentId: 'ag-1', status: 'complete', ok: true })])
    render(<RunLog />)
    expect(screen.queryByRole('button', { name: 'Stop the Builder subagent' })).toBeNull()
  })

  it('names what the lane is doing now in its tooltip', () => {
    seedLane([lane({ agentId: 'ag-1' })])
    render(<RunLog />)
    // Read the attribute rather than querying by title: the DOM holds the two lines
    // (count, then current action) that the query helper would flatten into one.
    expect(screen.getByRole('button', { name: /^Builder/ }).getAttribute('title')).toBe(
      'Builder · 1 step\nbuilder · add the route'
    )
  })
})
