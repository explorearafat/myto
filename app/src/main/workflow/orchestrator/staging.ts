import type { ChatMessage, Complexity, TaskNode } from '../../../shared/types'
import type { MemoryDocId } from '../../context/projectMemory'
import type {
  DecisionEntry,
  ProjectState,
  ProjectStatePatch,
  SessionCheckpoint
} from '../../context/projectState'
import { isAbort } from '../resilience'
import {
  describeConstraints,
  phaseCeilingComplexity,
  type PlanConstraints
} from './constraints'
import {
  authoredSectionIds,
  phaseFor,
  phaseRoadmap,
  planSectionBrief,
  RANK,
  renderPhasePlan,
  type PhaseSpec,
  type PlanSectionId
} from './phasePlan'
import { resolveRole } from './roles'

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
 * skipped stage, never to a half-written document or a thrown error. Degrading is
 * not the same as hiding, though: where the fallback still produces a document
 * that *looks* finished (a phase plan whose every judgement section reads "to be
 * determined"), the caller is told through an `onDegraded` callback so the run can
 * say so out loud.
 */

/** The reason to report for a thrown scribe failure, without importing a provider. */
function reasonFor(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.trim().slice(0, 160) || 'the call failed'
}

/** Reads and writes the project's memory documents. Implemented by the engine. */export interface MemoryPort {
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

/**
 * One completion used to author a document.
 *
 * `label` names the work for the live status row. These calls are the longest
 * silent stretches of a staged turn — a 26-section phase plan at high reasoning
 * effort runs for minutes with nothing streamed — so a row that still reads
 * `Phase 1 of 9` throughout one of them is indistinguishable from a hang.
 */
export type ScribeFn = (messages: ChatMessage[], label?: string) => Promise<string>

/** Where the roadmap stands for this run. */
export interface PhaseContext {
  spec: PhaseSpec
  total: number
  /** The complexity the roadmap is sized to (persisted, so it can't grow mid-run). */
  complexity: Complexity
  /** True when this project had no recorded state before this turn. */
  fresh: boolean
}

/**
 * Resolves the phase to work on. The roadmap is sized by the complexity recorded in
 * STATE.md when there is one — a project halfway through a nine-phase build stays a
 * nine-phase build even on a turn whose request would route as simple on its own,
 * because renumbering the phases underneath a plan the user is following is worse
 * than carrying one that's too big.
 *
 * **Once, though, is not forever.** The recorded size used to win unconditionally,
 * so a single bad route (see {@link import('./complexity')}: "a login page" counted
 * as two domains and therefore a nine-phase product) was written to STATE.md and
 * preferred for the life of the project. Every later turn inherited it, which is why
 * the symptom was that Sylor got *worse* over a session rather than settling. So a
 * roadmap that hasn't got past its first phase can still shrink to what this turn
 * actually asked for: nothing has been delivered against it, so there is no
 * numbering for the user to lose. It can only shrink — a bigger route mid-phase is
 * this turn being ambitious, not the project having grown.
 *
 * **Explicit scope shrinks the route first.** When the user states a smaller scope
 * this turn ("keep it minimal", "in at most 5 steps"), {@link phaseCeilingComplexity}
 * caps the routed tier before anything else — shrink-only, and never below medium.
 * It feeds the very same recorded-wins / first-phase-resizable logic, so it can
 * right-size a fresh or barely-started roadmap without ever renumbering a build
 * that's already underway; the precise task count is enforced separately by the
 * planner's cap, and the words are quoted into the plan regardless.
 */
export function resolvePhase(
  state: ProjectState,
  routed: Complexity,
  constraints?: PlanConstraints
): PhaseContext {
  const ceiling = constraints ? phaseCeilingComplexity(constraints) : undefined
  const effectiveRouted =
    ceiling !== undefined && RANK[ceiling] < RANK[routed] ? ceiling : routed
  const recorded = state.complexity
  const resizable =
    recorded !== undefined && state.phase <= 1 && RANK[effectiveRouted] < RANK[recorded]
  const complexity = resizable ? effectiveRouted : (recorded ?? effectiveRouted)
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

/**
 * The first thing the user can read, emitted before any model call that takes time.
 *
 * A staged turn's opening minutes are all internal documents — the audit, the
 * specification, the phase plan — none of which are streamed. Until this existed
 * the reply stayed empty through all of them, so a real build looked like a frozen
 * window with a climbing timer. One line, rendered from the roadmap alone (no call,
 * no latency), saying what is happening.
 *
 * **It used to announce instead of answer** — `On it — a decent-sized build, 5
 * phases. Planning phase 1 (Foundation) now…` — and the user's verdict on that was
 * plain: it reads as ceremony, a system declaring the size of its own process
 * before a single useful thing has been said. So the scale label, the phase count
 * and the bold banner are gone. Nothing is lost by dropping them: the phase list
 * arrives moments later in {@link roadmapSummary}, with each phase's objective and
 * a marker on the one being started — the same facts, where they mean something.
 *
 * What is left is one plain sentence about the work in progress, which is how a
 * person answers before they have the answer.
 *
 * Deliberately promises only what the pipeline guarantees: the plan is read back
 * before any code is written. It does NOT claim the project is being read — on a
 * resumed project the audit is skipped, and a line about work that didn't happen is
 * exactly what {@link scanNote} exists to avoid.
 */
export function openingNote(phase: PhaseContext): string {
  return phase.spec.n === 1
    ? 'Planning this before I write anything — the plan lands here first.\n'
    : `Picking up ${phase.spec.name.toLowerCase()} — planning it before I write anything.\n`
}

/**
 * The plan read back to the user, in the reply itself.
 *
 * The status line can only ever say `Phase 1 of 9`, which tells someone how long the
 * work is without telling them what it is — and plan.md is a file they have to go and
 * open. This is the shape of the build in the conversation: how many phases, what each
 * one is for, and what this phase's plan actually breaks down into.
 *
 * Rendered from the roadmap and the real task graph, so it costs no call and cannot
 * describe a plan other than the one that was written. The full phase list appears on
 * phase 1 (and on the first turn a project gains state, whatever phase that lands on);
 * later phases lead with their own line instead, because by phase 4 the user has seen
 * the list three times and TASKS.md carries it anyway.
 */
export function roadmapSummary(phase: PhaseContext, tasks: readonly TaskNode[]): string {
  const road = phaseRoadmap(phase.complexity)
  const out: string[] = []

  if (phase.spec.n === 1 || phase.fresh) {
    out.push(`**Plan ready — ${road.length} phase${road.length === 1 ? '' : 's'}.**`, '')
    const here = phase.spec.n === 1 ? '← starting here' : '← we are here'
    for (const p of road) {
      out.push(`${p.n}. **${p.name}** — ${p.objective}${p.n === phase.spec.n ? ` ${here}` : ''}`)
    }
  } else {
    out.push(`**Plan ready — ${phaseLabel(phase)}.** ${phase.spec.objective}`)
  }

  if (tasks.length > 0) {
    out.push('', `This phase breaks down into ${tasks.length} task${tasks.length === 1 ? '' : 's'}:`)
    // The role's title, not its id: `backend` is a routing key, "Backend Engineer" is
    // the name the same task carries in its card, its lane and the closing roll-up. It
    // is also the truer label — an unrecognised id is dispatched to the fallback role,
    // so printing the resolved title says who will really do the work.
    for (const t of tasks) out.push(`- **${resolveRole(t.role).title}** — ${t.description}`)
  }

  return `${out.join('\n').trimEnd()}\n`
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
    const raw = await scribe(
      [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      'Reading the project — its architecture and conventions…'
    )
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

/**
 * The scan, said out loud — the two lines a careful engineer opens with: I looked at
 * the repo before touching it, and here is what that told me.
 *
 * Derived entirely from what the audit actually did, which is the point: it can only
 * claim a scan that happened. No inventory (nothing walked), nothing to audit, or a
 * run cancelled mid-scan all return null rather than a reassuring line about work
 * that never took place.
 */
export function scanNote(outcome: AuditOutcome, files: number): string | null {
  if (files <= 0 || outcome.skipped === 'nothing-to-audit' || outcome.skipped === 'aborted') {
    return null
  }
  const learned = outcome.wrote.includes('architecture') || outcome.wrote.includes('conventions')
  return (
    `**Scanned the project before writing anything** — ${files} file${files === 1 ? '' : 's'} mapped` +
    (learned
      ? ', and its architecture and conventions are now on record'
      : ', on top of the architecture and conventions already on record') +
    '.\n' +
    'All set — what follows is written from what is actually in the repo, not from a guess.\n'
  )
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
 * returns immediately, so continuing work never re-derives the spec.
 *
 * Reserved for `complex` work, because that is what it costs. The 20 sections below
 * are one long serial call — "Target users", "Information architecture", "Security,
 * performance and SEO" — that has to finish before the first line of code, and only
 * a genuine multi-domain product build gets that back. It used to skip only
 * `simple`, so an ordinary two-part feature paid for a product spec it would never
 * read again.
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
  if (complexity !== 'complex') return { wrote: false, skipped: 'too-small' }
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
    doc = (
      await scribe(
        [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        'Writing the project specification…'
      )
    ).trim()
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

/**
 * The specification sections a task graph is actually split along.
 *
 * PROJECT.md is written immediately before the planner runs and was then never read
 * on the turn that wrote it: the planner saw the raw request plus the file tree, so
 * the product decisions the spec had just made — which pages exist, what data they
 * need, where the API boundary is — did not reach the split. These are the sections
 * that change how the work divides. The rest of the spec (visual direction, SEO,
 * edge cases) belongs to the phase plan and the specialists, not to the split.
 */
const PLANNING_SECTIONS: readonly string[] = [
  'Objective',
  'Major features',
  'Pages and screens',
  'Component architecture',
  'Data requirements',
  'Backend, API and authentication',
  'Completion criteria'
]

/** Longest slice of any one section handed to the planner. */
const PLANNING_SECTION_CHARS = 500

/**
 * The recorded specification, reduced to what the planner needs, or '' when nothing
 * is recorded yet.
 *
 * Section-selected rather than clipped from the top: a blind prefix of a 20-section
 * spec is Objective and Target users, which is the part the planner could already
 * infer from the request anyway. Deterministic — no model call.
 */
export function planningBrief(memory: MemoryPort): string {
  const spec = memory.readDoc('project')
  if (!spec) return ''
  const parts: string[] = []
  for (const heading of PLANNING_SECTIONS) {
    const body = sectionBody(spec, heading)
    if (body) parts.push(`#### ${heading}\n${clip(body, PLANNING_SECTION_CHARS)}`)
  }
  return parts.length ? `### From the recorded specification\n${parts.join('\n\n')}` : ''
}

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
  /** Explicit user scope for this turn — sizes the section set and is quoted in. */
  constraints?: PlanConstraints
  /**
   * Reports that the plan came out as the bare skeleton — every judgement section
   * an explicit "to be determined" — and why. A hollow plan reads like a finished
   * document, so the one thing it must not be is silent.
   */
  onDegraded?: (reason: string) => void
}): Promise<string> {
  const { phase, request, tasks, memoryDigest, verifyCommands, constraints, scribe, signal, onDegraded } =
    args
  const minimal = !!constraints?.minimal
  const explicitConstraints = constraints ? describeConstraints(constraints) : ''
  const render = (sections?: Partial<Record<PlanSectionId, string>>): string =>
    renderPhasePlan({
      phase: phase.spec,
      totalPhases: phase.total,
      complexity: phase.complexity,
      request,
      tasks,
      sections,
      verifyCommands,
      minimal,
      explicitConstraints
    })

  if (!scribe) return render()

  const ids = authoredSectionIds(phase.complexity, minimal)
  const system =
    "You are Sylor's TECHNICAL ARCHITECT, writing the plan for ONE phase of a build. The plan " +
    'must be detailed enough that another capable agent could execute this phase without ' +
    'exploring the project first. Be specific: name real files, real components, real states. ' +
    'Never plan work outside this phase.\n\n' +
    `Reply with ONLY a JSON object whose keys are these section ids:\n${planSectionBrief(phase.complexity, minimal)}\n\n` +
    'Every value is a markdown string (bullet lists are fine). Omit a key you genuinely have ' +
    'nothing real to say about — an omitted section is marked as undetermined, which is better ' +
    'than an invented one. Under "protect", name working files this phase must not touch.'
  const user =
    (explicitConstraints ? `## Explicit scope (honour exactly)\n${explicitConstraints}\n\n` : '') +
    `## Request\n${request.trim()}\n\n` +
    `## This phase\nPhase ${phase.spec.n} of ${phase.total} — ${phase.spec.name}\nObjective: ${phase.spec.objective}\n\n` +
    `## Tasks already planned for this phase\n${
      tasks.length
        ? tasks.map((t) => `- ${t.id} (${t.role}): ${t.description}`).join('\n')
        : '- none yet'
    }\n\n` +
    (memoryDigest.trim() ? `## What the project already knows\n${memoryDigest.trim()}\n` : '')

  try {
    const raw = await scribe(
      [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      `Writing the plan for phase ${phase.spec.n} — ${phase.spec.name}…`
    )
    if (signal.aborted) return render()
    const sections = parseSections(raw, ids)
    // The model replied but nothing usable came back — the plan would render as
    // 20-odd "to be determined" lines, which looks like a plan and isn't one.
    if (Object.keys(sections).length === 0) {
      onDegraded?.('the architect’s reply carried no usable sections')
    }
    return render(sections)
  } catch (err) {
    if (!isAbort(err)) onDegraded?.(reasonFor(err))
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
      const raw = (
        await scribe(
          [
            { role: 'system', content: system },
            {
              role: 'user',
              content: `## Original request\n${args.request.trim()}\n\n## The record\n${facts}\n`
            }
          ],
          'Writing the final project audit…'
        )
      ).trim()
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
