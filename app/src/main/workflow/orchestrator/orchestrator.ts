/**
 * The orchestrator — the state machine that turns a work request into a real
 * hierarchical multi-agent run.
 *
 * ```
 * PLAN      → complexity router + planner (≤1 LLM call; SIMPLE spends none)
 * ASSIGN    → build the TaskGraph, announce it, record it on the blackboard
 * EXECUTE   → the scheduler runs the ready set IN PARALLEL, each node a scoped
 *             specialist agent; every report lands on the blackboard as a Finding
 * INTEGRATE → deterministic gather (no LLM): reports, files, failures
 * VERIFY    → run the project's own checks when it has some and files changed
 * REVIEW    → mandatory verdict: PASS, or FAIL routed back as bounded rework
 * RESPOND   → synthesize the closing answer from shared context
 * ```
 *
 * Design contract (locked with the user):
 *  - **Engine-owned, few LLM calls.** Routing, assignment, integration, and the
 *    final synthesis are deterministic code. The model is spent only on
 *    planning (one call, skipped entirely for SIMPLE), each specialist's actual
 *    work, and the review verdict (one non-streaming call).
 *  - **Always orchestrate.** Every work-producing Code turn enters this gate.
 *    The complexity router only sizes the team: a SIMPLE request collapses to a
 *    single node, but plan → execute → verify → review → respond still runs.
 *  - **Honest completion.** A failed node, a failed check, or rework exhaustion
 *    is reported to the user. The run never claims success it didn't achieve.
 *
 * Dependency injection is deliberate: this module never imports the engine.
 * Everything with a side effect — running an agent, writing plan.md, running a
 * gated command, calling the provider — arrives as a callback in
 * {@link OrchestratorDeps}. That keeps the state machine pure enough to unit-test
 * with fakes, and keeps the import graph acyclic (engine → orchestrator only).
 */
import type {
  ChatMessage,
  Complexity,
  Finding,
  ProviderSettings,
  TaskNode,
  WorkflowEvent
} from '../../../shared/types'
import { classifyComplexity } from './complexity'
import { buildPlan } from './planner'
import { SharedContext } from './sharedContext'
import { TaskGraph, runScheduler, type NodeOutcome } from './taskGraph'
import { resolveRole } from './roles'
import {
  ORCHESTRATOR,
  blocked,
  finding as findingMessage,
  requestReview,
  retryRequired,
  started,
  taskAssigned,
  taskCompleted,
  taskFailed
} from './messages'

/** How many specialist nodes may run at once (bounded so a big plan can't storm the provider). */
const MAX_PARALLEL = 3

/** Total attempts per node before it stays `failed` (1 retry). */
const MAX_ATTEMPTS = 2

/**
 * How many rework rounds a failing review may trigger before the run stops and
 * reports the failure honestly. Bounded so a model that always says FAIL can't
 * spin the turn forever.
 */
const MAX_REWORK = 2

/** The role that receives rework when the reviewer names none we recognize. */
const DEFAULT_REWORK_ROLE = 'builder'

/** What one executed node reports back to the orchestrator. */
export interface NodeRunResult {
  /** The agent that ran it (correlates with agent-start/agent-end events). */
  agentId: string
  /** The specialist's closing prose — its report. */
  report: string
  /** False when the node threw or the run was aborted mid-node. */
  ok: boolean
  /** Project-relative paths this node actually wrote (from applied tool results). */
  filesChanged: string[]
}

/** Options handed to {@link OrchestratorDeps.executeNode} for one dispatch. */
export interface NodeRunOptions {
  /**
   * True when this node IS the whole run (a single-node graph): the engine runs
   * it as the lead — full conversation history, spawn allowed — so a SIMPLE turn
   * behaves exactly as it did before orchestration existed.
   */
  asLead: boolean
  /** The scoped shared-context digest to inject into the node's prompt. */
  context: string
}

/** Outcome of the VERIFY stage. */
export interface VerifyOutcome {
  /** False when the project has no check to run (or nothing was written). */
  ran: boolean
  /** Whether the check passed. Meaningless when `ran` is false. */
  ok: boolean
  /** The command that ran, for the report. */
  command?: string
  /** Bounded output, used to brief the reviewer on a failure. */
  output?: string
}

/** Everything the orchestrator needs from the engine. */
export interface OrchestratorDeps {
  runId: string
  /** The user's request (their last message) — the top-level task. */
  request: string
  /** Project overview, or '' when the turn gathered no context. */
  overview: string
  settings: ProviderSettings
  emit: (event: WorkflowEvent) => void
  signal: AbortSignal
  /** Runs one task node as a real, scoped agent. Never throws. */
  executeNode: (node: TaskNode, opts: NodeRunOptions) => Promise<NodeRunResult>
  /**
   * Persists the rendered plan. The engine routes this through the same
   * permission gate as any other write, so `plan.md` is never written behind the
   * user's back — hence the await.
   */
  writePlan: (markdown: string) => Promise<void>
  /** Runs the project's own checks through the gated pipeline, if it has any. */
  verify: (filesChanged: string[]) => Promise<VerifyOutcome>
  /** One non-streaming completion, used for the review verdict. */
  judge: (messages: ChatMessage[]) => Promise<string>
}

/** The reviewer's parsed verdict. */
interface Verdict {
  pass: boolean
  reason: string
  /** Which role should fix it, when failing. */
  targetRole: string
}

/** What the run produced, returned to the engine (and asserted in tests). */
export interface OrchestratorResult {
  complexity: Complexity
  /** Final state of every node (including any rework nodes added). */
  tasks: TaskNode[]
  /** Whether the review gate ultimately passed. */
  passed: boolean
  /** How many rework rounds were spent. */
  reworks: number
  /** The reviewer's closing reason (empty when it passed cleanly). */
  reviewNotes: string
  /** Whether planning spent a provider call. */
  usedPlannerLlm: boolean
  /** Every file the team wrote this turn. */
  filesChanged: string[]
}

/**
 * Runs the full orchestration gate for one work turn. Never throws: a stage that
 * fails is folded into the result and reported to the user, so the engine's
 * `done`/`error` contract is unchanged.
 */
export async function runOrchestrator(deps: OrchestratorDeps): Promise<OrchestratorResult> {
  const { runId, request, overview, settings, emit, signal } = deps

  // ── PLAN ────────────────────────────────────────────────────────────────
  // Route first (cheap, usually heuristic-only), then plan. SIMPLE never asks
  // the model for a plan — it collapses to one node and goes straight to work.
  emit({ type: 'status', runId, stage: 'planning', message: 'Sizing the work…' })
  const complexity = await classifyComplexity(request, settings)
  if (signal.aborted) return aborted(complexity)

  emit({
    type: 'status',
    runId,
    stage: 'planning',
    message: complexity === 'simple' ? 'Planning the change…' : `Planning a ${complexity} build…`
  })
  // plan.md is written only for a real multi-task plan: a one-node plan carries
  // no information the user doesn't already see, and writing it would add a
  // surprise file to every small edit.
  let planMarkdown = ''
  const plan = await buildPlan(request, complexity, settings, {
    overview,
    writePlan: (markdown) => {
      planMarkdown = markdown
    }
  })
  if (signal.aborted) return aborted(complexity)
  if (plan.tasks.length > 1 && planMarkdown) {
    await deps.writePlan(planMarkdown)
    if (signal.aborted) return aborted(complexity)
  }

  // ── ASSIGN ──────────────────────────────────────────────────────────────
  // The planner already validated its output through a TaskGraph, so this
  // should never throw; guard anyway and degrade to a single node rather than
  // failing the turn.
  let graph: TaskGraph
  try {
    graph = new TaskGraph(plan.tasks)
  } catch {
    graph = new TaskGraph([soloNode(request)])
  }
  const shared = new SharedContext(request, { plan: plan.markdown, graph })

  emit({ type: 'plan', runId, complexity, tasks: graph.all })
  for (const node of graph.all) {
    emit({
      type: 'agent-message',
      runId,
      message: taskAssigned(
        {
          taskId: node.id,
          agentId: ORCHESTRATOR,
          role: node.role,
          summary: `${resolveRole(node.role).title}: ${node.description}`
        },
        { recipient: node.role, dependencies: node.dependsOn }
      )
    })
  }

  // ── EXECUTE ─────────────────────────────────────────────────────────────
  const filesChanged: string[] = []
  await execute(graph, shared, deps, filesChanged)
  if (signal.aborted) return aborted(complexity, graph.all)

  // ── INTEGRATE ───────────────────────────────────────────────────────────
  // Deterministic gather — no LLM call. The blackboard already holds every
  // report and artifact; integration is reading it, not re-deriving it.
  const failures = graph.all.filter((n) => n.state === 'failed' || n.state === 'blocked')

  // ── VERIFY ──────────────────────────────────────────────────────────────
  let verification: VerifyOutcome = { ran: false, ok: false }
  if (filesChanged.length > 0) {
    emit({ type: 'status', runId, stage: 'verifying', message: 'Verifying the result…' })
    verification = await deps.verify(filesChanged)
    if (signal.aborted) return aborted(complexity, graph.all)
    if (verification.ran) {
      shared.addFinding({
        agentId: ORCHESTRATOR,
        taskId: 'verify',
        role: 'reviewer',
        detail: `Verification (${verification.command ?? 'checks'}): ${
          verification.ok ? 'passed' : `FAILED — ${(verification.output ?? '').trim()}`
        }`
      })
    }
  }

  // ── REVIEW (+ bounded rework) ───────────────────────────────────────────
  let reworks = 0
  let verdict = await review(deps, shared, graph, verification, failures.length)
  if (signal.aborted) return aborted(complexity, graph.all)

  while (!verdict.pass && reworks < MAX_REWORK) {
    reworks++
    const target = verdict.targetRole
    const node = reworkNode(reworks, target, verdict.reason, request)

    emit({
      type: 'agent-message',
      runId,
      message: retryRequired(
        { taskId: node.id, agentId: ORCHESTRATOR, role: target, summary: `Rework ${reworks}: ${verdict.reason}` },
        { recipient: target, reason: verdict.reason }
      )
    })
    emit({
      type: 'status',
      runId,
      stage: 'executing',
      message: `Reworking after review (${reworks}/${MAX_REWORK})…`
    })

    // Rebuild the graph with the rework node appended. The constructor preserves
    // each node's existing state, so completed work is not re-run — only the new
    // node is dispatchable.
    graph = new TaskGraph([...graph.all, node])
    shared.setGraph(graph)
    emit({ type: 'plan', runId, complexity, tasks: graph.all })

    await execute(graph, shared, deps, filesChanged)
    if (signal.aborted) return aborted(complexity, graph.all)

    if (filesChanged.length > 0) {
      emit({ type: 'status', runId, stage: 'verifying', message: 'Re-verifying…' })
      verification = await deps.verify(filesChanged)
      if (signal.aborted) return aborted(complexity, graph.all)
    }
    verdict = await review(
      deps,
      shared,
      graph,
      verification,
      graph.all.filter((n) => n.state === 'failed' || n.state === 'blocked').length
    )
    if (signal.aborted) return aborted(complexity, graph.all)
  }

  // ── RESPOND ─────────────────────────────────────────────────────────────
  const result: OrchestratorResult = {
    complexity,
    tasks: graph.all,
    passed: verdict.pass,
    reworks,
    reviewNotes: verdict.pass ? '' : verdict.reason,
    usedPlannerLlm: plan.usedLlm,
    filesChanged: [...new Set(filesChanged)]
  }
  respond(deps, graph, result, verification)
  return result
}

/**
 * Drives the scheduler over the graph's outstanding nodes. Each dispatched node
 * becomes a scoped agent; its report is recorded on the blackboard as a
 * {@link Finding} so downstream nodes inherit what it learned instead of
 * rediscovering it. Independent nodes overlap up to {@link MAX_PARALLEL}; a node
 * starts the instant its last dependency completes.
 */
async function execute(
  graph: TaskGraph,
  shared: SharedContext,
  deps: OrchestratorDeps,
  filesChanged: string[]
): Promise<void> {
  const { runId, emit, signal } = deps
  let announced = false

  const executeOne = async (node: TaskNode): Promise<NodeOutcome> => {
    // One 'generating' status the first time real work starts, so the timeline
    // reads the same as a pre-orchestration turn.
    if (!announced) {
      announced = true
      emit({ type: 'status', runId, stage: 'generating', message: 'Generating…' })
    }

    const context = shared.summarizeForAgent(node)
    const run = await deps.executeNode(node, { asLead: graph.size === 1, context })

    emit({
      type: 'agent-message',
      runId,
      message: run.ok
        ? taskCompleted(
            { taskId: node.id, agentId: run.agentId, role: node.role, summary: firstLine(run.report) },
            { filesChanged: run.filesChanged }
          )
        : taskFailed(
            { taskId: node.id, agentId: run.agentId, role: node.role, summary: 'Task failed.' },
            [run.report || 'The agent returned no report.']
          )
    })

    for (const file of run.filesChanged) filesChanged.push(file)
    if (run.report.trim()) {
      const record: Finding = {
        agentId: run.agentId,
        taskId: node.id,
        role: node.role,
        detail: run.report.trim(),
        files: run.filesChanged.length ? run.filesChanged : undefined
      }
      shared.addFinding(record)
      emit({
        type: 'agent-message',
        runId,
        message: findingMessage(
          { taskId: node.id, agentId: run.agentId, role: node.role, summary: firstLine(run.report) },
          [record]
        )
      })
    }
    for (const file of run.filesChanged) {
      shared.addArtifact({ by: node.role, ref: file, note: node.id })
    }

    return run.ok
      ? { ok: true, result: run.report }
      : { ok: false, error: run.report || 'The agent returned no report.' }
  }

  await runScheduler(graph, executeOne, {
    signal,
    concurrency: MAX_PARALLEL,
    maxAttempts: MAX_ATTEMPTS,
    onStateChange: (node) => {
      emit({ type: 'task-update', runId, task: { ...node } })
      const base = {
        taskId: node.id,
        agentId: ORCHESTRATOR,
        role: node.role,
        summary: `${node.id} — ${node.state}`
      }
      if (node.state === 'running') emit({ type: 'agent-message', runId, message: started(base) })
      else if (node.state === 'blocked') {
        emit({
          type: 'agent-message',
          runId,
          message: blocked(base, 'A dependency did not complete.')
        })
      }
    }
  })
}

/**
 * The mandatory review gate. One non-streaming completion judges the integrated
 * work against the request, the plan, what each node reported, and the
 * verification output, returning `PASS` or `FAIL` with a target role.
 *
 * **Fails open on purpose.** If the provider errors or returns something we
 * can't parse, we do not invent a failure and force pointless rework — we take
 * the deterministic signals we *do* trust (a failed node, a failed check) as the
 * verdict instead. A review that couldn't run is not evidence of a defect.
 */
async function review(
  deps: OrchestratorDeps,
  shared: SharedContext,
  graph: TaskGraph,
  verification: VerifyOutcome,
  failureCount: number
): Promise<Verdict> {
  const { runId, emit } = deps
  emit({ type: 'status', runId, stage: 'verifying', message: 'Reviewing the work…' })
  emit({
    type: 'agent-message',
    runId,
    message: requestReview({
      taskId: 'review',
      agentId: ORCHESTRATOR,
      role: 'reviewer',
      summary: 'Reviewing the integrated result.'
    })
  })

  // Deterministic evidence the reviewer cannot override: if a node failed or the
  // project's own checks failed, the run did not succeed.
  const hardFailure =
    failureCount > 0
      ? `${failureCount} task(s) did not complete.`
      : verification.ran && !verification.ok
        ? `The project's checks failed (${verification.command ?? 'checks'}).`
        : ''

  const digest = shared.summarizeForAgent({ id: 'review', role: 'reviewer', dependsOn: [] })
  const system =
    "You are Sylor's REVIEWER. Judge whether the team's work actually satisfies the user's " +
    'request. Be strict about substance (missing work, wrong approach, broken wiring) and ' +
    'lenient about style. Do NOT ask for work the user did not request.\n' +
    'Respond with ONLY valid JSON: ' +
    '{"verdict":"pass"|"fail","reason":"<one sentence>","targetRole":"<role that should fix it>"}.'
  const user =
    `## User request\n${deps.request}\n\n${digest}\n\n` +
    (verification.ran
      ? `## Verification\n${verification.command ?? 'checks'} → ${
          verification.ok ? 'passed' : `FAILED\n${(verification.output ?? '').slice(0, 2000)}`
        }\n\n`
      : '') +
    (hardFailure ? `## Known problems\n${hardFailure}\n` : '')

  let parsed: Verdict | null = null
  try {
    const raw = await deps.judge([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ])
    parsed = parseVerdict(raw, graph)
  } catch {
    parsed = null
  }

  if (hardFailure) {
    // Trust the hard evidence over a lenient verdict, but keep the reviewer's
    // reason when it agrees, since it is usually more specific.
    return {
      pass: false,
      reason: parsed && !parsed.pass ? parsed.reason : hardFailure,
      targetRole: parsed?.targetRole ?? DEFAULT_REWORK_ROLE
    }
  }
  if (!parsed) return { pass: true, reason: '', targetRole: DEFAULT_REWORK_ROLE }
  return parsed
}

/** Parses the reviewer's JSON verdict, resolving its target role against the registry. */
function parseVerdict(raw: unknown, graph: TaskGraph): Verdict | null {
  if (typeof raw !== 'string') return null
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  let obj: { verdict?: unknown; reason?: unknown; targetRole?: unknown }
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (obj.verdict !== 'pass' && obj.verdict !== 'fail') return null
  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : ''
  // Prefer a role that actually worked on this run; otherwise the registry
  // fallback keeps rework pointed at a capable generalist.
  const named = typeof obj.targetRole === 'string' ? obj.targetRole.trim() : ''
  const onTeam = graph.all.some((n) => n.role === named)
  return {
    pass: obj.verdict === 'pass',
    reason: reason || (obj.verdict === 'fail' ? 'The reviewer rejected the result.' : ''),
    targetRole: onTeam ? named : resolveRole(named).id
  }
}

/**
 * Streams the closing message — but only when it tells the user something the
 * stream hasn't already shown. A clean single-node turn ends on the agent's own
 * prose (adding a summary of a summary is noise); a multi-node build, a failed
 * task, a failed check, or an exhausted review gate always gets an explicit,
 * honest roll-up.
 */
function respond(
  deps: OrchestratorDeps,
  graph: TaskGraph,
  result: OrchestratorResult,
  verification: VerifyOutcome
): void {
  const { runId, emit } = deps
  const problems = graph.all.filter((n) => n.state === 'failed' || n.state === 'blocked')
  const multi = graph.size > 1
  const verifyFailed = verification.ran && !verification.ok
  if (!multi && !problems.length && !verifyFailed && result.passed) return

  const lines: string[] = ['']
  if (multi) {
    lines.push(`**Team result** (${result.complexity}, ${graph.size} tasks)`)
    for (const node of graph.all) {
      const mark = node.state === 'completed' ? '✓' : node.state === 'running' ? '·' : '✗'
      lines.push(`- ${mark} **${node.id}** (${resolveRole(node.role).title}) — ${node.description}`)
    }
  }
  if (result.filesChanged.length) {
    lines.push('', `Files changed: ${result.filesChanged.join(', ')}`)
  }
  if (verification.ran) {
    lines.push(
      '',
      verification.ok
        ? `Verified with \`${verification.command}\`.`
        : `⚠ \`${verification.command}\` failed — the checks are not passing.`
    )
  }
  for (const node of problems) {
    lines.push('', `⚠ **${node.id}** (${node.role}) ${node.state}: ${node.error ?? 'no detail reported.'}`)
  }
  if (!result.passed) {
    lines.push(
      '',
      result.reworks >= MAX_REWORK
        ? `⚠ Review still failing after ${result.reworks} rework attempt${
            result.reworks === 1 ? '' : 's'
          }: ${result.reviewNotes} — this needs your input.`
        : `⚠ Review did not pass: ${result.reviewNotes}`
    )
  }
  emit({ type: 'delta', runId, text: `${lines.join('\n')}\n` })
}

/** The one-node fallback plan (used only if graph construction somehow fails). */
function soloNode(request: string): TaskNode {
  return {
    id: 't1',
    role: DEFAULT_REWORK_ROLE,
    description: request.trim() || 'Complete the requested work.',
    dependsOn: [],
    state: 'pending',
    attempts: 0
  }
}

/** Builds the rework task the review gate routes back to a specialist. */
function reworkNode(round: number, role: string, reason: string, request: string): TaskNode {
  return {
    id: `rework-${round}`,
    role,
    description:
      `Fix what the review rejected: ${reason} ` +
      `Address it directly and completely; do not restart unrelated work. Original request: ${request.trim()}`,
    dependsOn: [],
    state: 'pending',
    attempts: 0
  }
}

/** The result shape for an aborted run (the engine discards it and unwinds). */
function aborted(complexity: Complexity, tasks: TaskNode[] = []): OrchestratorResult {
  return {
    complexity,
    tasks,
    passed: false,
    reworks: 0,
    reviewNotes: 'Cancelled.',
    usedPlannerLlm: false,
    filesChanged: []
  }
}

/** First non-empty line of a report, clamped — used for one-line message summaries. */
function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}
