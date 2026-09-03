import type { ChatMessage, Complexity, TaskNode } from '../../../shared/types'
import type { MemoryDocId } from '../../context/projectMemory'
import type {
  DecisionEntry,
  ProjectState,
  ProjectStatePatch,
  SessionCheckpoint
} from '../../context/projectState'
import {
  authoredSectionIds,
  phaseFor,
  phaseRoadmap,
  planSectionBrief,
  renderPhasePlan,
  type PhaseSpec,
  type PlanSectionId
} from './phasePlan'

/**
 * The staged half of the orchestrator (§2, §3, §14, §25–§27, §35) — the stages that
 * read and write the project's persistent memory rather than dispatching agents.
 *
 * ```
 * AUDIT  → the file map, architecture and conventions, once per project
 * SPEC   → a short request becomes PROJECT.md, once per project
 * PLAN   → the phase plan document, one per phase
 * CLOSE  → state, TASKS.md, archive, checkpoint, and the NEXT phase's plan
 * AUDIT* → the final project audit, once the roadmap finishes
 * ```
 *
 * Everything here is injected, for the same reason the orchestrator is: this module
 * never imports the engine, the filesystem, or a provider. Documents arrive and
 * leave through {@link MemoryPort}; the one place judgement is needed takes a
 * {@link ScribeFn}. That keeps the staged workflow unit-testable with fakes, and it
 * keeps the cost visible — every model call in here is written down in one place.
 *
 * The rule these functions share: **a stage that cannot do its job does nothing.**
 * No port, no scribe, an unparseable answer, an aborted run — each degrades to a
 * skipped stage, never to a half-written document or a thrown error.
 */

/** Reads and writes the project's memory documents. Implemented by the engine. */
export interface MemoryPort {
  /** The parsed STATE.md header. */
  readState: () => ProjectState
  /** Patches the STATE.md header, preserving the agent's prose. */
  writeState: (patch: ProjectStatePatch) => ProjectState
  /** A memory doc's text, or null when it is missing, empty or still a placeholder. */
  readDoc: (id: MemoryDocId) => string | null
  /** Writes a memory doc. Async because the engine's write path is. */
  writeDoc: (id: MemoryDocId, content: string) => Promise<void>
  /** The active plan's text, or null when there is none. */
  readPlan: () => string | null
  /** Files the active plan under `plans/`, ticking the tasks that completed. */
  archivePlan: (phase: number, name: string, completedIds: readonly string[]) => string | null
  /** Appends to the decision log. */
  decide: (entry: DecisionEntry) => void
  /** Writes a session checkpoint (both the dated file and `latest.md`). */
  checkpoint: (cp: SessionCheckpoint) => string | null
}

/** One non-streaming completion used to author a document. */
export type ScribeFn = (messages: ChatMessage[]) => Promise<string>

/** Where the roadmap stands for this run. */
export interface PhaseContext {
  spec: PhaseSpec
  total: number
  /** The complexity the roadmap is sized to (persisted, so it can't resize). */
  complexity: Complexity
  /** True when this project had no recorded state before this turn. */
  fresh: boolean
}

/**
 * Resolves the phase to work on. The roadmap is sized by the complexity recorded in
 * STATE.md when there is one — a project that was sized as a nine-phase build stays
 * a nine-phase build even on a turn whose request would route as simple on its own.
 */
export function resolvePhase(state: ProjectState, routed: Complexity): PhaseContext {
  const complexity = state.complexity ?? routed
  const road = phaseRoadmap(complexity)
  // `state.phase` is the phase in progress; 0 means none has started yet.
  const spec = state.phase > 0 ? (road[state.phase - 1] ?? road[road.length - 1]) : phaseFor(complexity, 0)
  return { spec, total: road.length, complexity, fresh: state.fresh }
}

/** `Phase 3 of 9 — Core pages` — the one-line progress label (§33). */
export function phaseLabel(phase: PhaseContext): string {
  return `Phase ${phase.spec.n} of ${phase.total} — ${phase.spec.name}`
}

/**
 * The phase brief folded into the planner's overview, so the tasks it plans belong
 * to THIS phase and no other. Kept short: the planner already receives the project
 * overview, and the specialists receive project memory in their own prompt.
 */
export function phaseBrief(phase: PhaseContext): string {
  return [
    `## Current phase`,
    phaseLabel(phase),
    `Objective: ${phase.spec.objective}`,
    'Plan ONLY the work that belongs to this phase. Later phases have their own plans.'
  ].join('\n')
}

// ── AUDIT (§3) ───────────────────────────────────────────────────────────────

/** What one audit learned about the project, produced by the engine (no model). */
export interface AuditInventory {
  /** The rendered file map — deterministic, written as-is. */
  filemap: string
  /** The project's shape, as the digest the authoring call works from. */
  digest: string
  /** How many files were described; 0 means there was nothing to audit. */
  files: number
}

/** What {@link auditProject} wrote, for the caller's status line. */
export interface AuditOutcome {
  /** The docs written this turn. */
  wrote: MemoryDocId[]
  /** Why it did nothing, when it did nothing. */
  skipped?: 'already-audited' | 'nothing-to-audit' | 'no-scribe' | 'unusable' | 'aborted'
}

/** The least a written ARCHITECTURE/CONVENTIONS section can be and still be real. */
const MIN_AUDIT_DOC_CHARS = 160

/**
 * §3 — the one targeted audit an unfamiliar project is allowed, persisted so it is
 * never repeated.
 *
 * The file map costs nothing: it is rendered from what the files themselves say, so
 * it is written whenever it is missing — and re-rendered as the project grows,
 * keeping every purpose line anyone has refined (that merge happens in the
 * inventory the engine hands in). ARCHITECTURE.md and CONVENTIONS.md need
 * judgement, so they cost **one** call, together, once per project: the moment both
 * hold real content this stage is a no-op forever.
 *
 * Runs before the plan is written, so the plan is authored from the audit rather
 * than from a project nobody has looked at yet.
 */
export async function auditProject(args: {
  inventory?: AuditInventory
  memory: MemoryPort
  scribe?: ScribeFn
  signal: AbortSignal
}): Promise<AuditOutcome> {
  const { inventory, memory, scribe, signal } = args
  if (!inventory || inventory.files === 0) return { wrote: [], skipped: 'nothing-to-audit' }

  const wrote: MemoryDocId[] = []
  // The file map is free, so "missing" is the only condition it waits on. The
  // engine's inventory already carries forward the lines that were there before.
  if (inventory.filemap.trim()) {
    await memory.writeDoc('filemap', inventory.filemap)
    wrote.push('filemap')
  }
  if (signal.aborted) return { wrote, skipped: 'aborted' }

  const needArchitecture = !memory.readDoc('architecture')
  const needConventions = !memory.readDoc('conventions')
  if (!needArchitecture && !needConventions) {
    return { wrote, skipped: wrote.length ? undefined : 'already-audited' }
  }
  if (!scribe) return { wrote, skipped: 'no-scribe' }

  const system =
    "You are Sylor's PROJECT ANALYST, recording what a codebase IS so nobody has to work it " +
    'out again. You are given every file and what each one is responsible for — read it as the ' +
    'whole project. Describe only what the evidence supports; say "not established" rather than ' +
    'inventing a pattern.\n\n' +
    'Reply with ONLY a JSON object with these keys:\n' +
    '- "architecture": markdown for ARCHITECTURE.md — how this project is ACTUALLY built ' +
    '(structure, frontend, backend, data flow, state, routing, API, auth, key modules and how ' +
    'they relate). Use `## ` headings.\n' +
    '- "conventions": markdown for CONVENTIONS.md — the patterns new code in THIS project must ' +
    'match (naming, file layout, components, styling, state, data fetching, error handling, ' +
    'testing). Use `## ` headings.\n\n' +
    'Be concrete and name real files. No preamble, no commentary outside the JSON.'
  const user = `## The project\n${inventory.digest.trim()}\n`

  let parsed: { architecture?: unknown; conventions?: unknown }
  try {
    const raw = await scribe([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ])
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end <= start) return { wrote, skipped: 'unusable' }
    parsed = JSON.parse(raw.slice(start, end + 1)) as { architecture?: unknown; conventions?: unknown }
  } catch {
    return { wrote, skipped: 'unusable' }
  }
  if (signal.aborted) return { wrote, skipped: 'aborted' }

  // A thin answer is not written: a wrong ARCHITECTURE.md would be re-read as truth
  // on every later turn, which is worse than the honest placeholder.
  const candidates: [MemoryDocId, boolean, unknown][] = [
    ['architecture', needArchitecture, parsed.architecture],
    ['conventions', needConventions, parsed.conventions]
  ]
  for (const [id, needed, value] of candidates) {
    if (!needed || typeof value !== 'string') continue
    const body = value.trim()
    if (body.length < MIN_AUDIT_DOC_CHARS) continue
    await memory.writeDoc(id, body.endsWith('\n') ? body : `${body}\n`)
    wrote.push(id)
  }
  return { wrote }
}

// ── SPEC (§2) ────────────────────────────────────────────────────────────────

/**
 * The headings PROJECT.md carries (§2/§6). Sent to the scribe as the required shape
 * and used to sanity-check what comes back, so a spec is either substantially
 * complete or not written at all.
 */
const SPEC_SECTIONS: readonly string[] = [
  'Objective',
  'Target users',
  'Product requirements',
  'Major features',
  'Pages and screens',
  'User flows',
  'Information architecture',
  'Component architecture',
  'Data requirements',
  'Backend, API and authentication',
  'Responsive and accessibility',
  'Error, loading and empty states',
  'Security, performance and SEO',
  'Visual and interaction direction',
  'Testing and deployment',
  'Edge cases',
  'Dependencies and technical risks',
  'Assumptions',
  'Constraints',
  'Completion criteria'
]

/** The text under a `## Heading`, up to the next heading of the same level. */
function sectionBody(doc: string, heading: string): string {
  const re = new RegExp(`^##[ \\t]*${heading}[ \\t]*$([\\s\\S]*?)(?=^##[ \\t]|$(?![\\s\\S]))`, 'im')
  return re.exec(doc)?.[1]?.trim() ?? ''
}

/** How many of the required headings a returned spec actually has. */
function specCoverage(doc: string): number {
  return SPEC_SECTIONS.filter((h) => new RegExp(`^##[ \\t]*${h}[ \\t]*$`, 'im').test(doc)).length
}

/** What {@link expandSpec} did, for the caller's status line and result. */
export interface SpecOutcome {
  /** True when PROJECT.md was written this turn. */
  wrote: boolean
  /** Why it was skipped, when it was. */
  skipped?: 'already-written' | 'no-scribe' | 'too-small' | 'unusable' | 'aborted'
}

/**
 * §2 — turns a short request into a production specification in PROJECT.md.
 *
 * Runs at most **once per project**: the moment PROJECT.md holds real content this
 * returns immediately, so continuing work never re-derives the spec. Skipped for a
 * simple change, which is a request to edit something, not to design a product.
 *
 * The assumptions the spec had to make are recorded in the decision log, because
 * they are the professional judgements the user did not get asked about (§2/§11).
 */
export async function expandSpec(args: {
  request: string
  overview: string
  complexity: Complexity
  memory: MemoryPort
  scribe?: ScribeFn
  signal: AbortSignal
}): Promise<SpecOutcome> {
  const { request, overview, complexity, memory, scribe, signal } = args
  if (complexity === 'simple') return { wrote: false, skipped: 'too-small' }
  if (memory.readDoc('project')) return { wrote: false, skipped: 'already-written' }
  if (!scribe) return { wrote: false, skipped: 'no-scribe' }

  const system =
    "You are Sylor's PRODUCT ARCHITECT. Expand the user's request into the specification a " +
    'senior team would work from. Make professional decisions instead of asking questions, and ' +
    'record every judgement you had to make under "Assumptions". Never change what the user ' +
    'actually asked for — you are filling in detail, not redirecting the product.\n\n' +
    'Reply with GitHub-flavoured markdown only: a `# ` title, then exactly these sections, in ' +
    `order, each as \`## \`:\n${SPEC_SECTIONS.map((h) => `## ${h}`).join('\n')}\n\n` +
    'Be concrete and specific. No preamble, no closing commentary, no code fences around the ' +
    'document.'
  const user =
    `## Request\n${request.trim()}\n\n` +
    (overview.trim() ? `## What already exists\n${overview.trim()}\n` : '## What already exists\nNothing — this is a new build.\n')

  let doc = ''
  try {
    doc = (await scribe([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ])).trim()
  } catch {
    return { wrote: false, skipped: 'unusable' }
  }
  if (signal.aborted) return { wrote: false, skipped: 'aborted' }

  // A thin or off-format answer is not written: a bad PROJECT.md would be re-read as
  // truth on every later turn, which is worse than not having one.
  doc = doc.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()
  if (doc.length < 400 || specCoverage(doc) < Math.ceil(SPEC_SECTIONS.length / 2)) {
    return { wrote: false, skipped: 'unusable' }
  }

  await memory.writeDoc('project', doc.endsWith('\n') ? doc : `${doc}\n`)
  const assumptions = sectionBody(doc, 'Assumptions')
  if (assumptions) {
    memory.decide({
      decision: 'Inferred the production specification from a short request',
      reason: assumptions.slice(0, 1200),
      alternatives: 'Asking the user for a full brief before starting',
      consequence: 'These assumptions are the project baseline — correct PROJECT.md if any is wrong.'
    })
  }
  return { wrote: true }
}

// ── PLAN (§13–§15) ───────────────────────────────────────────────────────────

/** Coerces one JSON value into a markdown section body, or '' when unusable. */
function asBody(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    return items.map((v) => (v.trim().startsWith('-') ? v.trim() : `- ${v.trim()}`)).join('\n')
  }
  return ''
}

/** Pulls the `{ sectionId: body }` object out of a scribe reply. Never throws. */
function parseSections(raw: string, allowed: readonly PlanSectionId[]): Partial<Record<PlanSectionId, string>> {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return {}
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return {}
  }
  const out: Partial<Record<PlanSectionId, string>> = {}
  for (const id of allowed) {
    const body = asBody(obj[id])
    if (body) out[id] = body
  }
  return out
}

/**
 * §13–§15 — writes the plan for one phase. The skeleton is always rendered, so the
 * document exists even with no provider; the judgement sections are authored by one
 * call, and anything the model omits stays an explicit gap rather than a silent one.
 */
export async function authorPhasePlan(args: {
  phase: PhaseContext
  request: string
  tasks: TaskNode[]
  /** What project memory already says — so the plan doesn't re-derive it. */
  memoryDigest: string
  verifyCommands?: readonly string[]
  scribe?: ScribeFn
  signal: AbortSignal
}): Promise<string> {
  const { phase, request, tasks, memoryDigest, verifyCommands, scribe, signal } = args
  const render = (sections?: Partial<Record<PlanSectionId, string>>): string =>
    renderPhasePlan({
      phase: phase.spec,
      totalPhases: phase.total,
      complexity: phase.complexity,
      request,
      tasks,
      sections,
      verifyCommands
    })

  if (!scribe) return render()

  const ids = authoredSectionIds(phase.complexity)
  const system =
    "You are Sylor's TECHNICAL ARCHITECT, writing the plan for ONE phase of a build. The plan " +
    'must be detailed enough that another capable agent could execute this phase without ' +
    'exploring the project first. Be specific: name real files, real components, real states. ' +
    'Never plan work outside this phase.\n\n' +
    `Reply with ONLY a JSON object whose keys are these section ids:\n${planSectionBrief(phase.complexity)}\n\n` +
    'Every value is a markdown string (bullet lists are fine). Omit a key you genuinely have ' +
    'nothing real to say about — an omitted section is marked as undetermined, which is better ' +
    'than an invented one. Under "protect", name working files this phase must not touch.'
  const user =
    `## Request\n${request.trim()}\n\n` +
    `## This phase\nPhase ${phase.spec.n} of ${phase.total} — ${phase.spec.name}\nObjective: ${phase.spec.objective}\n\n` +
    `## Tasks already planned for this phase\n${
      tasks.length
        ? tasks.map((t) => `- ${t.id} (${t.role}): ${t.description}`).join('\n')
        : '- none yet'
    }\n\n` +
    (memoryDigest.trim() ? `## What the project already knows\n${memoryDigest.trim()}\n` : '')

  try {
    const raw = await scribe([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ])
    if (signal.aborted) return render()
    return render(parseSections(raw, ids))
  } catch {
    return render()
  }
}

// ── CLOSE (§10, §25–§27) ─────────────────────────────────────────────────────

/** `[x]` done, `[~]` in progress, `[!]` blocked, `[ ]` pending (§10). */
function box(state: TaskNode['state']): string {
  if (state === 'completed') return '[x]'
  if (state === 'running') return '[~]'
  if (state === 'failed' || state === 'blocked') return '[!]'
  return '[ ]'
}

/**
 * §10 — TASKS.md, rendered from the roadmap and the real task states. Deterministic
 * on purpose: the checklist is bookkeeping, and bookkeeping should not cost a call
 * or be able to drift from what actually happened.
 */
export function renderTasksDoc(args: {
  phase: PhaseContext
  tasks: TaskNode[]
  /** True when the current phase closed this turn. */
  phaseDone: boolean
}): string {
  const { phase, tasks, phaseDone } = args
  const out: string[] = ['# Tasks', '']
  for (const p of phaseRoadmap(phase.complexity)) {
    const mark = p.n < phase.spec.n || (p.n === phase.spec.n && phaseDone) ? '[x]' : p.n === phase.spec.n ? '[~]' : '[ ]'
    out.push(`## Phase ${p.n} — ${p.name}`, '', `- ${mark} ${p.objective}`)
    if (p.n === phase.spec.n && tasks.length > 0) {
      for (const t of tasks) out.push(`  - ${box(t.state)} **${t.id}** ${t.description}`)
    }
    out.push('')
  }
  return `${out.join('\n').trimEnd()}\n`
}

/** What closing the phase did. */
export interface PhaseCloseOutcome {
  /** True when the phase actually completed and was archived. */
  completed: boolean
  /** Where the finished plan was filed, when it was. */
  archived: string | null
  /** The phase that comes next, or null when the roadmap is finished. */
  next: PhaseSpec | null
  /** True when the next phase's plan was written this turn (§26). */
  nextPlanWritten: boolean
  /** The checkpoint path, when one was written (§27). */
  checkpoint: string | null
  /** True when this close finished the roadmap and wrote the final audit (§35). */
  projectComplete?: boolean
}

/**
 * §25–§27 — everything that happens after the work of a phase is done.
 *
 * Always: STATE.md and TASKS.md are brought in line with what actually happened, and
 * a session checkpoint is written so a session that ends here resumes from a document
 * instead of a fresh audit.
 *
 * Only when the phase genuinely closed — the review passed, every task completed, and
 * the project's own checks are not failing — the plan is archived, the phase pointer
 * advances, and the NEXT phase's plan is written from the state that now exists (§26).
 * A phase that is merely "further along" keeps its plan and its number.
 *
 * Costs nothing: every document here is rendered from what happened, so closing a
 * phase is bookkeeping rather than another round of judgement. The one exception is
 * the turn that finishes the roadmap, which spends a single call on the final audit
 * (§35) — the last thing that happens to a project, once.
 */
export async function closePhase(args: {
  phase: PhaseContext
  request: string
  tasks: TaskNode[]
  filesChanged: readonly string[]
  passed: boolean
  verify: { ran: boolean; ok: boolean; command?: string }
  build: ProjectState['build']
  preview: ProjectState['preview']
  reviewNotes: string
  memory: MemoryPort
  writePlan: (markdown: string) => Promise<void>
  verifyCommands?: readonly string[]
  /** Used for the final audit only, when this close finishes the roadmap (§35). */
  scribe?: ScribeFn
  signal: AbortSignal
}): Promise<PhaseCloseOutcome> {
  const { phase, request, tasks, filesChanged, passed, verify, memory, signal } = args
  const problems = tasks.filter((t) => t.state !== 'completed')
  const done = passed && problems.length === 0 && !(verify.ran && !verify.ok) && tasks.length > 0

  memory.writeState({
    phase: phase.spec.n,
    phaseName: phase.spec.name,
    status: done ? 'complete' : problems.length > 0 ? 'blocked' : 'in progress',
    build: args.build,
    preview: args.preview,
    complexity: phase.complexity
  })
  await memory.writeDoc('tasks', renderTasksDoc({ phase, tasks, phaseDone: done }))

  const checkpoint = memory.checkpoint({
    objective: `Phase ${phase.spec.n} of ${phase.total} — ${phase.spec.name}: ${phase.spec.objective}`,
    completed: tasks
      .filter((t) => t.state === 'completed')
      .map((t) => `- ${t.id}: ${t.description}`)
      .join('\n'),
    inProgress: done ? '' : problems.map((t) => `- ${t.id} (${t.state}): ${t.description}`).join('\n'),
    nextAction: done
      ? `Start phase ${phase.spec.n + 1}${phase.spec.n < phase.total ? '' : ' — or run the final audit'}.`
      : args.reviewNotes || 'Finish the outstanding tasks above.',
    filesChanged: [...filesChanged],
    errors: verify.ran && !verify.ok ? `${verify.command ?? 'checks'} failed.` : '',
    decisions: '',
    doNotRediscover:
      'The stack, architecture and file responsibilities are recorded in this project’s memory ' +
      'documents — read STATE.md, TASKS.md and FILEMAP.md instead of re-auditing the project.'
  })

  if (!done || signal.aborted) return { completed: false, archived: null, next: null, nextPlanWritten: false, checkpoint }

  const archived = memory.archivePlan(phase.spec.n, phase.spec.name, tasks.map((t) => t.id))
  const road = phaseRoadmap(phase.complexity)
  const next = road[phase.spec.n] ?? null
  if (!next) {
    // §35 — the roadmap is finished, so the last thing that happens is an audit of
    // the whole project against the specification it was built from. Best-effort: a
    // phase that closed cleanly stays closed even if the report cannot be written.
    const projectComplete = await finalAudit({
      phase,
      request,
      filesChanged,
      verify,
      build: args.build,
      preview: args.preview,
      memory,
      scribe: args.scribe,
      signal
    }).catch(() => false)
    return { completed: true, archived, next: null, nextPlanWritten: false, checkpoint, projectComplete }
  }

  memory.writeState({ phase: next.n, phaseName: next.name, status: 'in progress' })
  let nextPlanWritten = false
  try {
    // Rendered, not authored — no model call. The judgement sections are written at the
    // START of the next turn, when the real task graph for the phase exists; authoring
    // them here would spend a call on a document that is always overwritten before
    // anyone acts on it. What has to happen now is that plan.md stops describing
    // finished work and starts describing what comes next, from the state that actually
    // exists — which is exactly what the post-phase analysis carries (§13/§26/§36).
    const markdown = renderPhasePlan({
      phase: next,
      totalPhases: phase.total,
      complexity: phase.complexity,
      request,
      tasks: [],
      sections: { state: digestForNextPhase(memory, tasks, filesChanged) },
      verifyCommands: args.verifyCommands
    })
    if (!signal.aborted) {
      await args.writePlan(markdown)
      nextPlanWritten = true
    }
  } catch {
    // A plan we couldn't write is not a failed phase: the phase is closed either
    // way, and the next turn will plan again from the state we just recorded.
    nextPlanWritten = false
  }
  return { completed: true, archived, next, nextPlanWritten, checkpoint }
}

// ── FINAL AUDIT (§35) ────────────────────────────────────────────────────────

/** The roadmap, health and criteria the final audit is judged against. */
function auditFacts(args: {
  phase: PhaseContext
  filesChanged: readonly string[]
  verify: { ran: boolean; ok: boolean; command?: string }
  build: ProjectState['build']
  preview: ProjectState['preview']
  memory: MemoryPort
}): string {
  const { phase, filesChanged, verify, memory } = args
  const criteria = sectionBody(memory.readDoc('project') ?? '', 'Completion criteria')
  return [
    `Roadmap: all ${phase.total} phases of a ${phase.complexity} build are complete.`,
    phaseRoadmap(phase.complexity)
      .map((p) => `- Phase ${p.n} — ${p.name}: ${p.objective}`)
      .join('\n'),
    `Build: ${args.build}. Preview: ${args.preview}.`,
    verify.ran
      ? `Last checks: \`${verify.command ?? 'checks'}\` ${verify.ok ? 'passed' : 'FAILED'}.`
      : 'Last checks: none ran on the final phase.',
    filesChanged.length ? `Files touched in the final phase: ${[...new Set(filesChanged)].join(', ')}.` : '',
    criteria ? `Completion criteria (from the specification):\n${criteria}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * §34/§35 — the deterministic audit, used when there is no provider. It reports only
 * what is on the record: the phases that closed and the health of the last checks. It
 * deliberately does NOT declare the product finished, because nothing here verified
 * that; an unverified build says so in as many words.
 */
function renderFinalAudit(facts: string, verified: boolean): string {
  return [
    '# Final project audit',
    '',
    verified
      ? 'Every phase of the roadmap closed and the project’s own checks passed on the last run.'
      : 'Every phase of the roadmap closed, but the project’s own checks did not pass on the last ' +
        'run — treat the result as unverified until they do.',
    '',
    '## What was built',
    '',
    facts,
    '',
    '## Still to confirm',
    '',
    verified
      ? '- Nothing on the record. Re-run the checks after any further change.'
      : '- Get the project’s checks passing, then re-run this audit.',
    ''
  ].join('\n')
}

/**
 * §35 — the audit that closes a project: the whole thing judged against the
 * specification it was built from, written to AUDIT.md and left there.
 *
 * Runs once, on the turn the last phase closes. With a provider it is one call, given
 * the recorded facts (never a fresh exploration); without one it degrades to the
 * deterministic report above. Either way it records the state of the checks rather
 * than claiming success (§34) — an audit that congratulated an unverified build would
 * be the exact failure §34 exists to prevent.
 *
 * Returns true when AUDIT.md was written.
 */
async function finalAudit(args: {
  phase: PhaseContext
  request: string
  filesChanged: readonly string[]
  verify: { ran: boolean; ok: boolean; command?: string }
  build: ProjectState['build']
  preview: ProjectState['preview']
  memory: MemoryPort
  scribe?: ScribeFn
  signal: AbortSignal
}): Promise<boolean> {
  const { memory, scribe, signal } = args
  if (memory.readDoc('audit')) return false // already audited; never twice
  const facts = auditFacts(args)
  const verified = args.build !== 'FAILING' && !(args.verify.ran && !args.verify.ok)

  let doc = renderFinalAudit(facts, verified)
  if (scribe) {
    const system =
      "You are Sylor's AUDITOR, writing the closing report on a finished build. Judge the project " +
      'against its completion criteria using ONLY the record you are given — never claim something ' +
      'was verified when the record does not say it was (an unverified build must be reported as ' +
      'unverified).\n\n' +
      'Reply with markdown only, starting `# Final project audit`, with these sections as `## `: ' +
      'What was built, Against the completion criteria, Verification status, Known gaps, ' +
      'Recommended next steps. Be specific and short — this is a record, not a pitch.'
    try {
      const raw = (await scribe([
        { role: 'system', content: system },
        { role: 'user', content: `## Original request\n${args.request.trim()}\n\n## The record\n${facts}\n` }
      ])).trim()
      const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()
      if (cleaned.length >= 200) doc = cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`
    } catch {
      // Keep the deterministic report: a project that finished still gets its audit.
    }
  }
  if (signal.aborted) return false

  try {
    await memory.writeDoc('audit', doc)
  } catch {
    return false
  }
  memory.writeState({ status: verified ? 'complete' : 'blocked', build: args.build, preview: args.preview })
  return true
}

/** The post-phase analysis the next plan is written from (§26) — no model call. */
function digestForNextPhase(
  memory: MemoryPort,
  tasks: TaskNode[],
  filesChanged: readonly string[]
): string {
  return [
    `Just finished: ${tasks.map((t) => t.description).join('; ') || 'no tasks'}.`,
    filesChanged.length ? `Files now in place: ${[...new Set(filesChanged)].join(', ')}.` : '',
    memoryDigest(memory)
  ]
    .filter(Boolean)
    .join('\n')
}

/** Clips a recorded document so a digest can carry it without flooding the prompt. */
function clip(text: string, budget: number): string {
  return text.length <= budget ? text : `${text.slice(0, budget)}\n…`
}

/**
 * What the project already knows, as one block for the plan-writing call (§29).
 *
 * This is the anti-rediscovery move in its smallest form: the plan is written FROM
 * recorded memory, so the planning call never has to go looking for the stack, the
 * architecture, or what each file is for. Deterministic — no model, no filesystem
 * beyond the port.
 */
export function memoryDigest(memory: MemoryPort, budget = 1200): string {
  const state = memory.readState()
  const parts = [
    `Recorded state — phase ${state.phase || '—'}${state.phaseName ? ` (${state.phaseName})` : ''}, ` +
      `${state.status}. Build: ${state.build}. Preview: ${state.preview}.`
  ]
  const docs: [string, MemoryDocId][] = [
    ['Specification', 'project'],
    ['Architecture', 'architecture'],
    ['File responsibilities', 'filemap'],
    ['Conventions', 'conventions']
  ]
  for (const [label, id] of docs) {
    const body = memory.readDoc(id)
    if (body) parts.push(`${label} (recorded):\n${clip(body, budget)}`)
  }
  return parts.join('\n\n')
}
