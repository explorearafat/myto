/**
 * Orchestrator state-machine tests.
 *
 * These drive the REAL {@link runOrchestrator} — the complexity router, the
 * planner, the task graph, the parallel scheduler, retry, the review gate, and
 * bounded rework all execute for every case below. Only the four side-effecting
 * seams the engine injects are faked (`executeNode`, `writePlan`, `verify`,
 * `judge`), so what's asserted is the architecture doing the work, not statuses
 * being printed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentMessage,
  Complexity,
  ProviderSettings,
  TaskNode,
  WorkflowEvent
} from '@shared/types'

// The router (ambiguous prompts) and the planner (medium/complex) each spend one
// provider completion; intercept it so every test scripts exactly what they see.
const { getCompletion } = vi.hoisted(() => ({ getCompletion: vi.fn() }))

vi.mock('@main/providers', () => ({
  providerFromSettings: () => ({
    streamCompletion: vi.fn(),
    getCompletion,
    listModels: vi.fn(),
    testConnection: vi.fn()
  })
}))

import {
  runOrchestrator,
  type NodeRunResult,
  type OrchestratorDeps
} from '@main/workflow/orchestrator/orchestrator'

type ExecuteNode = OrchestratorDeps['executeNode']
type WritePlan = OrchestratorDeps['writePlan']
type Verify = OrchestratorDeps['verify']
type Judge = OrchestratorDeps['judge']
type ApprovePlan = NonNullable<OrchestratorDeps['approvePlan']>

// ---- Requests that pin each routing decision --------------------------------
// Sizing is the model's job now, and the engine does it once and hands the verdict
// in (deps.complexity), so these two requests come pre-sized exactly as production
// would size them — no router call, and no dependence on the reply queue below.

/** Short, one deliverable, no domain → SIMPLE, pinned by the harness. */
const SIMPLE_REQUEST = 'fix the typo'
/** Four domains → COMPLEX, pinned by the harness. */
const COMPLEX_REQUEST = 'add a login API endpoint and a React component and a database migration'
/** Deliberately NOT pinned, so the orchestrator has to size it for itself. */
const MEDIUM_REQUEST = 'refactor the helper that formats dates'

/** What the engine would have handed in for each pinned request. */
const PINNED: Record<string, Complexity> = {
  [SIMPLE_REQUEST]: 'simple',
  [COMPLEX_REQUEST]: 'complex'
}

// ---- Fixtures ---------------------------------------------------------------

/** A planner-shaped task (the planner assigns state/attempts itself). */
function task(
  id: string,
  role: string,
  dependsOn: string[] = [],
  filesHint?: string[]
): Record<string, unknown> {
  return { id, role, description: `do ${id}`, dependsOn, ...(filesHint ? { filesHint } : {}) }
}

/** A fenced planner reply carrying `tasks`. */
const planJson = (tasks: Record<string, unknown>[]): string =>
  `\`\`\`json\n${JSON.stringify({ tasks })}\n\`\`\``

/** A reviewer verdict reply. */
const verdictJson = (
  verdict: 'pass' | 'fail',
  reason = '',
  targetRole = 'builder'
): string => JSON.stringify({ verdict, reason, targetRole })

/** A successful node run. */
const ran = (node: TaskNode, report = `${node.id} done`, filesChanged: string[] = []): NodeRunResult => ({
  agentId: `agent-${node.id}`,
  report,
  ok: true,
  filesChanged
})

/** A failed node run. */
const threw = (node: TaskNode, report = `${node.id} exploded`): NodeRunResult => ({
  agentId: `agent-${node.id}`,
  report,
  ok: false,
  filesChanged: []
})

// ---- Harness ----------------------------------------------------------------

/**
 * Builds the injected deps as spies (defaulting to "everything succeeds, nothing
 * to verify, review passes") and returns a `run` that feeds a request through the
 * real state machine.
 *
 * `approvePlan` is deliberately absent unless a test passes one: that omission is
 * production's "Plan first is off", and supplying it is production's toggle being on.
 */
function harness(
  over: {
    executeNode?: ExecuteNode
    writePlan?: WritePlan
    verify?: Verify
    judge?: Judge
    approvePlan?: ApprovePlan
  } = {}
) {
  const events: WorkflowEvent[] = []
  const controller = new AbortController()

  const executeNode = vi.fn<ExecuteNode>(over.executeNode ?? (async (node) => ran(node)))
  const writePlan = vi.fn<WritePlan>(over.writePlan ?? (async () => {}))
  const verify = vi.fn<Verify>(over.verify ?? (async () => ({ ran: false, ok: false })))
  const judge = vi.fn<Judge>(over.judge ?? (async () => verdictJson('pass')))
  const approvePlan = over.approvePlan ? vi.fn<ApprovePlan>(over.approvePlan) : undefined

  const deps: Omit<OrchestratorDeps, 'request'> = {
    runId: 'run-1',
    overview: 'PROJECT OVERVIEW',
    settings: {} as ProviderSettings,
    emit: (event) => events.push(event),
    signal: controller.signal,
    executeNode,
    writePlan,
    verify,
    judge,
    ...(approvePlan ? { approvePlan } : {})
  }

  return {
    events,
    controller,
    executeNode,
    writePlan,
    verify,
    judge,
    approvePlan,
    run: (request: string, complexity: Complexity | undefined = PINNED[request]) =>
      runOrchestrator({ ...deps, request, complexity })
  }
}

const stagesOf = (events: WorkflowEvent[]): string[] =>
  events.filter((e) => e.type === 'status').map((e) => (e as { stage: string }).stage)

const messagesOf = (events: WorkflowEvent[]): AgentMessage[] =>
  events.filter((e) => e.type === 'agent-message').map((e) => (e as { message: AgentMessage }).message)

const textOf = (events: WorkflowEvent[]): string =>
  events
    .filter((e) => e.type === 'delta')
    .map((e) => (e as { text: string }).text)
    .join('')

const updatesOf = (events: WorkflowEvent[]): TaskNode[] =>
  events.filter((e) => e.type === 'task-update').map((e) => (e as { task: TaskNode }).task)

const plansOf = (events: WorkflowEvent[]): { complexity: Complexity; tasks: TaskNode[] }[] =>
  events.filter((e) => e.type === 'plan') as { complexity: Complexity; tasks: TaskNode[] }[]

/** The ids passed to executeNode, in dispatch order. */
const dispatched = (executeNode: { mock: { calls: [TaskNode, unknown][] } }): string[] =>
  executeNode.mock.calls.map(([node]) => node.id)

/** Polls until `cond` holds — used to observe in-flight scheduling. */
async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${label}`)
}

afterEach(() => {
  getCompletion.mockReset()
})

// ---- Complexity routing (three modes) ---------------------------------------

describe('routing — the complexity router only sizes the team', () => {
  it('SIMPLE collapses to one node, spends no planner call, and still runs the whole gate', async () => {
    const h = harness()
    const result = await h.run(SIMPLE_REQUEST)

    expect(result.complexity).toBe('simple')
    expect(result.usedPlannerLlm).toBe(false)
    expect(getCompletion).not.toHaveBeenCalled() // no router call, no planner call
    expect(h.writePlan).not.toHaveBeenCalled() // a one-node plan is not worth a file
    expect(h.executeNode).toHaveBeenCalledTimes(1)
    // A single-node graph IS the turn, so it runs as the lead (pre-orchestration
    // behavior); it still receives a shared-context digest string like any node.
    expect(h.executeNode.mock.calls[0][1].asLead).toBe(true)
    expect(typeof h.executeNode.mock.calls[0][1].context).toBe('string')
    // …but plan → execute → review still happened.
    expect(h.judge).toHaveBeenCalledTimes(1)
    expect(stagesOf(h.events)).toEqual(['planning', 'planning', 'generating', 'verifying'])
    expect(result.passed).toBe(true)
  })

  it('COMPLEX plans a real multi-node graph, writes plan.md, and runs scoped specialists', async () => {
    getCompletion.mockResolvedValueOnce(
      planJson([
        task('t1', 'database', [], ['db.ts']),
        task('t2', 'backend', ['t1'], ['api.ts']),
        task('t3', 'frontend', ['t2'], ['ui.tsx'])
      ])
    )
    const h = harness()
    const result = await h.run(COMPLEX_REQUEST)

    expect(result.complexity).toBe('complex')
    // The heuristic was confident, so the ONE completion spent was the planner's.
    expect(getCompletion).toHaveBeenCalledTimes(1)
    expect(result.usedPlannerLlm).toBe(true)
    expect(h.writePlan).toHaveBeenCalledTimes(1)
    expect(h.writePlan.mock.calls[0][0]).toContain('- [ ] **t1** (database) do t1')
    expect(h.executeNode).toHaveBeenCalledTimes(3)
    // A multi-node graph never runs a node as the lead — every one is a scoped
    // specialist that still receives its shared-context digest.
    expect(h.executeNode.mock.calls.every(([, opts]) => opts.asLead === false)).toBe(true)
    expect(h.executeNode.mock.calls.every(([, opts]) => typeof opts.context === 'string')).toBe(true)
    expect(result.tasks.map((t) => t.role)).toEqual(['database', 'backend', 'frontend'])
    expect(result.tasks.every((t) => t.state === 'completed')).toBe(true)
  })

  it('MEDIUM asks the router first, then the planner (exactly two completions)', async () => {
    getCompletion
      .mockResolvedValueOnce('{"reason":"a couple of related pieces","complexity":"medium"}')
      .mockResolvedValueOnce(planJson([task('t1', 'builder'), task('t2', 'testing', ['t1'])]))
    const h = harness()
    const result = await h.run(MEDIUM_REQUEST)

    expect(result.complexity).toBe('medium')
    expect(getCompletion).toHaveBeenCalledTimes(2)
    expect(result.tasks.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('degrades a malformed plan to one node — no plan.md, still the full gate', async () => {
    getCompletion.mockResolvedValueOnce('here is my plan: trust me')
    const h = harness()
    const result = await h.run(COMPLEX_REQUEST)

    expect(result.tasks).toHaveLength(1)
    expect(h.writePlan).not.toHaveBeenCalled()
    // Degraded to one node → that node IS the turn, so it runs as the lead.
    expect(h.executeNode.mock.calls[0][1].asLead).toBe(true)
    expect(h.judge).toHaveBeenCalledTimes(1)
  })
})

// ---- Assignment + announcement ---------------------------------------------

describe('assignment', () => {
  it('announces the graph and assigns every node with its dependencies', async () => {
    getCompletion.mockResolvedValueOnce(
      planJson([task('t1', 'backend'), task('t2', 'frontend', ['t1'])])
    )
    const h = harness()
    await h.run(COMPLEX_REQUEST)

    const plans = plansOf(h.events)
    expect(plans).toHaveLength(1)
    expect(plans[0].complexity).toBe('complex')
    expect(plans[0].tasks.map((t) => t.id)).toEqual(['t1', 't2'])

    const assigned = messagesOf(h.events).filter((m) => m.type === 'TASK_ASSIGNED')
    expect(assigned.map((m) => m.taskId)).toEqual(['t1', 't2'])
    expect(assigned[0].recipient).toBe('backend')
    expect(assigned[1].dependencies).toEqual(['t1'])
    expect(assigned[1].summary).toContain('Frontend Engineer')
  })
})

// ---- The "Plan first" approval checkpoint (#2) ------------------------------

describe('plan approval — the "Plan first" checkpoint', () => {
  it('runs straight through when no approver is injected (the toggle is off)', async () => {
    const h = harness()
    await h.run(SIMPLE_REQUEST)

    expect(h.executeNode).toHaveBeenCalledTimes(1)
    expect(h.events.some((e) => e.type === 'plan-approval')).toBe(false)
  })

  it('offers the plan for a go-ahead BEFORE any node runs, then builds it on approve', async () => {
    getCompletion.mockResolvedValueOnce(
      planJson([task('t1', 'backend'), task('t2', 'frontend', ['t1'])])
    )
    // Proves the ordering rather than asserting it after the fact: at the moment the
    // approver is consulted, nothing has been dispatched and nothing written.
    let dispatchedAtApproval = -1
    let writesAtApproval = -1
    const h = harness({
      approvePlan: async () => {
        dispatchedAtApproval = h.executeNode.mock.calls.length
        writesAtApproval = h.writePlan.mock.calls.length
        return 'approve'
      }
    })
    const result = await h.run(COMPLEX_REQUEST)

    expect(h.approvePlan).toHaveBeenCalledTimes(1)
    expect(dispatchedAtApproval).toBe(0)
    // The plan file itself is written first — it is what the user is approving.
    expect(writesAtApproval).toBe(1)
    // Approving builds in the SAME run: both nodes ran, and the gate still closed.
    expect(dispatched(h.executeNode)).toEqual(['t1', 't2'])
    expect(result.planRejected).toBeUndefined()
    expect(result.passed).toBe(true)
  })

  it('describes the plan it is asking about — one step per node, with the sized team', async () => {
    getCompletion.mockResolvedValueOnce(
      planJson([task('t1', 'backend'), task('t2', 'frontend', ['t1'])])
    )
    const h = harness({ approvePlan: async () => 'approve' })
    await h.run(COMPLEX_REQUEST)

    const proposal = h.approvePlan!.mock.calls[0][0]
    expect(proposal.complexity).toBe('complex')
    expect(proposal.steps).toHaveLength(2)
    // Each step names the specialist and what it will do, so the bar is readable
    // without opening the plan file.
    expect(proposal.steps[0]).toContain('Backend Engineer')
    expect(proposal.steps[0]).toContain('do t1')
    expect(proposal.steps[1]).toContain('Frontend Engineer')
    expect(proposal.wrotePlan).toBe(true)
  })

  it('a reject builds nothing, verifies nothing, and is reported as a decision', async () => {
    getCompletion.mockResolvedValueOnce(
      planJson([task('t1', 'backend'), task('t2', 'frontend', ['t1'])])
    )
    const h = harness({ approvePlan: async () => 'reject' })
    const result = await h.run(COMPLEX_REQUEST)

    expect(h.executeNode).not.toHaveBeenCalled()
    expect(h.verify).not.toHaveBeenCalled()
    expect(h.judge).not.toHaveBeenCalled()
    // Not a failure to retry: no rework, no review notes, nothing changed.
    expect(result.planRejected).toBe(true)
    expect(result.passed).toBe(false)
    expect(result.reworks).toBe(0)
    expect(result.reviewNotes).toBe('')
    expect(result.filesChanged).toEqual([])
    // And it says so in plain words instead of ending silently.
    expect(textOf(h.events)).toMatch(/stopped before building/i)
    expect(stagesOf(h.events).at(-1)).toBe('planning')
  })

  it('a cancel while the plan is waiting ends the run without building', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend')]))
    const h = harness({
      // What a Stop looks like from here: the engine resolves the pending decision
      // with a reject and the signal is already aborted.
      approvePlan: async () => {
        h.controller.abort()
        return 'reject'
      }
    })
    const result = await h.run(COMPLEX_REQUEST)

    expect(h.executeNode).not.toHaveBeenCalled()
    expect(result.passed).toBe(false)
  })
})

// ---- Parallelism + dependency ordering -------------------------------------

describe('execution — writers serialize, readers parallelize, real DAG ordering', () => {
  it('serializes file-writing specialists — one writer at a time, in order', async () => {
    // Every role here has the `filesystem` capability, so the scheduler runs them
    // strictly one at a time even though MAX_PARALLEL would allow three. This is
    // what makes the tool cards land one-by-one, the way a single engineer works.
    getCompletion.mockResolvedValueOnce(
      planJson([
        task('t1', 'backend'),
        task('t2', 'frontend'),
        task('t3', 'testing'),
        task('t4', 'docs')
      ])
    )
    const started: string[] = []
    let inFlight = 0
    let peak = 0

    const h = harness({
      executeNode: async (node) => {
        started.push(node.id)
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight--
        return ran(node)
      }
    })

    const result = await h.run(COMPLEX_REQUEST)
    // Never two writers at once, and dispatched in insertion order.
    expect(peak).toBe(1)
    expect(started).toEqual(['t1', 't2', 't3', 't4'])
    expect(result.tasks.every((t) => t.state === 'completed')).toBe(true)
  })

  it('still overlaps non-writing specialists up to the concurrency bound', async () => {
    // None of these roles touches the filesystem, so parallelism is unchanged:
    // three run at once and the fourth waits for a slot.
    getCompletion.mockResolvedValueOnce(
      planJson([
        task('t1', 'research'),
        task('t2', 'project-analyst'),
        task('t3', 'reviewer'),
        task('t4', 'research')
      ])
    )
    const started: string[] = []
    let inFlight = 0
    let peak = 0
    let release = (): void => {}
    const barrier = new Promise<void>((resolve) => {
      release = () => resolve()
    })

    const h = harness({
      executeNode: async (node) => {
        started.push(node.id)
        inFlight++
        peak = Math.max(peak, inFlight)
        await barrier
        inFlight--
        return ran(node)
      }
    })

    const run = h.run(COMPLEX_REQUEST)
    await until(() => started.length === 3, 'three readers in flight')
    expect(inFlight).toBe(3)
    expect(started).toEqual(['t1', 't2', 't3'])

    release()
    const result = await run
    expect(peak).toBe(3)
    expect(started).toEqual(['t1', 't2', 't3', 't4'])
    expect(result.tasks.every((t) => t.state === 'completed')).toBe(true)
  })

  it('runs a writer alongside a reader, but holds a second writer even with a free slot', async () => {
    // t1 (writer) and t2 (reader) run together; t3 (writer) is held not by the
    // concurrency bound — a slot is free — but because a writer is already running.
    // Proves the gate uses `continue`, not `break`: a reader further down the ready
    // set still starts while a writer runs.
    getCompletion.mockResolvedValueOnce(
      planJson([task('t1', 'backend'), task('t2', 'research'), task('t3', 'frontend')])
    )
    const started: string[] = []
    let inFlight = 0
    let release = (): void => {}
    const barrier = new Promise<void>((resolve) => {
      release = () => resolve()
    })

    const h = harness({
      executeNode: async (node) => {
        started.push(node.id)
        inFlight++
        await barrier
        inFlight--
        return ran(node)
      }
    })

    const run = h.run(COMPLEX_REQUEST)
    await until(() => started.length === 2, 'a writer and a reader in flight')
    expect(inFlight).toBe(2)
    // The writer overlaps the reader; the second writer has not started despite
    // only two of three slots being taken.
    expect(started).toEqual(['t1', 't2'])

    release()
    const result = await run
    // The held writer runs once the first writer frees the exclusive slot.
    expect(started).toEqual(['t1', 't2', 't3'])
    expect(result.tasks.every((t) => t.state === 'completed')).toBe(true)
  })

  it('holds a dependent node until every dependency has completed', async () => {
    // t1/t2 are readers so they still overlap (two writers would serialize); t3
    // depends on both and must wait for the pair regardless of their roles.
    getCompletion.mockResolvedValueOnce(
      planJson([task('t1', 'research'), task('t2', 'reviewer'), task('t3', 'integration', ['t1', 't2'])])
    )
    const trace: string[] = []
    const h = harness({
      executeNode: async (node) => {
        trace.push(`start:${node.id}`)
        await new Promise((resolve) => setTimeout(resolve, 1))
        trace.push(`end:${node.id}`)
        return ran(node)
      }
    })
    await h.run(COMPLEX_REQUEST)

    // t1 and t2 overlap…
    expect(trace.indexOf('start:t2')).toBeLessThan(trace.indexOf('end:t1'))
    // …and t3 cannot begin until both are finished.
    expect(trace.indexOf('start:t3')).toBeGreaterThan(trace.indexOf('end:t1'))
    expect(trace.indexOf('start:t3')).toBeGreaterThan(trace.indexOf('end:t2'))
  })

  it('emits a lifecycle task-update for every state transition', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend'), task('t2', 'frontend', ['t1'])]))
    const h = harness()
    await h.run(COMPLEX_REQUEST)

    const t1 = updatesOf(h.events).filter((t) => t.id === 't1').map((t) => t.state)
    const t2 = updatesOf(h.events).filter((t) => t.id === 't2').map((t) => t.state)
    // t1 is already `ready` when the graph is constructed (no dependencies), so its
    // first observable transition is the dispatch.
    expect(t1).toEqual(['running', 'completed'])
    // t2 is promoted pending → ready only once t1 completed, so that shows up too.
    expect(t2).toEqual(['ready', 'running', 'completed'])
    const started = messagesOf(h.events).filter((m) => m.type === 'STARTED')
    expect(started.map((m) => m.taskId)).toEqual(['t1', 't2'])
  })
})

// ---- Retry + failure propagation -------------------------------------------

describe('failure handling', () => {
  it('retries a failed node once, then completes it', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend'), task('t2', 'frontend', ['t1'])]))
    let attempts = 0
    const h = harness({
      executeNode: async (node) => {
        if (node.id === 't1' && ++attempts === 1) return threw(node, 'flaky failure')
        return ran(node)
      }
    })
    const result = await h.run(COMPLEX_REQUEST)

    expect(dispatched(h.executeNode)).toEqual(['t1', 't1', 't2'])
    const t1 = result.tasks.find((t) => t.id === 't1') as TaskNode
    expect(t1.state).toBe('completed')
    expect(t1.attempts).toBe(2)
    expect(updatesOf(h.events).some((t) => t.id === 't1' && t.state === 'retrying')).toBe(true)
    expect(messagesOf(h.events).some((m) => m.type === 'TASK_FAILED' && m.taskId === 't1')).toBe(true)
    expect(result.passed).toBe(true)
  })

  it('blocks dependents of an exhausted node and reports the failure honestly', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend'), task('t2', 'frontend', ['t1'])]))
    const h = harness({
      executeNode: async (node) => (node.id === 't1' ? threw(node) : ran(node))
    })
    const result = await h.run(COMPLEX_REQUEST)

    const t1 = result.tasks.find((t) => t.id === 't1') as TaskNode
    const t2 = result.tasks.find((t) => t.id === 't2') as TaskNode
    expect(t1.state).toBe('failed')
    expect(t1.attempts).toBe(2) // one retry, then it stays failed
    expect(t2.state).toBe('blocked')
    expect(dispatched(h.executeNode)).not.toContain('t2') // a blocked node never runs
    expect(messagesOf(h.events).some((m) => m.type === 'BLOCKED' && m.taskId === 't2')).toBe(true)

    // A failed node is hard evidence: the run does NOT claim success, even though
    // the (default) reviewer said pass — and rework is exhausted trying to fix it.
    expect(result.passed).toBe(false)
    expect(result.reworks).toBe(2)
    const text = textOf(h.events)
    // Named by role, not by node id, and the reason is all the line adds — the bullet
    // list above already said which piece each of these was.
    expect(text).toContain('⚠ **Backend Engineer** — failed: t1 exploded')
    expect(text).toContain('⚠ **Frontend Engineer** — blocked')
    expect(text).toContain('Review still failing after 2 rework attempts')
    expect(text).toContain('this needs your input')
  })

  it('records a node that throws as a failure rather than crashing the run', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend'), task('t2', 'frontend')]))
    const h = harness({
      executeNode: async (node) => {
        if (node.id === 't1') throw new Error('provider exploded')
        return ran(node)
      }
    })
    const result = await h.run(COMPLEX_REQUEST)

    expect(result.tasks.find((t) => t.id === 't1')?.state).toBe('failed')
    expect(result.tasks.find((t) => t.id === 't1')?.error).toContain('provider exploded')
    expect(result.tasks.find((t) => t.id === 't2')?.state).toBe('completed')
  })
})

// ---- Shared context scoping ------------------------------------------------

describe('shared context', () => {
  it('gives each node exactly the upstream findings its role scope allows', async () => {
    getCompletion.mockResolvedValueOnce(
      planJson([
        task('t1', 'database'),
        task('t2', 'backend', ['t1']),
        task('t3', 'integration', ['t1', 't2'])
      ])
    )
    const reports: Record<string, string> = {
      t1: 'PICKED_SQLITE for storage',
      t2: 'BUILT_ENDPOINT /api/notes',
      t3: 'WIRED_IT together'
    }
    const h = harness({
      executeNode: async (node) => ran(node, reports[node.id], [`${node.id}.ts`])
    })
    await h.run(COMPLEX_REQUEST)

    const contextFor = (id: string): string =>
      (h.executeNode.mock.calls.find(([node]) => node.id === id) as [TaskNode, { context: string }])[1]
        .context

    // t1 has no upstream: it sees the plan, and none of its siblings' findings.
    expect(contextFor('t1')).toContain('### Plan')
    expect(contextFor('t1')).not.toContain('PICKED_SQLITE')

    // t2 is `scoped`: it inherits its dependency's finding and nothing else.
    expect(contextFor('t2')).toContain('PICKED_SQLITE')
    expect(contextFor('t2')).not.toContain('BUILT_ENDPOINT')

    // t3 is `full`: the whole picture, including the execution roll-up.
    expect(contextFor('t3')).toContain('PICKED_SQLITE')
    expect(contextFor('t3')).toContain('BUILT_ENDPOINT')
    expect(contextFor('t3')).toContain('### Work completed')
    expect(contextFor('t3')).toContain('### Artifacts')
  })

  it('gives the reviewer the minimal execution digest, not the finding firehose', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend')]))
    const h = harness({ executeNode: async (node) => ran(node, 'BUILT_ENDPOINT /api/notes') })
    await h.run(COMPLEX_REQUEST)

    const review = h.judge.mock.calls[0][0]
    const user = review[1].content
    expect(review[0].role).toBe('system')
    expect(review[0].content).toContain('REVIEWER')
    expect(user).toContain(COMPLEX_REQUEST)
    expect(user).toContain('### Work completed')
    expect(user).not.toContain('### Findings so far')
  })

  it('publishes each report as a FINDING, and stays quiet when a node reports nothing', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend'), task('t2', 'docs')]))
    const h = harness({
      executeNode: async (node) => ran(node, node.id === 't1' ? 'a real finding' : '')
    })
    await h.run(COMPLEX_REQUEST)

    const findings = messagesOf(h.events).filter((m) => m.type === 'FINDING')
    expect(findings).toHaveLength(1)
    expect(findings[0].taskId).toBe('t1')
    expect(findings[0].findings?.[0].detail).toBe('a real finding')
    // t2 still completed — an empty report is not a failure.
    expect(messagesOf(h.events).filter((m) => m.type === 'TASK_COMPLETED')).toHaveLength(2)
  })
})

// ---- The mandatory review gate --------------------------------------------

describe('review gate', () => {
  it('passes cleanly with no rework', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend'), task('t2', 'frontend')]))
    const h = harness({ judge: async () => verdictJson('pass') })
    const result = await h.run(COMPLEX_REQUEST)

    expect(h.judge).toHaveBeenCalledTimes(1)
    expect(result.passed).toBe(true)
    expect(result.reworks).toBe(0)
    expect(result.reviewNotes).toBe('')
    expect(messagesOf(h.events).some((m) => m.type === 'RETRY_REQUIRED')).toBe(false)
    expect(messagesOf(h.events).some((m) => m.type === 'REQUEST_REVIEW')).toBe(true)
  })

  it('routes a FAIL back as real rework, re-reviews, and never re-runs completed work', async () => {
    getCompletion.mockResolvedValueOnce(
      planJson([task('t1', 'backend'), task('t2', 'frontend'), task('t3', 'docs')])
    )
    const h = harness({
      judge: vi
        .fn<Judge>()
        .mockResolvedValueOnce(verdictJson('fail', 'the endpoint is not wired up', 'frontend'))
        .mockResolvedValueOnce(verdictJson('pass'))
    })
    const result = await h.run(COMPLEX_REQUEST)

    expect(result.reworks).toBe(1)
    expect(result.passed).toBe(true)
    expect(h.judge).toHaveBeenCalledTimes(2)

    // Exactly one new dispatch: the rework node. t1–t3 stayed completed.
    expect(dispatched(h.executeNode)).toEqual(['t1', 't2', 't3', 'rework-1'])
    const rework = result.tasks.find((t) => t.id === 'rework-1') as TaskNode
    expect(rework.role).toBe('frontend') // the role the reviewer named
    expect(rework.description).toContain('the endpoint is not wired up')
    expect(rework.state).toBe('completed')

    const retry = messagesOf(h.events).find((m) => m.type === 'RETRY_REQUIRED') as AgentMessage
    expect(retry.recipient).toBe('frontend')
    expect(retry.nextAction).toBe('the endpoint is not wired up')
    // The regraphed plan is re-announced so the UI can show the new node.
    expect(plansOf(h.events)).toHaveLength(2)
    expect(plansOf(h.events)[1].tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3', 'rework-1'])
  })

  it('falls back to a capable generalist when the reviewer names an unknown role', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend')]))
    const h = harness({
      judge: vi
        .fn<Judge>()
        .mockResolvedValueOnce(verdictJson('fail', 'needs work', 'wizard'))
        .mockResolvedValueOnce(verdictJson('pass'))
    })
    const result = await h.run(COMPLEX_REQUEST)
    expect(result.tasks.find((t) => t.id === 'rework-1')?.role).toBe('builder')
  })

  it('stops after the rework bound and says so instead of looping forever', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend'), task('t2', 'frontend')]))
    const h = harness({ judge: async () => verdictJson('fail', 'still not right', 'backend') })
    const result = await h.run(COMPLEX_REQUEST)

    expect(result.reworks).toBe(2)
    expect(result.passed).toBe(false)
    expect(result.reviewNotes).toBe('still not right')
    expect(dispatched(h.executeNode)).toEqual(['t1', 't2', 'rework-1', 'rework-2'])
    expect(textOf(h.events)).toContain('Review still failing after 2 rework attempts: still not right')
  })

  it('fails open when the reviewer is unparseable or unavailable', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend')]))
    const garbage = await harness({ judge: async () => 'looks fine to me!' }).run(COMPLEX_REQUEST)
    expect(garbage.passed).toBe(true)
    expect(garbage.reworks).toBe(0)

    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend')]))
    const down = await harness({
      judge: async () => {
        throw new Error('provider down')
      }
    }).run(COMPLEX_REQUEST)
    expect(down.passed).toBe(true)
    expect(down.reworks).toBe(0)
  })
})

// ---- Verification ----------------------------------------------------------

describe('verification', () => {
  it('does not run checks when nothing was written', async () => {
    const h = harness()
    const result = await h.run(SIMPLE_REQUEST)
    expect(h.verify).not.toHaveBeenCalled()
    expect(result.passed).toBe(true)
    expect(stagesOf(h.events)).not.toContain('executing')
  })

  it('runs the project checks on what changed and reports the pass', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend'), task('t2', 'frontend')]))
    const h = harness({
      executeNode: async (node) => ran(node, `${node.id} done`, [`src/${node.id}.ts`]),
      verify: async () => ({ ran: true, ok: true, command: 'npm run typecheck', output: 'ok' })
    })
    const result = await h.run(COMPLEX_REQUEST)

    expect(h.verify).toHaveBeenCalledTimes(1)
    expect(h.verify.mock.calls[0][0]).toEqual(['src/t1.ts', 'src/t2.ts'])
    expect(result.filesChanged).toEqual(['src/t1.ts', 'src/t2.ts'])
    const text = textOf(h.events)
    expect(text).toContain('Files changed: src/t1.ts, src/t2.ts')
    expect(text).toContain('Verified with `npm run typecheck`')
    // The reviewer is briefed on the check it did not run itself.
    expect(h.judge.mock.calls[0][0][1].content).toContain('npm run typecheck → passed')
  })

  it('treats "no check ran" as unverified, never as a failure', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend'), task('t2', 'frontend')]))
    const h = harness({
      executeNode: async (node) => ran(node, `${node.id} done`, ['src/a.ts']),
      // What the engine returns when the user declined the command, or the project
      // simply has no check to run.
      verify: async () => ({ ran: false, ok: false, command: 'npm run test' })
    })
    const result = await h.run(COMPLEX_REQUEST)

    expect(result.passed).toBe(true)
    const text = textOf(h.events)
    expect(text).not.toContain('Verified with')
    expect(text).not.toContain('⚠')
    expect(h.judge.mock.calls[0][0][1].content).not.toContain('## Verification')
  })

  it('treats a failing check as hard evidence that overrides a lenient reviewer', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend'), task('t2', 'frontend')]))
    const h = harness({
      executeNode: async (node) => ran(node, `${node.id} done`, ['src/a.ts']),
      verify: async () => ({
        ran: true,
        ok: false,
        command: 'npm run typecheck',
        output: 'src/a.ts(3,1): error TS2322'
      }),
      judge: async () => verdictJson('pass') // the model would have let this through
    })
    const result = await h.run(COMPLEX_REQUEST)

    expect(result.passed).toBe(false)
    expect(result.reviewNotes).toContain("The project's checks failed")
    expect(textOf(h.events)).toContain('⚠ `npm run typecheck` failed')
    expect(h.judge.mock.calls[0][0][1].content).toContain('error TS2322')
  })

  it('re-verifies after rework and passes once the checks go green', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend'), task('t2', 'frontend')]))
    const h = harness({
      executeNode: async (node) => ran(node, `${node.id} done`, ['src/a.ts']),
      verify: vi
        .fn<Verify>()
        .mockResolvedValueOnce({ ran: true, ok: false, command: 'npm run typecheck', output: 'boom' })
        .mockResolvedValue({ ran: true, ok: true, command: 'npm run typecheck', output: 'ok' })
    })
    const result = await h.run(COMPLEX_REQUEST)

    expect(h.verify).toHaveBeenCalledTimes(2)
    expect(result.reworks).toBe(1)
    expect(result.passed).toBe(true)
    expect(dispatched(h.executeNode)).toEqual(['t1', 't2', 'rework-1'])
    expect(stagesOf(h.events)).toContain('executing')
  })
})

// ---- Response discipline ---------------------------------------------------

describe('response', () => {
  it('stays silent on a clean single-node turn (the agent already spoke)', async () => {
    const h = harness()
    await h.run(SIMPLE_REQUEST)
    expect(h.events.some((e) => e.type === 'delta')).toBe(false)
  })

  it('rolls up a multi-node build with a per-task result line', async () => {
    getCompletion.mockResolvedValueOnce(
      planJson([task('t1', 'database'), task('t2', 'backend', ['t1'])])
    )
    const h = harness()
    await h.run(COMPLEX_REQUEST)

    // Each line leads with who did the work and what it was. The old
    // "**Team result** (complex, 2 tasks)" header and the `t1`/`t2` prefixes were
    // Sylor describing its own routing: the ids surface nowhere else in the app, and
    // the count is right there in the list.
    const text = textOf(h.events)
    expect(text).toContain('- ✓ **Database Engineer** — do t1')
    expect(text).toContain('- ✓ **Backend Engineer** — do t2')
    expect(text).not.toContain('Team result')
    expect(text).not.toContain('**t1**')
  })
})

// ---- Cancellation ----------------------------------------------------------

describe('cancellation', () => {
  it('cancels outstanding nodes and skips review when the run is aborted mid-execution', async () => {
    getCompletion.mockResolvedValueOnce(
      planJson([task('t1', 'backend'), task('t2', 'frontend'), task('t3', 'docs')])
    )
    const h = harness()
    h.executeNode.mockImplementation(async (node) => {
      h.controller.abort()
      return threw(node, 'cancelled')
    })
    const result = await h.run(COMPLEX_REQUEST)

    expect(result.reviewNotes).toBe('Cancelled.')
    expect(result.tasks.every((t) => t.state === 'cancelled')).toBe(true)
    expect(h.judge).not.toHaveBeenCalled()
    expect(h.verify).not.toHaveBeenCalled()
    expect(h.events.some((e) => e.type === 'delta')).toBe(false)
  })

  it('stops before dispatching anything when the run is aborted during planning', async () => {
    getCompletion.mockResolvedValueOnce(planJson([task('t1', 'backend'), task('t2', 'frontend')]))
    const h = harness()
    h.writePlan.mockImplementation(async () => {
      h.controller.abort()
    })
    const result = await h.run(COMPLEX_REQUEST)

    expect(h.writePlan).toHaveBeenCalledTimes(1)
    expect(h.executeNode).not.toHaveBeenCalled()
    expect(h.judge).not.toHaveBeenCalled()
    expect(result.tasks).toEqual([])
  })
})
