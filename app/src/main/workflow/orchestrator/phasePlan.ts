import type { Complexity, TaskNode } from '../../../shared/types'
import { resolveRole } from './roles'

/**
 * Phase plans — the document that turns a request into an executable phase (§12–§15).
 *
 * Two things live here, both deterministic:
 *
 *  1. **The roadmap.** How many phases the work is divided into, and what each one
 *     is for, sized to the routed complexity — 3 phases for a small change, 5 for a
 *     medium feature, 9 for a full build. Deliberately NOT a fixed number for every
 *     project: a one-file fix does not get a nine-phase ceremony.
 *
 *  2. **The plan renderer.** A phase plan has a mandated section list, and the
 *     skeleton is assembled here so every section is guaranteed present and in
 *     order. The substance of the judgement sections (architecture strategy, UI/UX,
 *     risks, …) is authored by one model call and passed in as `sections`; anything
 *     the model omits is rendered as an explicit "to be determined" line naming what
 *     belongs there, so a thin model can never produce a plan that silently drops a
 *     section. The task list, execution order, and verification checklist are
 *     derived from the REAL task graph rather than asked for.
 *
 * The plan is meant to read like a production prompt: detailed enough that another
 * capable agent could execute the phase without rediscovering the project.
 */

/** One phase of the roadmap. */
export interface PhaseSpec {
  /** 1-based phase number. */
  n: number
  /** Short name, also used for the archive filename. */
  name: string
  /** What finishing this phase means. */
  objective: string
}

/** The 3-phase roadmap for a small change. */
const SMALL_PHASES: readonly Omit<PhaseSpec, 'n'>[] = [
  { name: 'Foundation', objective: 'Put the change in place, wired and running.' },
  { name: 'Core', objective: 'Complete the behaviour the request actually asked for.' },
  { name: 'Verification', objective: 'Prove it works: build, checks, and a look at the result.' }
]

/** The 5-phase roadmap for a medium feature. */
const MEDIUM_PHASES: readonly Omit<PhaseSpec, 'n'>[] = [
  { name: 'Foundation', objective: 'Structure, dependencies and shared pieces the feature needs.' },
  { name: 'Core implementation', objective: 'The primary user flow, working end to end.' },
  { name: 'Data and integration', objective: 'Real data, APIs and state wired through the flow.' },
  { name: 'Edge states and responsive', objective: 'Error, loading and empty states; small screens.' },
  { name: 'Testing and polish', objective: 'Checks pass, the result is verified, rough edges gone.' }
]

/** The 9-phase roadmap for a full production build. */
const LARGE_PHASES: readonly Omit<PhaseSpec, 'n'>[] = [
  { name: 'Discovery and foundation', objective: 'Stack, structure and a project that runs.' },
  { name: 'Design system and shell', objective: 'Tokens, primitives, app shell and navigation.' },
  { name: 'Core pages', objective: 'The primary screens, built on the shell.' },
  { name: 'Data and backend', objective: 'Data model, API and persistence wired to the pages.' },
  { name: 'Advanced features', objective: 'The secondary features that complete the product.' },
  {
    name: 'Responsive, accessibility and edge states',
    objective: 'Every breakpoint, keyboard and screen-reader path, and every empty/error/loading state.'
  },
  { name: 'Testing and debugging', objective: 'Automated checks green and known defects fixed.' },
  { name: 'Performance, SEO and security', objective: 'Fast, discoverable and safe by default.' },
  { name: 'Final polish and audit', objective: 'The full audit, then the last visual and code pass.' }
]

/**
 * The phase roadmap for a routed complexity. A small change gets 3 phases, a medium
 * feature 5, a complex build 9 — the plan's ceremony scales with the work.
 */
export function phaseRoadmap(complexity: Complexity): PhaseSpec[] {
  const base =
    complexity === 'simple' ? SMALL_PHASES : complexity === 'medium' ? MEDIUM_PHASES : LARGE_PHASES
  return base.map((p, i) => ({ n: i + 1, ...p }))
}

/** The phase to work on next, clamped to the roadmap's end. */
export function phaseFor(complexity: Complexity, completed: number): PhaseSpec {
  const road = phaseRoadmap(complexity)
  const idx = Math.min(Math.max(completed, 0), road.length - 1)
  return road[idx]
}

/** True when `completed` phases finish the roadmap for this complexity. */
export function roadmapComplete(complexity: Complexity, completed: number): boolean {
  return completed >= phaseRoadmap(complexity).length
}

// ── The mandated section list ────────────────────────────────────────────────

/** Every section a phase plan can carry, in render order (§14). */
export type PlanSectionId =
  | 'why'
  | 'state'
  | 'architecture'
  | 'requirements'
  | 'assumptions'
  | 'constraints'
  | 'dependencies'
  | 'inspect'
  | 'create'
  | 'modify'
  | 'protect'
  | 'archStrategy'
  | 'uxStrategy'
  | 'dataStrategy'
  | 'implStrategy'
  | 'order'
  | 'tasks'
  | 'components'
  | 'interaction'
  | 'responsive'
  | 'edgeStates'
  | 'security'
  | 'performance'
  | 'testing'
  | 'checklist'
  | 'risks'
  | 'rollback'
  | 'completion'
  | 'nextPhase'

interface SectionSpec {
  id: PlanSectionId
  /** The `## ` heading, fixed so the document shape never drifts. */
  heading: string
  /** What belongs here — doubles as the model's brief and the missing-section note. */
  hint: string
  /** Smallest complexity that still renders this section. */
  min: Complexity
  /** True when the renderer fills it from the task graph, not the model. */
  derived?: boolean
}

/**
 * The mandated sections, in §14's order. `min` scales the document to the work: a
 * one-file fix renders 15 sections, a medium feature 24, a production build all 29.
 * Nothing is ever reordered or dropped above its threshold — that fixed shape is
 * what lets the next session (or another agent) read the plan without a guide.
 */
const PLAN_SECTIONS: readonly SectionSpec[] = [
  {
    id: 'why',
    heading: 'Why this phase exists',
    hint: 'what would be broken or missing without this phase',
    min: 'simple'
  },
  {
    id: 'state',
    heading: 'Current project state',
    hint: 'what already exists and works right now, from memory rather than a fresh audit',
    min: 'simple'
  },
  {
    id: 'architecture',
    heading: 'Existing relevant architecture',
    hint: 'the parts of the current architecture this phase touches',
    min: 'medium'
  },
  {
    id: 'requirements',
    heading: 'Requirements',
    hint: 'what this phase must deliver, as checkable statements',
    min: 'simple'
  },
  {
    id: 'assumptions',
    heading: 'Assumptions',
    hint: 'the professional assumptions being made instead of asking the user',
    min: 'medium'
  },
  {
    id: 'constraints',
    heading: 'Constraints',
    hint: 'stack, compatibility, offline, performance or product limits that bind this phase',
    min: 'simple'
  },
  {
    id: 'dependencies',
    heading: 'Dependencies',
    hint: 'packages, services or earlier phases this one depends on',
    min: 'medium'
  },
  {
    id: 'inspect',
    heading: 'Files to inspect',
    hint: 'the few files worth reading first — and nothing already described in FILEMAP.md',
    min: 'simple'
  },
  { id: 'create', heading: 'Files to create', hint: 'new files, with one line each', min: 'simple' },
  {
    id: 'modify',
    heading: 'Files to modify',
    hint: 'existing files and the change each one needs',
    min: 'simple'
  },
  {
    id: 'protect',
    heading: 'Files that must NOT be modified',
    hint: 'working code this phase must leave alone',
    min: 'simple'
  },
  {
    id: 'archStrategy',
    heading: 'Architecture strategy',
    hint: 'how the new code is structured and why that fits what already exists',
    min: 'medium'
  },
  {
    id: 'uxStrategy',
    heading: 'UI/UX strategy',
    hint: 'layout, hierarchy, visual direction and how it stays consistent with the design system',
    min: 'medium'
  },
  {
    id: 'dataStrategy',
    heading: 'Data strategy',
    hint: 'shapes, sources, state ownership and persistence',
    min: 'medium'
  },
  {
    id: 'implStrategy',
    heading: 'Implementation strategy',
    hint: 'the approach, in the order it will actually be built',
    min: 'simple'
  },
  {
    id: 'order',
    heading: 'Execution order',
    hint: 'the dependency-respecting order of the tasks',
    min: 'simple',
    derived: true
  },
  {
    id: 'tasks',
    heading: 'Detailed tasks',
    hint: 'the task checklist',
    min: 'simple',
    derived: true
  },
  {
    id: 'components',
    heading: 'Component responsibilities',
    hint: 'each component, what it owns, and what it must not own',
    min: 'complex'
  },
  {
    id: 'interaction',
    heading: 'Interaction requirements',
    hint: 'hover, focus, active, keyboard, transitions and feedback',
    min: 'complex'
  },
  {
    id: 'responsive',
    heading: 'Responsive requirements',
    hint: 'what changes at mobile, tablet and desktop widths',
    min: 'complex'
  },
  {
    id: 'edgeStates',
    heading: 'Error, loading and empty states',
    hint: 'every state each surface can be in, and what the user sees',
    min: 'medium'
  },
  {
    id: 'security',
    heading: 'Security considerations',
    hint: 'input validation, authorisation, secret handling and unsafe defaults to avoid',
    min: 'complex'
  },
  {
    id: 'performance',
    heading: 'Performance considerations',
    hint: 'expensive paths, payload size and render cost',
    min: 'complex'
  },
  {
    id: 'testing',
    heading: 'Testing strategy',
    hint: 'what gets a test, at which level, and what is deliberately left untested',
    min: 'medium'
  },
  {
    id: 'checklist',
    heading: 'Verification checklist',
    hint: 'the checks that prove this phase is done',
    min: 'simple',
    derived: true
  },
  {
    id: 'risks',
    heading: 'Risks',
    hint: 'what could go wrong, and the early signal for each',
    min: 'simple'
  },
  {
    id: 'rollback',
    heading: 'Rollback and recovery',
    hint: 'how to get back to a working state if this phase goes wrong',
    min: 'medium'
  },
  {
    id: 'completion',
    heading: 'Completion criteria',
    hint: 'the conditions that make this phase finished — no partial credit',
    min: 'simple'
  },
  {
    id: 'nextPhase',
    heading: 'Next phase prediction',
    hint: 'what the next phase will most likely have to do',
    min: 'simple'
  }
] as const

/** Complexity as an ordered scale, so sizes can be compared, not just matched. */
export const RANK: Record<Complexity, number> = { simple: 0, medium: 1, complex: 2 }

/** The sections a plan at this complexity carries, in render order. */
function sectionsFor(complexity: Complexity): readonly SectionSpec[] {
  return PLAN_SECTIONS.filter((s) => RANK[s.min] <= RANK[complexity])
}

/** The section ids the MODEL is asked to author (everything not derived). */
export function authoredSectionIds(complexity: Complexity): PlanSectionId[] {
  return sectionsFor(complexity)
    .filter((s) => !s.derived)
    .map((s) => s.id)
}

/**
 * The brief handed to the plan-writing call: one `key — what belongs there` line per
 * authored section. Generated from the same registry the renderer uses, so the two
 * can never drift apart.
 */
export function planSectionBrief(complexity: Complexity): string {
  return sectionsFor(complexity)
    .filter((s) => !s.derived)
    .map((s) => `- "${s.id}" — ${s.heading}: ${s.hint}`)
    .join('\n')
}

/** Everything the renderer needs; only `sections` comes from a model. */
export interface PhasePlanInput {
  phase: PhaseSpec
  /** Total phases in the roadmap, so the plan can say "3 of 9". */
  totalPhases: number
  complexity: Complexity
  /** The user's request, verbatim — the highest-level requirement (§32). */
  request: string
  /** The real task graph for this phase. */
  tasks: TaskNode[]
  /** Model-authored bodies keyed by section id; omissions become explicit notes. */
  sections?: Partial<Record<PlanSectionId, string>>
  /** The commands that will actually be run to verify the phase (§34). */
  verifyCommands?: readonly string[]
}

/** Dependency-respecting waves: each wave can run in parallel, waves are ordered. */
function executionWaves(tasks: TaskNode[]): TaskNode[][] {
  const known = new Set(tasks.map((t) => t.id))
  const done = new Set<string>()
  const waves: TaskNode[][] = []
  let rest = tasks
  while (rest.length > 0) {
    const ready = rest.filter((t) => t.dependsOn.every((d) => !known.has(d) || done.has(d)))
    // A cycle is impossible (TaskGraph validates), but never spin: take the rest.
    const wave = ready.length > 0 ? ready : rest
    waves.push(wave)
    for (const t of wave) done.add(t.id)
    const inWave = new Set(wave.map((t) => t.id))
    rest = rest.filter((t) => !inWave.has(t.id))
  }
  return waves
}

/** The execution-order section, derived from the graph. */
function renderOrder(tasks: TaskNode[]): string {
  if (tasks.length === 0) return '_No tasks in this phase._'
  const waves = executionWaves(tasks)
  if (waves.length === 1 && waves[0].length === 1) return `1. **${tasks[0].id}** — ${tasks[0].description}`
  return waves
    .map((wave, i) => {
      const label = wave.length > 1 ? ` (in parallel)` : ''
      const items = wave.map((t) => `**${t.id}** ${t.description}`).join('; ')
      return `${i + 1}. ${items}${label}`
    })
    .join('\n')
}

/**
 * The task checklist. Same `- [ ] **id** (role) description` shape the old renderer
 * used, because the engine's continue-nudge keys on an unchecked box in plan.md.
 */
function renderTasks(tasks: TaskNode[]): string {
  if (tasks.length === 0) return '_No tasks in this phase._'
  return tasks
    .map((t) => {
      const deps = t.dependsOn.length > 0 ? ` _(depends on: ${t.dependsOn.join(', ')})_` : ''
      const files = t.filesHint?.length ? ` — files: ${t.filesHint.join(', ')}` : ''
      return `- [ ] **${t.id}** (${resolveRole(t.role).title}) ${t.description}${deps}${files}`
    })
    .join('\n')
}

/**
 * The verification checklist (§25/§34). Every item is a real check, and the ones
 * that can be named exactly — the project's own scripts — are named.
 *
 * Numbered rather than `- [ ]` on purpose: an unchecked box in plan.md is the
 * engine's "work remains" signal, and these items are verified by running the
 * checks, not by the model ticking them off. Only the task list carries boxes.
 */
function renderChecklist(input: PhasePlanInput): string {
  const items = ['Every task above is complete']
  const cmds = input.verifyCommands ?? []
  if (cmds.length > 0) for (const c of cmds) items.push(`\`${c}\` passes`)
  else items.push("The project's own checks pass (build, typecheck, lint, test — whichever exist)")
  items.push('No unresolved runtime errors')
  items.push('The preview reflects the current code, not a previous build')
  if (RANK[input.complexity] >= RANK.medium) items.push('Error, loading and empty states behave correctly')
  if (RANK[input.complexity] >= RANK.complex) {
    items.push('Layout holds at mobile, tablet and desktop widths')
    items.push('Keyboard and screen-reader paths work')
  }
  items.push('Project memory updated (STATE.md, TASKS.md, and FILEMAP.md if files changed)')
  items.push('This plan archived and the next phase planned')
  return items.map((item, i) => `${i + 1}. ${item}`).join('\n')
}

/** Files the tasks say they will touch — the fallback for the file sections. */
function hintedFiles(tasks: TaskNode[]): string[] {
  const seen = new Set<string>()
  for (const t of tasks) for (const f of t.filesHint ?? []) seen.add(f)
  return [...seen]
}

/** One section's body: derived from the graph, authored by the model, or a named gap. */
function bodyFor(spec: SectionSpec, input: PhasePlanInput): string {
  if (spec.derived) {
    if (spec.id === 'order') return renderOrder(input.tasks)
    if (spec.id === 'tasks') return renderTasks(input.tasks)
    if (spec.id === 'checklist') return renderChecklist(input)
  }
  const authored = input.sections?.[spec.id]?.trim()
  if (authored) return authored

  if (spec.id === 'create' || spec.id === 'modify') {
    const files = hintedFiles(input.tasks)
    if (files.length > 0) {
      return [
        'From the task hints — check which of these already exist before writing:',
        ...files.map((f) => `- \`${f}\``)
      ].join('\n')
    }
  }
  // Never silently drop a mandated section: say what belongs here instead.
  return `_To be determined — ${spec.hint}._`
}

/** The request, quoted and clipped so the plan carries the ask without bloating. */
function quoteRequest(request: string): string {
  const text = request.trim()
  const clipped = text.length > 800 ? `${text.slice(0, 800).trimEnd()}…` : text
  return (clipped || '_(no request text)_')
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join('\n')
}

/**
 * Renders the phase plan (§14). Every mandated section for the routed complexity is
 * present and in order; the task list, execution order and verification checklist
 * come from the real graph; the judgement sections come from `sections`, and each
 * missing one is rendered as an explicit note naming what belongs there.
 */
export function renderPhasePlan(input: PhasePlanInput): string {
  const { phase, totalPhases, complexity } = input
  const out: string[] = [
    `# Plan — Phase ${phase.n} of ${totalPhases}: ${phase.name}`,
    '',
    `**Objective:** ${phase.objective}`,
    '',
    `**Complexity:** ${complexity}`,
    '',
    '## Request',
    '',
    quoteRequest(input.request),
    ''
  ]
  for (const spec of sectionsFor(complexity)) {
    out.push(`## ${spec.heading}`, '', bodyFor(spec, input), '')
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
