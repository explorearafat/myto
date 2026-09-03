import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, Complexity, TaskNode } from '@shared/types'
import type { MemoryDocId } from '@main/context/projectMemory'
import type { DecisionEntry, ProjectState, SessionCheckpoint } from '@main/context/projectState'
import {
  auditProject,
  authorPhasePlan,
  closePhase,
  expandSpec,
  renderTasksDoc,
  resolvePhase,
  type AuditInventory,
  type MemoryPort,
  type PhaseContext
} from '@main/workflow/orchestrator/staging'
import { phaseRoadmap } from '@main/workflow/orchestrator/phasePlan'

/**
 * The staged workflow is pure by design — every document and every model call comes
 * in through a port — so these tests run it against fakes and assert on what it
 * WROTE rather than on any real file. That is the point of the seam: the SPEC/PLAN/
 * CLOSE stages are exercised offline, with no provider and no filesystem.
 */

/** A recording MemoryPort. `docs` doubles as the store and the assertion target. */
function fakeMemory(initial: Partial<Record<MemoryDocId, string>> = {}, state?: Partial<ProjectState>) {
  const docs = new Map<MemoryDocId, string>(Object.entries(initial) as [MemoryDocId, string][])
  let current: ProjectState = {
    phase: 0,
    phaseName: '',
    status: 'not started',
    build: 'UNKNOWN',
    preview: 'UNKNOWN',
    fresh: true,
    ...state
  }
  const patches: Parameters<MemoryPort['writeState']>[0][] = []
  const decisions: DecisionEntry[] = []
  const checkpoints: SessionCheckpoint[] = []
  const archived: { phase: number; name: string; ids: readonly string[] }[] = []
  const port: MemoryPort = {
    readState: () => current,
    writeState: (patch) => {
      patches.push(patch)
      current = { ...current, ...patch, fresh: false }
      return current
    },
    readDoc: (id) => docs.get(id) ?? null,
    writeDoc: async (id, content) => void docs.set(id, content),
    readPlan: () => docs.get('tasks') ?? null,
    archivePlan: (phase, name, ids) => {
      archived.push({ phase, name, ids })
      return `.sylor/plans/phase-0${phase}-x.md`
    },
    decide: (entry) => void decisions.push(entry),
    checkpoint: (cp) => {
      checkpoints.push(cp)
      return '.sylor/sessions/latest.md'
    }
  }
  return { port, docs, patches, decisions, checkpoints, archived }
}

const task = (id: string, overrides: Partial<TaskNode> = {}): TaskNode => ({
  id,
  role: 'builder',
  description: `do ${id}`,
  dependsOn: [],
  state: 'completed',
  attempts: 1,
  ...overrides
})

const ctx = (complexity: Complexity, n = 1): PhaseContext => {
  const road = phaseRoadmap(complexity)
  return { spec: road[n - 1], total: road.length, complexity, fresh: false }
}

const live = new AbortController().signal
const dead = ((): AbortSignal => {
  const c = new AbortController()
  c.abort()
  return c.signal
})()

/** A scribe that always answers `reply`, and records what it was asked. */
function fakeScribe(reply: string) {
  const calls: ChatMessage[][] = []
  const fn = vi.fn(async (messages: ChatMessage[]) => {
    calls.push(messages)
    return reply
  })
  return { fn, calls }
}

describe('resolvePhase', () => {
  it('starts a fresh project at phase 1 of the routed roadmap', () => {
    const { port } = fakeMemory()
    const phase = resolvePhase(port.readState(), 'complex')
    expect(phase).toMatchObject({ total: 9, complexity: 'complex', fresh: true })
    expect(phase.spec.n).toBe(1)
    expect(phase.spec.name).toBe('Discovery and foundation')
  })

  it('keeps the roadmap the size it was sized to, whatever this turn routed as', () => {
    const { port } = fakeMemory({}, { phase: 3, complexity: 'complex', fresh: false })
    // The request on THIS turn ("keep going") would route as simple on its own.
    const phase = resolvePhase(port.readState(), 'simple')
    expect(phase.total).toBe(9)
    expect(phase.complexity).toBe('complex')
    expect(phase.spec.n).toBe(3)
    expect(phase.spec.name).toBe('Core pages')
  })

  it('clamps a phase number past the end of the roadmap to the last phase', () => {
    const { port } = fakeMemory({}, { phase: 42, complexity: 'simple', fresh: false })
    const phase = resolvePhase(port.readState(), 'simple')
    expect(phase.spec.n).toBe(3)
    expect(phase.spec.name).toBe('Verification')
  })
})

// ── AUDIT ────────────────────────────────────────────────────────────────────

/** An inventory as the engine would hand one in: a rendered map plus a digest. */
const inventory = (over: Partial<AuditInventory> = {}): AuditInventory => ({
  filemap: '<!-- sylor:filemap -->\n# File map\n\n- `src/app.ts` — Boots the app.\n',
  digest: 'Package: portal\n\nFiles (1 of 1) —\n- src/app.ts — Boots the app.',
  files: 1,
  ...over
})

/** A long-enough section: the audit refuses to write a thin one. */
const body = (what: string): string =>
  `## ${what}\n\n${`Real detail about ${what}, naming src/app.ts and how it relates to the rest. `.repeat(3)}`

describe('auditProject', () => {
  it('writes the file map with no model call', async () => {
    const mem = fakeMemory({ architecture: 'known', conventions: 'known' })
    const scribe = fakeScribe('{}')
    const out = await auditProject({ inventory: inventory(), memory: mem.port, scribe: scribe.fn, signal: live })

    expect(out.wrote).toEqual(['filemap'])
    expect(mem.docs.get('filemap')).toContain('- `src/app.ts` — Boots the app.')
    // §7 — the map is derived from the files themselves, so it is free.
    expect(scribe.fn).not.toHaveBeenCalled()
  })

  it('spends exactly one call on ARCHITECTURE and CONVENTIONS together', async () => {
    const mem = fakeMemory()
    const scribe = fakeScribe(
      JSON.stringify({ architecture: body('Structure'), conventions: body('Naming') })
    )
    const out = await auditProject({ inventory: inventory(), memory: mem.port, scribe: scribe.fn, signal: live })

    expect(out.wrote).toEqual(['filemap', 'architecture', 'conventions'])
    expect(scribe.fn).toHaveBeenCalledTimes(1)
    expect(String(scribe.calls[0][0].content)).toContain('PROJECT ANALYST')
    // The analyst is given the audited project, not asked to go and look at it.
    expect(String(scribe.calls[0][1].content)).toContain('- src/app.ts — Boots the app.')
    expect(mem.docs.get('architecture')).toContain('## Structure')
    expect(mem.docs.get('conventions')).toContain('## Naming')
  })

  it('leaves a document that already exists alone', async () => {
    const mem = fakeMemory({ architecture: '# Architecture\n\nHand-written and correct.\n' })
    const scribe = fakeScribe(
      JSON.stringify({ architecture: body('Overwritten'), conventions: body('Naming') })
    )
    const out = await auditProject({ inventory: inventory(), memory: mem.port, scribe: scribe.fn, signal: live })

    expect(out.wrote).toEqual(['filemap', 'conventions'])
    expect(mem.docs.get('architecture')).toBe('# Architecture\n\nHand-written and correct.\n')
  })

  it('is a no-op once the project has been audited', async () => {
    const mem = fakeMemory({
      filemap: 'kept',
      architecture: 'known',
      conventions: 'known'
    })
    const scribe = fakeScribe('{}')
    const out = await auditProject({
      inventory: inventory({ filemap: '' }),
      memory: mem.port,
      scribe: scribe.fn,
      signal: live
    })

    expect(out).toEqual({ wrote: [], skipped: 'already-audited' })
    expect(scribe.fn).not.toHaveBeenCalled()
  })

  it('never writes over a file map somebody wrote by hand', async () => {
    // An unmarked map comes back empty from the inventory; nothing to write.
    const mem = fakeMemory({ filemap: '# Files\n\nsrc/app.ts does the boot.\n' })
    const out = await auditProject({
      inventory: inventory({ filemap: '' }),
      memory: mem.port,
      signal: live
    })
    expect(out.wrote).not.toContain('filemap')
    expect(mem.docs.get('filemap')).toBe('# Files\n\nsrc/app.ts does the boot.\n')
  })

  it('still maps the project offline, and says why it stopped there', async () => {
    const mem = fakeMemory()
    const out = await auditProject({ inventory: inventory(), memory: mem.port, signal: live })
    expect(out).toEqual({ wrote: ['filemap'], skipped: 'no-scribe' })
  })

  it('reports nothing to audit for a project with no readable files', async () => {
    const mem = fakeMemory()
    const scribe = fakeScribe('{}')
    for (const inv of [undefined, inventory({ files: 0 })]) {
      const out = await auditProject({ inventory: inv, memory: mem.port, scribe: scribe.fn, signal: live })
      expect(out).toEqual({ wrote: [], skipped: 'nothing-to-audit' })
    }
    expect(mem.docs.size).toBe(0)
    expect(scribe.fn).not.toHaveBeenCalled()
  })

  it('refuses to record a thin architecture', async () => {
    // A wrong ARCHITECTURE.md is re-read as truth on every later turn, so a
    // one-liner is worse than the honest placeholder it would replace.
    const mem = fakeMemory()
    const scribe = fakeScribe(JSON.stringify({ architecture: '## Structure\n\nIt is a project.' }))
    const out = await auditProject({ inventory: inventory(), memory: mem.port, scribe: scribe.fn, signal: live })

    expect(out.wrote).toEqual(['filemap'])
    expect(mem.docs.has('architecture')).toBe(false)
  })

  it('keeps the file map when the answer is not JSON at all', async () => {
    const mem = fakeMemory()
    const scribe = fakeScribe('I would need to look at the code first.')
    const out = await auditProject({ inventory: inventory(), memory: mem.port, scribe: scribe.fn, signal: live })

    expect(out).toEqual({ wrote: ['filemap'], skipped: 'unusable' })
  })

  it('stops on an aborted turn without spending the call', async () => {
    const mem = fakeMemory()
    const scribe = fakeScribe('{}')
    const out = await auditProject({ inventory: inventory(), memory: mem.port, scribe: scribe.fn, signal: dead })

    expect(out).toEqual({ wrote: ['filemap'], skipped: 'aborted' })
    expect(scribe.fn).not.toHaveBeenCalled()
  })
})

// ── SPEC ─────────────────────────────────────────────────────────────────────

const SPEC_HEADINGS = [
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

/** A spec that would pass review: every mandated heading, at real length. */
const specDoc = (assumptions = 'Assuming Next.js 15, Tailwind and no auth provider yet.'): string =>
  `# Admissions portal — specification\n\n${SPEC_HEADINGS.map(
    (h) =>
      `## ${h}\n${h === 'Assumptions' ? assumptions : `Detail for ${h}, written out at production length.`}`
  ).join('\n\n')}\n`

describe('expandSpec', () => {
  const args = { request: 'build an admissions portal', overview: '', signal: live }

  it('writes PROJECT.md and records the assumptions as a decision', async () => {
    const { port, docs, decisions } = fakeMemory()
    const scribe = fakeScribe(specDoc())
    const out = await expandSpec({ ...args, complexity: 'complex', memory: port, scribe: scribe.fn })

    expect(out).toEqual({ wrote: true })
    expect(docs.get('project')).toContain('## Component architecture')
    expect(docs.get('project')?.endsWith('\n')).toBe(true)
    expect(decisions).toHaveLength(1)
    expect(decisions[0].reason).toContain('Assuming Next.js 15')
    expect(decisions[0].alternatives).toContain('Asking the user for a full brief')
  })

  it('tells the scribe to decide rather than ask, and hands it the request verbatim', async () => {
    const { port } = fakeMemory()
    const scribe = fakeScribe(specDoc())
    await expandSpec({ ...args, complexity: 'medium', memory: port, scribe: scribe.fn })

    const [system, user] = scribe.calls[0]
    expect(system.content).toContain('PRODUCT ARCHITECT')
    expect(system.content).toContain('Make professional decisions instead of asking questions')
    expect(system.content).toContain('## Completion criteria')
    expect(user.content).toContain('build an admissions portal')
    expect(user.content).toContain('this is a new build')
  })

  it('passes what already exists through, so the spec is not written for a greenfield', async () => {
    const { port } = fakeMemory()
    const scribe = fakeScribe(specDoc())
    await expandSpec({
      ...args,
      overview: 'Next 15 app with a working shell and 3 pages.',
      complexity: 'medium',
      memory: port,
      scribe: scribe.fn
    })
    expect(scribe.calls[0][1].content).toContain('working shell and 3 pages')
  })

  it('never writes a spec for a small change — that is an edit, not a product', async () => {
    const { port, docs } = fakeMemory()
    const scribe = fakeScribe(specDoc())
    const out = await expandSpec({ ...args, complexity: 'simple', memory: port, scribe: scribe.fn })
    expect(out).toEqual({ wrote: false, skipped: 'too-small' })
    expect(scribe.fn).not.toHaveBeenCalled()
    expect(docs.size).toBe(0)
  })

  it('runs at most once per project: an existing spec is never re-derived', async () => {
    const { port, docs } = fakeMemory({ project: '# Spec\n\nalready written by an earlier turn.' })
    const scribe = fakeScribe(specDoc())
    const out = await expandSpec({ ...args, complexity: 'complex', memory: port, scribe: scribe.fn })
    expect(out).toEqual({ wrote: false, skipped: 'already-written' })
    expect(scribe.fn).not.toHaveBeenCalled()
    expect(docs.get('project')).toContain('already written by an earlier turn')
  })

  it('does nothing at all when there is no model to write it', async () => {
    const { port, docs } = fakeMemory()
    const out = await expandSpec({ ...args, complexity: 'complex', memory: port })
    expect(out).toEqual({ wrote: false, skipped: 'no-scribe' })
    expect(docs.size).toBe(0)
  })

  // A bad PROJECT.md is worse than none: every later turn would read it as truth.
  it('refuses a thin answer rather than writing a bad spec', async () => {
    const { port, docs, decisions } = fakeMemory()
    const scribe = fakeScribe('# Spec\n\n## Objective\nBuild it.\n')
    const out = await expandSpec({ ...args, complexity: 'complex', memory: port, scribe: scribe.fn })
    expect(out).toEqual({ wrote: false, skipped: 'unusable' })
    expect(docs.size).toBe(0)
    expect(decisions).toHaveLength(0)
  })

  it('refuses a long answer that ignored the mandated shape', async () => {
    const { port, docs } = fakeMemory()
    const scribe = fakeScribe(`Sure! Here is a plan for your portal.\n\n${'Lots of prose. '.repeat(60)}`)
    const out = await expandSpec({ ...args, complexity: 'complex', memory: port, scribe: scribe.fn })
    expect(out).toEqual({ wrote: false, skipped: 'unusable' })
    expect(docs.size).toBe(0)
  })

  it('strips a code fence the model wrapped the document in', async () => {
    const { port, docs } = fakeMemory()
    const scribe = fakeScribe('```markdown\n' + specDoc() + '```')
    const out = await expandSpec({ ...args, complexity: 'complex', memory: port, scribe: scribe.fn })
    expect(out.wrote).toBe(true)
    expect(docs.get('project')?.startsWith('# Admissions portal')).toBe(true)
  })

  it('treats a failed call as a skipped stage, not a failed run', async () => {
    const { port, docs } = fakeMemory()
    const out = await expandSpec({
      ...args,
      complexity: 'complex',
      memory: port,
      scribe: async () => {
        throw new Error('provider down')
      }
    })
    expect(out).toEqual({ wrote: false, skipped: 'unusable' })
    expect(docs.size).toBe(0)
  })

  it('writes nothing once the run has been aborted', async () => {
    const { port, docs } = fakeMemory()
    const scribe = fakeScribe(specDoc())
    const out = await expandSpec({
      ...args,
      signal: dead,
      complexity: 'complex',
      memory: port,
      scribe: scribe.fn
    })
    expect(out).toEqual({ wrote: false, skipped: 'aborted' })
    expect(docs.size).toBe(0)
  })
})

// ── PLAN ─────────────────────────────────────────────────────────────────────

describe('authorPhasePlan', () => {
  const args = { request: 'build the portal', tasks: [task('t1')], memoryDigest: '', signal: live }

  it('renders the full skeleton with no model at all', async () => {
    const out = await authorPhasePlan({ ...args, phase: ctx('complex', 2) })
    expect(out).toContain('# Plan — Phase 2 of 9: Design system and shell')
    expect(out).toContain('## Files that must NOT be modified')
    expect(out).toContain('_To be determined — ')
    expect(out).toContain('- [ ] **t1** (Builder) do t1')
  })

  it('uses the authored bodies and keeps naming the sections the model skipped', async () => {
    const scribe = fakeScribe(
      JSON.stringify({
        why: 'Without the shell there is nowhere to hang a page.',
        create: ['src/app/layout.tsx', 'src/components/Shell.tsx'],
        protect: 'src/lib/db.ts — working persistence, do not touch.',
        nonsense: 'ignored'
      })
    )
    const out = await authorPhasePlan({ ...args, phase: ctx('complex', 2), scribe: scribe.fn })

    expect(out).toContain('Without the shell there is nowhere to hang a page.')
    expect(out).toContain('- src/app/layout.tsx')
    expect(out).toContain('working persistence, do not touch')
    expect(out).not.toContain('ignored')
    expect(out).toContain('_To be determined — hover, focus, active, keyboard')
  })

  it('briefs the model with exactly the sections it is allowed to author', async () => {
    const scribe = fakeScribe('{}')
    await authorPhasePlan({ ...args, phase: ctx('medium'), scribe: scribe.fn })
    const [system, user] = scribe.calls[0]

    expect(system.content).toContain('TECHNICAL ARCHITECT')
    expect(system.content).toContain('"archStrategy"')
    // The derived sections are never asked for — they come from the real graph.
    expect(system.content).not.toContain('"tasks"')
    expect(system.content).not.toContain('"checklist"')
    // Nor are the sections above this complexity.
    expect(system.content).not.toContain('"performance"')
    expect(user.content).toContain('Phase 1 of 5 — Foundation')
    expect(user.content).toContain('- t1 (builder): do t1')
  })

  it('falls back to the skeleton when the answer is not usable JSON', async () => {
    const scribe = fakeScribe('I would start by exploring the repository.')
    const out = await authorPhasePlan({ ...args, phase: ctx('simple'), scribe: scribe.fn })
    expect(out).toContain('# Plan — Phase 1 of 3: Foundation')
    expect(out).toContain('_To be determined — ')
  })

  it('falls back to the skeleton when the call fails or the run is aborted', async () => {
    const thrown = await authorPhasePlan({
      ...args,
      phase: ctx('simple'),
      scribe: async () => {
        throw new Error('provider down')
      }
    })
    expect(thrown).toContain('# Plan — Phase 1 of 3: Foundation')

    const scribe = fakeScribe(JSON.stringify({ why: 'authored after the abort' }))
    const stopped = await authorPhasePlan({
      ...args,
      phase: ctx('simple'),
      signal: dead,
      scribe: scribe.fn
    })
    expect(stopped).not.toContain('authored after the abort')
  })

  it('names the real verification commands in the plan it renders', async () => {
    const out = await authorPhasePlan({
      ...args,
      phase: ctx('simple'),
      verifyCommands: ['npm run typecheck', 'npm test']
    })
    expect(out).toContain('`npm run typecheck` passes')
    expect(out).toContain('`npm test` passes')
  })
})

// ── TASKS.md ─────────────────────────────────────────────────────────────────

describe('renderTasksDoc', () => {
  it('marks earlier phases done, this one in progress, and later ones pending', () => {
    const doc = renderTasksDoc({ phase: ctx('medium', 3), tasks: [], phaseDone: false })
    expect(doc).toContain('## Phase 2 — Core implementation\n\n- [x]')
    expect(doc).toContain('## Phase 3 — Data and integration\n\n- [~]')
    expect(doc).toContain('## Phase 4 — Edge states and responsive\n\n- [ ]')
    expect(doc.match(/^## Phase /gm)).toHaveLength(5)
  })

  it('ticks the current phase once it has closed', () => {
    const doc = renderTasksDoc({ phase: ctx('medium', 3), tasks: [], phaseDone: true })
    expect(doc).toContain('## Phase 3 — Data and integration\n\n- [x]')
  })

  it('nests this phase’s real task states under it, and only under it', () => {
    const doc = renderTasksDoc({
      phase: ctx('simple', 2),
      tasks: [
        task('t1'),
        task('t2', { state: 'running' }),
        task('t3', { state: 'failed' }),
        task('t4', { state: 'pending' })
      ],
      phaseDone: false
    })
    expect(doc).toContain('  - [x] **t1** do t1')
    expect(doc).toContain('  - [~] **t2** do t2')
    expect(doc).toContain('  - [!] **t3** do t3')
    expect(doc).toContain('  - [ ] **t4** do t4')
    const phase3 = doc.slice(doc.indexOf('## Phase 3'))
    expect(phase3).not.toContain('**t1**')
  })
})

// ── CLOSE ────────────────────────────────────────────────────────────────────

describe('closePhase', () => {
  /** A phase that finished cleanly: review passed, every task done, checks green. */
  function closeArgs(memory: MemoryPort, over: Partial<Parameters<typeof closePhase>[0]> = {}) {
    return {
      phase: ctx('medium', 2),
      request: 'build the portal',
      tasks: [task('t1'), task('t2')],
      filesChanged: ['src/App.tsx', 'src/App.tsx', 'src/main.tsx'],
      passed: true,
      verify: { ran: true, ok: true, command: 'npm run typecheck' },
      build: 'PASSING' as const,
      preview: 'RUNNING' as const,
      reviewNotes: '',
      memory,
      writePlan: vi.fn(async () => {}),
      signal: live,
      ...over
    }
  }

  it('records the phase as complete, archives it, and plans the next one', async () => {
    const mem = fakeMemory()
    const args = closeArgs(mem.port)
    const out = await closePhase(args)

    expect(out).toMatchObject({ completed: true, nextPlanWritten: true })
    expect(out.next?.name).toBe('Data and integration')
    expect(out.archived).toContain('phase-02')
    expect(mem.archived[0]).toEqual({ phase: 2, name: 'Core implementation', ids: ['t1', 't2'] })
    expect(mem.patches[0]).toMatchObject({
      phase: 2,
      status: 'complete',
      build: 'PASSING',
      preview: 'RUNNING',
      complexity: 'medium'
    })
    // The pointer moves on, so the next turn starts on the next phase.
    expect(mem.patches[1]).toMatchObject({ phase: 3, phaseName: 'Data and integration' })
    const written = (args.writePlan as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(written).toContain('# Plan — Phase 3 of 5: Data and integration')
    expect(written).not.toContain('- [ ] **t1**')
  })

  it('writes the next plan with no model call, carrying the post-phase analysis', async () => {
    // Closing a phase is bookkeeping: the next plan is RENDERED from what just
    // happened, and its judgement sections are authored at the start of the next
    // turn when that phase's real task graph exists. Spending a call here would
    // write a document that is always overwritten before anyone acts on it.
    const mem = fakeMemory()
    const args = closeArgs(mem.port)
    await closePhase(args)

    const written = (args.writePlan as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(written).toContain('## Current project state')
    expect(written).toContain('Just finished: do t1; do t2.')
    expect(written).toContain('Files now in place: src/App.tsx, src/main.tsx')
    // Nothing was invented for the sections a model would have written.
    expect(written).toContain('_To be determined —')
  })

  it('writes TASKS.md and a checkpoint that tells the next session not to re-audit', async () => {
    const mem = fakeMemory()
    await closePhase(closeArgs(mem.port))

    expect(mem.docs.get('tasks')).toContain('## Phase 2 — Core implementation\n\n- [x]')
    const cp = mem.checkpoints[0]
    expect(cp.objective).toContain('Phase 2 of 5 — Core implementation')
    expect(cp.completed).toContain('- t1: do t1')
    expect(cp.filesChanged).toEqual(['src/App.tsx', 'src/App.tsx', 'src/main.tsx'])
    expect(cp.nextAction).toContain('Start phase 3')
    expect(cp.doNotRediscover).toContain('instead of re-auditing')
  })

  it('blocks the phase — and keeps its plan — when a task did not finish', async () => {
    const mem = fakeMemory()
    const args = closeArgs(mem.port, { tasks: [task('t1'), task('t2', { state: 'failed' })] })
    const out = await closePhase(args)

    expect(out).toMatchObject({ completed: false, archived: null, next: null, nextPlanWritten: false })
    expect(mem.archived).toHaveLength(0)
    expect(mem.patches).toHaveLength(1)
    expect(mem.patches[0]).toMatchObject({ phase: 2, status: 'blocked' })
    expect(args.writePlan).not.toHaveBeenCalled()
    // Still checkpointed: a blocked phase is exactly when the next session needs one.
    expect(out.checkpoint).toBe('.sylor/sessions/latest.md')
    expect(mem.checkpoints[0].inProgress).toContain('- t2 (failed): do t2')
  })

  it('does not close a phase whose checks are failing, and says so in the checkpoint', async () => {
    const mem = fakeMemory()
    const out = await closePhase(
      closeArgs(mem.port, { verify: { ran: true, ok: false, command: 'npm test' } })
    )
    expect(out.completed).toBe(false)
    expect(mem.patches[0]).toMatchObject({ status: 'in progress' })
    expect(mem.checkpoints[0].errors).toContain('npm test failed')
  })

  it('does not close a phase the reviewer rejected', async () => {
    const mem = fakeMemory()
    const out = await closePhase(
      closeArgs(mem.port, { passed: false, reviewNotes: 'The list is not wired to the API.' })
    )
    expect(out.completed).toBe(false)
    expect(mem.checkpoints[0].nextAction).toBe('The list is not wired to the API.')
  })

  it('does not close a phase that did no work', async () => {
    const mem = fakeMemory()
    const out = await closePhase(closeArgs(mem.port, { tasks: [] }))
    expect(out.completed).toBe(false)
    expect(mem.archived).toHaveLength(0)
  })

  it('finishes the roadmap without planning a tenth phase, and audits the project', async () => {
    const mem = fakeMemory()
    const args = closeArgs(mem.port, { phase: ctx('simple', 3) })
    const out = await closePhase(args)

    expect(out).toMatchObject({ completed: true, next: null, nextPlanWritten: false, projectComplete: true })
    expect(out.archived).toContain('phase-03')
    expect(args.writePlan).not.toHaveBeenCalled()
    // §35 — the last thing that happens to a project is its audit.
    expect(mem.docs.get('audit')).toContain('# Final project audit')
    expect(mem.docs.get('audit')).toContain('Every phase of the roadmap closed')
    expect(mem.patches[1]).toMatchObject({ status: 'complete' })
  })

  it('reports an unverified build in the final audit instead of claiming success', async () => {
    // §34 — an audit that congratulated a failing build is the exact failure the
    // verification rule exists to prevent.
    const mem = fakeMemory()
    const out = await closePhase(
      closeArgs(mem.port, {
        phase: ctx('simple', 3),
        verify: { ran: true, ok: true, command: 'npm test' },
        build: 'FAILING'
      })
    )
    expect(out.projectComplete).toBe(true)
    expect(mem.docs.get('audit')).toContain('did not pass')
    expect(mem.patches[1]).toMatchObject({ status: 'blocked' })
  })

  it('audits a finished project once, never twice', async () => {
    const mem = fakeMemory({ audit: '# Final project audit\n\nAlready written.\n' })
    const out = await closePhase(closeArgs(mem.port, { phase: ctx('simple', 3) }))
    expect(out.projectComplete).toBe(false)
    expect(mem.docs.get('audit')).toContain('Already written.')
  })

  it('spends one call on the final audit when a provider is available', async () => {
    const report = [
      '# Final project audit',
      '',
      '## What was built',
      'The portal, across three phases, from the recorded plan and its archives.',
      '',
      '## Against the completion criteria',
      'Every criterion in the specification is met by a file that exists.',
      '',
      '## Verification status',
      '`npm run typecheck` passed on the final phase.',
      '',
      '## Known gaps',
      'None recorded.',
      '',
      '## Recommended next steps',
      'Ship it, then watch the error logs.'
    ].join('\n')
    const scribe = fakeScribe(report)
    const mem = fakeMemory()
    await closePhase(closeArgs(mem.port, { phase: ctx('simple', 3), scribe: scribe.fn }))

    expect(scribe.fn).toHaveBeenCalledTimes(1)
    expect(String(scribe.calls[0][0].content)).toContain('AUDITOR')
    // The auditor judges the RECORD, never a fresh exploration.
    expect(String(scribe.calls[0][1].content)).toContain('all 3 phases')
    expect(mem.docs.get('audit')).toContain('## Recommended next steps')
  })

  it('keeps the deterministic audit when the authoring call fails', async () => {
    const mem = fakeMemory()
    const scribe = vi.fn(async () => {
      throw new Error('offline')
    })
    const out = await closePhase(closeArgs(mem.port, { phase: ctx('simple', 3), scribe }))
    expect(out.projectComplete).toBe(true)
    expect(mem.docs.get('audit')).toContain('# Final project audit')
  })

  it('still closes the phase when the next plan could not be written', async () => {
    const mem = fakeMemory()
    const args = closeArgs(mem.port, {
      writePlan: vi.fn(async () => {
        throw new Error('disk full')
      })
    })
    const out = await closePhase(args)
    expect(out).toMatchObject({ completed: true, nextPlanWritten: false })
    expect(out.next?.n).toBe(3)
    expect(mem.archived).toHaveLength(1)
  })

  it('keeps the bookkeeping but stops short of the archive once aborted', async () => {
    const mem = fakeMemory()
    const args = closeArgs(mem.port, { signal: dead })
    const out = await closePhase(args)

    expect(out).toMatchObject({ completed: false, archived: null })
    expect(mem.docs.has('tasks')).toBe(true)
    expect(mem.checkpoints).toHaveLength(1)
    expect(mem.archived).toHaveLength(0)
    expect(args.writePlan).not.toHaveBeenCalled()
  })
})
