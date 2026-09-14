/**
 * The orchestrator — the state machine that turns a work request into a real
 * hierarchical multi-agent run.
 *
 * ```
 * PHASE     → read project memory: which phase of the roadmap is this? (no LLM)
 * AUDIT     → describe the project once: FILEMAP, ARCHITECTURE, CONVENTIONS
 * SPEC      → a short request becomes PROJECT.md, once per project
 * PLAN      → complexity router + planner (≤1 LLM call; SIMPLE spends none)
 * ASSIGN    → build the TaskGraph, announce it, record it on the blackboard
 * APPROVE   → only with "Plan first" on: halt for the user's go-ahead, before a
 *             single file is touched (a reject stops the run, having built nothing)
 * EXECUTE   → the scheduler runs the ready set IN PARALLEL, each node a scoped
 *             specialist agent; every report lands on the blackboard as a Finding
 * INTEGRATE → deterministic gather (no LLM): reports, files, failures
 * VERIFY    → run the project's own checks when it has some and files changed
 * REVIEW    → mandatory verdict: PASS, or FAIL routed back as bounded rework
 * CLOSE     → state, TASKS.md, archive, checkpoint, and the NEXT phase's plan
 *             (and, when the roadmap finishes, the final project audit)
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
 *  - **Memory-first, staged progress.** When a {@link MemoryPort} is supplied the
 *    run is one phase of a roadmap rather than a one-shot: it reads where the work
 *    stands, plans only that phase, and closes it by updating memory instead of
 *    re-deriving the project next turn. Without a port every staged stage is
 *    skipped and the machine behaves exactly as it did before.
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
  Evidence,
  Finding,
  ProviderSettings,
  RunProgress,
  TaskNode,
  WorkflowEvent
} from '../../../shared/types'
import type { ProjectState } from '../../context/projectState'
import { classifyComplexity } from './complexity'
import { describeConstraints, extractConstraints } from './constraints'
import { buildPlan } from './planner'
import { SharedContext } from './sharedContext'
import { TaskGraph, runScheduler, type NodeOutcome } from './taskGraph'
import { resolveRole } from './roles'
import {
  auditProject,
  authorPhasePlan,
  closePhase,
  expandSpec,
  memoryDigest,
  phaseBrief,
  phaseLabel,
  resolvePhase,
  openingNote,
  planningBrief,
  roadmapSummary,
  scanNote,
  type AuditInventory,
  type MemoryPort,
  type PhaseCloseOutcome,
  type ScribeFn
} from './staging'
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
  /**
   * The excerpts this node read (path + line-range + content-sha + bounded text).
   * Carried onto the node's {@link Finding} so a downstream scoped agent inherits
   * the exact text and builds on it instead of re-reading (Principle 3).
   */
  evidence?: Evidence[]
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

/**
 * The plan put to the user for a go-ahead (#2 — the "Plan first" checkpoint). Built
 * from the real task graph, so the bar can never describe a plan other than the one
 * about to run.
 */
export interface PlanProposal {
  /** How the turn was sized. */
  complexity: Complexity
  /** One readable line per task, in the order the plan runs them. */
  steps: string[]
  /** True when a plan document was written this turn (the user can go and read it). */
  wrotePlan: boolean
  /** The phase this plan covers, when the project is running a roadmap. */
  phase?: { n: number; total: number; name: string }
}

/** The user's verdict on a {@link PlanProposal}. */
export type PlanDecision = 'approve' | 'reject'

/** How the checks stood, in the shape the live status row reports (§33). */
const checksOf = (v: VerifyOutcome): RunProgress['checks'] =>
  v.ran ? (v.ok ? 'PASSING' : 'FAILING') : 'UNKNOWN'

/** Everything the orchestrator needs from the engine. */
export interface OrchestratorDeps {
  runId: string
  /** The user's request (their last message) — the top-level task. */
  request: string
  /** Project overview, or '' when the turn gathered no context. */
  overview: string
  settings: ProviderSettings
  /**
   * How big the model already sized this turn. The engine decides it once (it
   * needs the size to pick the reasoning tier before the first call), so supplying
   * it here keeps a turn to ONE sizing decision. Omitted — in tests, and in any
   * caller that has not sized the request — the orchestrator asks for itself.
   */
  complexity?: Complexity
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
  /**
   * Puts the plan to the user and BLOCKS until they decide (#2). Supplied only when
   * "Plan first" is on; omitted, the run builds straight through as it always has.
   * The caller owns showing it and awaiting the click — this module only decides
   * where in the machine the halt belongs (after the plan, before any specialist).
   */
  approvePlan?: (proposal: PlanProposal) => Promise<PlanDecision>
  /** One non-streaming completion, used for the review verdict. */
  judge: (messages: ChatMessage[]) => Promise<string>
  /**
   * The project's persistent memory. Supplying it turns the run into one phase of a
   * roadmap (§12–§13, §25–§27); omitting it keeps the pre-staging behaviour.
   */
  memory?: MemoryPort
  /**
   * One non-streaming completion used to AUTHOR documents (the spec, the phase
   * plan). Deliberately separate from {@link judge} so the two costs stay visible
   * and a test can tell them apart.
   */
  scribe?: ScribeFn
  /** The project's own check commands, named in the plan's verification checklist. */
  verifyCommands?: readonly string[]
  /** What the preview pane is actually showing right now (§23), when known. */
  previewHealth?: () => ProjectState['preview']
  /**
   * The one-time project audit (§3): the file map and the digest ARCHITECTURE.md and
   * CONVENTIONS.md are written from. Injected because walking the project is
   * filesystem work; omitting it skips the AUDIT stage entirely.
   */
  auditInventory?: () => AuditInventory
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
  /**
   * True when the run stopped at the "Plan first" checkpoint because the user did
   * not approve the plan (#2). A decision, not a failure — nothing was built and
   * nothing needs retrying.
   */
  planRejected?: boolean
  /** The phase this run worked on, when the project is running a roadmap (§33). */
  phase?: { n: number; total: number; name: string }
  /** True when that phase closed this turn and the next one was planned (§25). */
  phaseCompleted?: boolean
  /** The phase that comes next, when the roadmap continues. */
  nextPhase?: string
}

/**
 * Runs the full orchestration gate for one work turn. Never throws: a stage that
 * fails is folded into the result and reported to the user, so the engine's
 * `done`/`error` contract is unchanged.
 */
export async function runOrchestrator(deps: OrchestratorDeps): Promise<OrchestratorResult> {
  const { runId, request, overview, settings, emit, signal } = deps

  // ── PLAN ────────────────────────────────────────────────────────────────
  // Size the turn first, then plan. The size is the MODEL's verdict — normally
  // decided once by the engine and handed in; asked for here when it wasn't.
  // SIMPLE never asks the model for a plan — it collapses to one node and goes
  // straight to work.
  emit({ type: 'status', runId, stage: 'planning', message: 'Sizing the work…' })
  const complexity =
    deps.complexity ?? (await classifyComplexity(request, settings, signal, { overview }))
  if (signal.aborted) return aborted(complexity)

  // The explicit scope the user stated in words ("in at most 5 steps", "keep it
  // minimal", "only touch …"). Deterministic and free — read once here and threaded
  // into the roadmap tier, the task cap and the plan document so a stated budget is
  // honoured rather than merely hoped for (Principle 1).
  const constraints = extractConstraints(request)

  // ── PHASE ───────────────────────────────────────────────────────────────
  // Where does the work stand? Read, never re-audit (§1/§9). The roadmap is sized
  // by the complexity RECORDED for this project, so it can't resize between turns —
  // except that an explicit smaller scope this turn can shrink a fresh/first-phase
  // roadmap (see resolvePhase), which is how "keep it minimal" avoids the ceremony.
  const memory = deps.memory
  const phase = memory ? resolvePhase(memory.readState(), complexity, constraints) : null
  // A one-off edit to a project with no roadmap gets none of the staged machinery:
  // no audit, no spec, no plan document. Everything else is a phase of a build.
  const stageable = !!memory && !!phase && (phase.complexity !== 'simple' || !phase.fresh)

  // The turn's first readable line, before anything slow. Everything between here
  // and the plan is an internal document call — nothing streamed, minutes at high
  // reasoning effort — so without this the reply sits empty while the status row
  // repeats a phase label, which reads as a hung app rather than a working one.
  if (stageable && phase) emit({ type: 'delta', runId, text: `${openingNote(phase)}\n` })

  // ── AUDIT (§3) ──────────────────────────────────────────────────────────
  // The one inspection an unfamiliar project is allowed, persisted so it is never
  // repeated: the file map (free — the files describe themselves) plus, once ever,
  // the architecture and conventions. Runs BEFORE the plan, so the plan is written
  // from the audit rather than from a project nobody has looked at.
  if (stageable && memory) {
    // Best-effort by construction: the audit is an optimisation — it stops later
    // reads — so a project it cannot walk, or a document it cannot write, must never
    // be able to fail the work this turn was actually asked to do.
    try {
      const inventory = deps.auditInventory?.()
      const audit = await auditProject({
        inventory,
        memory,
        scribe: deps.scribe,
        signal
      })
      if (audit.wrote.includes('architecture') || audit.wrote.includes('conventions')) {
        emit({ type: 'status', runId, stage: 'planning', message: 'Recorded the project’s architecture.' })
      }
      // Said out loud, not just flashed in the status row: the user asked to be told
      // the repo was read before any code was written. Only ever describes a scan
      // that actually happened — see scanNote.
      const note = scanNote(audit, inventory?.files ?? 0)
      if (note) emit({ type: 'delta', runId, text: `${note}\n` })
    } catch {
      // Nothing recorded: the later stages read the placeholders, exactly as before.
    }
    if (signal.aborted) return aborted(complexity)
  }

  // ── SPEC (§2) ───────────────────────────────────────────────────────────
  // Once per project: a short request becomes the specification a senior team
  // would work from, so no later turn has to guess what is being built.
  if (memory && phase) {
    const spec = await expandSpec({
      request,
      overview,
      complexity: phase.complexity,
      memory,
      scribe: deps.scribe,
      signal
    })
    if (signal.aborted) return aborted(complexity)
    if (spec.wrote) {
      emit({ type: 'status', runId, stage: 'planning', message: 'Wrote the project specification.' })
    }
  }

  emit({
    type: 'status',
    runId,
    stage: 'planning',
    // Not "Planning a medium build…": the size is a routing decision, and labelling
    // the user's request with it says more about Sylor's process than about their
    // work. What the row is for is what is happening now.
    message: complexity === 'simple' ? 'Planning the change…' : 'Planning the work…'
  })
  // plan.md is written only for a real multi-task plan: a one-node plan carries
  // no information the user doesn't already see, and writing it would add a
  // surprise file to every small edit.
  let planMarkdown = ''
  const plan = await buildPlan(request, phase?.complexity ?? complexity, settings, {
    // The phase brief scopes the planner to THIS phase; project memory tells it
    // what already exists so it doesn't plan work that is already done — and the
    // planning brief hands it the specification written moments ago, so the split
    // follows the pages, data and API boundary the spec just decided instead of
    // being inferred a second time from the raw request.
    overview: phase
      ? [phaseBrief(phase), memory ? planningBrief(memory) : '', overview].filter(Boolean).join('\n\n')
      : overview,
    writePlan: (markdown) => {
      planMarkdown = markdown
    },
    signal,
    // An explicit "in at most N steps" hard-caps the task count, and the whole
    // stated scope is restated to the planner as a budget it must not exceed.
    maxTasks: constraints.maxSteps,
    constraintsNote: describeConstraints(constraints),
    // Falling back to one generalist node is a real loss of fidelity, so it is
    // reported rather than hidden — otherwise a failed planner call looks
    // identical to a request that genuinely needed only one task.
    onDegraded: (reason) =>
      emit({
        type: 'status',
        runId,
        stage: 'planning',
        message: `Planning fell back to a single task — ${reason}`
      })
  })
  if (signal.aborted) return aborted(complexity)

  // In staged mode the phase plan REPLACES the planner's thin markdown: same file,
  // but every §14 section, written from recorded memory. Skipped for a single-node
  // simple turn on a project with no roadmap — that is an edit, not a phase.
  const staged =
    stageable &&
    !!memory &&
    !!phase &&
    (plan.tasks.length > 1 || phase.complexity !== 'simple' || !phase.fresh)

  /**
   * §33 — where the whole build stands, for the live status row. Sticky in the UI, so
   * it is sent when it changes rather than on every line: at the start of the phase,
   * and again once the checks have run. A run with no roadmap sends nothing, which is
   * what makes a one-off edit look like an edit.
   */
  const progressOf = (checks?: RunProgress['checks']): RunProgress | undefined => {
    if (!staged || !phase) return undefined
    return {
      phase: { n: phase.spec.n, total: phase.total, name: phase.spec.name },
      ...(checks ? { checks } : {}),
      ...(deps.previewHealth ? { preview: deps.previewHealth() } : {})
    }
  }
  if (staged && memory && phase) {
    // The one-line progress label (§33): which phase of how many, by name.
    emit({
      type: 'status',
      runId,
      stage: 'planning',
      message: phaseLabel(phase),
      progress: progressOf()
    })

    // The plan said out loud (§33) — BEFORE the phase-plan document is authored,
    // not after. plan.md is a file the user has to go and open, and the status row
    // can only carry `Phase 1 of 9`; meanwhile authoring that document is the
    // longest single call of the turn (minutes, at high reasoning effort). Emitting
    // here means the shape of the build — how many phases, what each is for, what
    // this one breaks down into — is readable within seconds of the planner
    // returning, and the wait that follows happens under text the user can read.
    // Derived from the roadmap and the real task graph, so it costs no call and
    // cannot describe a plan other than the one being written.
    emit({ type: 'delta', runId, text: `${roadmapSummary(phase, plan.tasks)}\n` })

    const markdown = await authorPhasePlan({
      phase,
      request,
      tasks: plan.tasks,
      memoryDigest: memoryDigest(memory),
      verifyCommands: deps.verifyCommands,
      constraints,
      scribe: deps.scribe,
      signal,
      // A skeleton plan.md still gets written (the task list and checklist in it
      // are real), but the user is told the judgement sections are placeholders
      // instead of discovering it by opening the file.
      onDegraded: (reason) =>
        emit({
          type: 'status',
          runId,
          stage: 'planning',
          message: `Phase plan written without its detail — ${reason}`
        })
    })
    if (signal.aborted) return aborted(complexity)
    await deps.writePlan(markdown)
    if (signal.aborted) return aborted(complexity)
  } else if (plan.tasks.length > 1 && planMarkdown) {
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
  // The "Plan first" checkpoint (#2). The halt belongs exactly here: the plan is
  // written and announced, and not one file has been touched — so approving costs
  // the user nothing they haven't already seen, and rejecting costs only the
  // planning. A reject is a DECISION, not a failure: nothing is retried, no rework
  // is routed, and the run says plainly that it stopped on purpose.
  if (deps.approvePlan) {
    emit({
      type: 'status',
      runId,
      stage: 'planning',
      message: 'Waiting for your go-ahead on the plan…',
      progress: progressOf()
    })
    const decision = await deps.approvePlan({
      complexity,
      steps: graph.all.map((n) => `${resolveRole(n.role).title}: ${n.description}`),
      wrotePlan: staged || (plan.tasks.length > 1 && !!planMarkdown),
      ...(staged && phase ? { phase: { n: phase.spec.n, total: phase.total, name: phase.spec.name } } : {})
    })
    if (signal.aborted) return aborted(complexity, graph.all)
    if (decision === 'reject') {
      emit({ type: 'status', runId, stage: 'planning', message: 'Plan not approved — nothing was built.' })
      emit({
        type: 'delta',
        runId,
        text:
          '\nI stopped before building anything — you didn’t approve this plan. ' +
          'Tell me what to change about it and I’ll re-plan.\n'
      })
      return {
        complexity,
        tasks: graph.all,
        passed: false,
        reworks: 0,
        reviewNotes: '',
        usedPlannerLlm: plan.usedLlm,
        filesChanged: [],
        planRejected: true,
        ...(staged && phase
          ? { phase: { n: phase.spec.n, total: phase.total, name: phase.spec.name } }
          : {})
      }
    }
  }

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
      message: `Reworking after review (${reworks}/${MAX_REWORK})…`,
      progress: progressOf(checksOf(verification))
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

  // ── CLOSE (§25–§27) ─────────────────────────────────────────────────────
  // The phase's bookkeeping: STATE.md, TASKS.md, the checkpoint, the archive and the
  // NEXT phase's plan. All of it rendered from what actually happened — closing a
  // phase costs no model call — and it is what stops the next turn re-deriving the
  // project.
  let close: PhaseCloseOutcome | null = null
  if (staged && memory && phase) {
    emit({
      type: 'status',
      runId,
      stage: 'verifying',
      message: 'Recording progress…',
      progress: progressOf(checksOf(verification))
    })
    const state = memory.readState()
    close = await closePhase({
      phase,
      request,
      tasks: graph.all,
      filesChanged,
      passed: verdict.pass,
      verify: verification,
      build: verification.ran ? (verification.ok ? 'PASSING' : 'FAILING') : state.build,
      // The orchestrator can't know what the preview pane is showing; whoever owns
      // it reports in, so STATE.md never claims a stale preview is current (§23).
      preview: deps.previewHealth?.() ?? state.preview,
      reviewNotes: verdict.pass ? '' : verdict.reason,
      memory,
      writePlan: deps.writePlan,
      verifyCommands: deps.verifyCommands,
      // Spent only if this close finishes the roadmap: the final audit (§35).
      scribe: deps.scribe,
      signal
    })
    if (close.completed) {
      emit({
        type: 'status',
        runId,
        stage: 'verifying',
        message: close.next
          ? `${phaseLabel(phase)} complete — next: ${close.next.name}.`
          : close.projectComplete
            ? 'Final phase complete — wrote the project audit.'
            : 'Final phase complete.',
        progress: progressOf(checksOf(verification))
      })
    }
  }

  // ── RESPOND ─────────────────────────────────────────────────────────────
  const result: OrchestratorResult = {
    complexity,
    tasks: graph.all,
    passed: verdict.pass,
    reworks,
    reviewNotes: verdict.pass ? '' : verdict.reason,
    usedPlannerLlm: plan.usedLlm,
    filesChanged: [...new Set(filesChanged)],
    // Reported only for a staged run: a one-off edit on a project with no recorded
    // roadmap isn't "phase 1 of 3", and saying so would be noise.
    ...(staged && phase ? { phase: { n: phase.spec.n, total: phase.total, name: phase.spec.name } } : {}),
    ...(close ? { phaseCompleted: close.completed } : {}),
    ...(close?.next ? { nextPhase: close.next.name } : {})
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
        files: run.filesChanged.length ? run.filesChanged : undefined,
        evidence: run.evidence?.length ? run.evidence : undefined
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
    // Serialize the file-writing specialists: only one role that can touch the
    // filesystem runs at a time, so their edits — and their tool cards — appear
    // one after another instead of three interleaving. Read-only roles (reviewer,
    // research, project-analyst) have no 'filesystem' capability and keep
    // overlapping up to MAX_PARALLEL. This lifts `linkOverlappingWriters`'
    // same-file guard up to a per-writer one.
    exclusive: (node) => resolveRole(node.role).capabilities.includes('filesystem'),
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
 * task, a failed check, an exhausted review gate, or a phase that just closed
 * always gets an explicit, honest roll-up.
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
  // Where the roadmap now stands (§33) — the one thing the stream can't have said,
  // because it is only true once the phase is closed and the next one is planned.
  const phaseLine = result.phase
    ? result.phaseCompleted
      ? `✓ **Phase ${result.phase.n} of ${result.phase.total} — ${result.phase.name}** complete` +
        (result.nextPhase ? ` — next: ${result.nextPhase}.` : ' — the roadmap is finished.')
      : `**Phase ${result.phase.n} of ${result.phase.total} — ${result.phase.name}** — still in progress.`
    : ''
  if (!multi && !problems.length && !verifyFailed && result.passed && !phaseLine) return

  const lines: string[] = ['']
  if (phaseLine) lines.push(phaseLine, '')
  if (multi) {
    // No header, and no task ids. "**Team result** (complex, 3 tasks)" led with two
    // things that were about Sylor rather than about the user's project: the header
    // named its own internal machinery, and `complex` is a routing decision the user
    // never asked to see. The count it carried is already sitting in the list below.
    // `t1`/`rework-1` go for the same reason — they appear nowhere else in the app,
    // so what identifies a line to a reader is who did the work and what it was.
    for (const node of graph.all) {
      const mark = node.state === 'completed' ? '✓' : node.state === 'running' ? '·' : '✗'
      lines.push(`- ${mark} **${resolveRole(node.role).title}** — ${node.description}`)
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
    // Same role naming as the bullets, so the two line up by eye — and no repeat of
    // the description, because the bullet above already said what this piece was. The
    // only thing left to add here is why it stopped.
    lines.push(
      '',
      `⚠ **${resolveRole(node.role).title}** — ${node.state}: ${node.error ?? 'no detail reported.'}`
    )
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
