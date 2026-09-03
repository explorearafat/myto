import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { contextManager } from '@main/context/manager'
import { SCAFFOLD_MARKER, memoryDocPath, scaffoldMemory } from '@main/context/projectMemory'
import {
  appendDecision,
  archivePlan,
  archivedPlanPath,
  latestCheckpointPath,
  readLatestCheckpoint,
  readProjectState,
  slugify,
  updateProjectState,
  writeSessionCheckpoint
} from '@main/context/projectState'

// Same harness as projectMemory.test.ts: the real context manager and the real fs
// sandbox against a throwaway root, so header patching and archiving are exercised
// against actual files rather than a mock's idea of them.
const roots: string[] = []
let root = ''

function write(rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf-8')
}

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf-8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sylor-state-'))
  roots.push(root)
  contextManager.setRoot(root)
})

afterEach(() => {
  contextManager.setRoot(tmpdir())
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('readProjectState', () => {
  it('reports a fresh project when STATE.md does not exist', () => {
    expect(readProjectState()).toEqual({
      phase: 0,
      phaseName: '',
      status: 'not started',
      build: 'UNKNOWN',
      preview: 'UNKNOWN',
      fresh: true
    })
  })

  it('still reports fresh while STATE.md is the untouched scaffold', () => {
    scaffoldMemory()
    expect(read(memoryDocPath('state'))).toContain(SCAFFOLD_MARKER)
    expect(readProjectState().fresh).toBe(true)
    expect(readProjectState().phase).toBe(0)
  })

  it('parses the four header lines out of a written STATE.md', () => {
    write(
      '.sylor/STATE.md',
      [
        '# Current state',
        '',
        'Phase: 3 — Core pages',
        'Status: in progress',
        'Build: PASSING',
        'Preview: RUNNING',
        '',
        '## Completed',
        '- the shell'
      ].join('\n')
    )
    expect(readProjectState()).toEqual({
      phase: 3,
      phaseName: 'Core pages',
      status: 'in progress',
      build: 'PASSING',
      preview: 'RUNNING',
      fresh: false
    })
  })

  it('accepts hand-written header variations', () => {
    write('.sylor/STATE.md', 'Phase: Phase 2: design system\nStatus: blocked\nBuild: failing\nPreview: compile error\n')
    expect(readProjectState()).toMatchObject({
      phase: 2,
      phaseName: 'design system',
      status: 'blocked',
      build: 'FAILING',
      preview: 'COMPILE_ERROR'
    })
  })

  it('degrades a garbled header to UNKNOWN instead of throwing', () => {
    write('.sylor/STATE.md', '# Current state\n\nwe are somewhere in the middle of the work\n')
    expect(readProjectState()).toEqual({
      phase: 0,
      phaseName: '',
      status: 'in progress',
      build: 'UNKNOWN',
      preview: 'UNKNOWN',
      fresh: false
    })
  })

  it('follows an adopted .claude directory', () => {
    mkdirSync(join(root, '.claude'))
    write('.claude/STATE.md', 'Phase: 1 — Foundation\nStatus: complete\nBuild: PASSING\nPreview: STALE\n')
    expect(readProjectState()).toMatchObject({ phase: 1, phaseName: 'Foundation', preview: 'STALE' })
  })
})

describe('updateProjectState', () => {
  it('creates STATE.md with a full header when the project has none', () => {
    const next = updateProjectState({ phase: 1, phaseName: 'Foundation', status: 'in progress' })
    expect(next).toMatchObject({ phase: 1, phaseName: 'Foundation', fresh: false })
    const doc = read('.sylor/STATE.md')
    expect(doc).toContain('# Current state')
    expect(doc).toContain('Phase: 1 — Foundation')
    expect(doc).toContain('Status: in progress')
    expect(doc).toContain('Build: UNKNOWN')
    expect(doc).toContain('Preview: UNKNOWN')
  })

  it("patches the header lines in place and leaves the agent's prose untouched", () => {
    scaffoldMemory()
    const before = read('.sylor/STATE.md')
    updateProjectState({ phase: 4, phaseName: 'Data and backend', status: 'complete', build: 'PASSING' })
    const after = read('.sylor/STATE.md')

    expect(after).toContain('Phase: 4 — Data and backend')
    expect(after).toContain('Status: complete')
    expect(after).toContain('Build: PASSING')
    // Every non-header line of the scaffold survives byte-for-byte.
    const kept = before
      .split('\n')
      .filter((l) => !/^(Phase|Status|Build|Preview):/.test(l) && l !== SCAFFOLD_MARKER)
    for (const line of kept) expect(after).toContain(line)
  })

  it('drops the scaffold marker on the first real update, so the doc gets injected', () => {
    scaffoldMemory()
    updateProjectState({ phase: 1, phaseName: 'Foundation' })
    expect(read('.sylor/STATE.md')).not.toContain(SCAFFOLD_MARKER)
    expect(readProjectState().fresh).toBe(false)
  })

  it('keeps the phase name when only the status changes', () => {
    updateProjectState({ phase: 2, phaseName: 'Core pages' })
    updateProjectState({ status: 'complete', preview: 'RUNNING' })
    expect(readProjectState()).toMatchObject({
      phase: 2,
      phaseName: 'Core pages',
      status: 'complete',
      preview: 'RUNNING'
    })
  })

  it('clears a stale phase name when the phase advances without one', () => {
    updateProjectState({ phase: 2, phaseName: 'Core pages' })
    updateProjectState({ phase: 3 })
    const state = readProjectState()
    expect(state.phase).toBe(3)
    expect(state.phaseName).toBe('')
    expect(read('.sylor/STATE.md')).toContain('Phase: 3\n')
  })

  it('re-inserts the whole header block when a hand-edited doc is missing a line', () => {
    write('.sylor/STATE.md', '# Current state\n\nPhase: 5\n\n## Completed\n- everything so far\n')
    updateProjectState({ status: 'in progress', build: 'FAILING' })
    const doc = read('.sylor/STATE.md')
    expect(doc).toContain('Phase: 5')
    expect(doc).toContain('Status: in progress')
    expect(doc).toContain('Build: FAILING')
    expect(doc).toContain('Preview: UNKNOWN')
    expect(doc).toContain('- everything so far')
    expect(doc.match(/^Phase:/gm)).toHaveLength(1)
    expect(readProjectState()).toMatchObject({ phase: 5, build: 'FAILING' })
  })

  it('remembers the routed complexity so the roadmap cannot resize between turns', () => {
    updateProjectState({ phase: 1, phaseName: 'Foundation', complexity: 'complex' })
    expect(read('.sylor/STATE.md')).toContain('Complexity: complex')
    expect(readProjectState().complexity).toBe('complex')

    // A later patch that says nothing about complexity must not clear it.
    updateProjectState({ phase: 2, status: 'in progress' })
    expect(readProjectState().complexity).toBe('complex')
  })

  it('leaves the complexity unset until the project has been sized', () => {
    updateProjectState({ status: 'in progress' })
    expect(read('.sylor/STATE.md')).toContain('Complexity: —')
    expect(readProjectState().complexity).toBeUndefined()
  })

  it('writes to an adopted .claude/STATE.md rather than creating a second home', () => {
    mkdirSync(join(root, '.claude'))
    updateProjectState({ phase: 1, phaseName: 'Foundation' })
    expect(read('.claude/STATE.md')).toContain('Phase: 1 — Foundation')
    expect(existsSync(join(root, '.sylor/STATE.md'))).toBe(false)
  })
})

describe('slugify and archivedPlanPath', () => {
  it('makes a stable filename out of a phase name', () => {
    expect(slugify('Core pages & routing')).toBe('core-pages-routing')
    expect(slugify('  Responsive / a11y  ')).toBe('responsive-a11y')
    expect(slugify('!!!')).toBe('phase')
    expect(slugify('x'.repeat(80))).toHaveLength(48)
  })

  it('zero-pads the phase number', () => {
    expect(archivedPlanPath(3, 'Core pages')).toBe('.sylor/plans/phase-03-core-pages.md')
    expect(archivedPlanPath(12, 'Final audit')).toBe('.sylor/plans/phase-12-final-audit.md')
    expect(archivedPlanPath(0, '')).toBe('.sylor/plans/phase-01-phase.md')
  })
})

describe('archivePlan', () => {
  it('files the plan under plans/ and leaves a stub with no unchecked box', () => {
    write('plan.md', '# Plan — Phase 2\n\n- [ ] **t1** build the thing\n')
    const dest = archivePlan(2, 'Core pages', 'plan.md')

    expect(dest).toBe('.sylor/plans/phase-02-core-pages.md')
    const archived = read('.sylor/plans/phase-02-core-pages.md')
    expect(archived).toContain('<!-- archived: phase 2 — Core pages -->')
    expect(archived).toContain('- [ ] **t1** build the thing')

    // §36: plan.md must never keep describing completed work — and the stub must not
    // carry an unchecked box, or the engine's continue-nudge would fire on it forever.
    const stub = read('plan.md')
    expect(stub).toContain('Phase 2 (Core pages) is complete')
    expect(stub).toContain('.sylor/plans/phase-02-core-pages.md')
    expect(stub).not.toContain('- [ ]')
  })

  it('ticks the boxes of the tasks that actually completed', () => {
    write('plan.md', '- [ ] **t1** first\n- [ ] **t2** second\n- [ ] **t10** tenth\n')
    archivePlan(2, 'Core', 'plan.md', ['t1', 't10'])
    const archived = read('.sylor/plans/phase-02-core.md')
    expect(archived).toContain('- [x] **t1** first')
    expect(archived).toContain('- [ ] **t2** second')
    expect(archived).toContain('- [x] **t10** tenth')
  })

  it('returns null when there is no plan to archive', () => {
    expect(archivePlan(1, 'Foundation', 'plan.md')).toBeNull()
    write('plan.md', '   \n')
    expect(archivePlan(1, 'Foundation', 'plan.md')).toBeNull()
  })

  it('does not double-wrap an already-headered plan', () => {
    write('.sylor/plan.md', '<!-- archived: phase 1 — Foundation -->\n# Plan\n')
    archivePlan(1, 'Foundation', '.sylor/plan.md')
    expect(read('.sylor/plans/phase-01-foundation.md').match(/<!-- archived/g)).toHaveLength(1)
  })
})

describe('appendDecision', () => {
  it('creates the log and records reason, alternatives and consequence', () => {
    expect(
      appendDecision({
        decision: 'Use SQLite for local persistence',
        reason: 'offline-first, no server to run',
        alternatives: 'IndexedDB, flat JSON',
        consequence: 'native module has to build per platform'
      })
    ).toBe(true)

    const doc = read('.sylor/DECISIONS.md')
    expect(doc).toContain('# Decision log')
    expect(doc).toContain('— Use SQLite for local persistence')
    expect(doc).toContain('- Reason: offline-first, no server to run')
    expect(doc).toContain('- Alternatives considered: IndexedDB, flat JSON')
    expect(doc).toContain('- Consequence: native module has to build per platform')
    expect(doc).toMatch(/## \d{4}-\d{2}-\d{2} —/)
  })

  it('appends newest last and never rewrites history', () => {
    appendDecision({ decision: 'first call', reason: 'a' })
    appendDecision({ decision: 'second call', reason: 'b' })
    const doc = read('.sylor/DECISIONS.md')
    expect(doc.indexOf('first call')).toBeLessThan(doc.indexOf('second call'))
    expect(doc).toContain('- Alternatives considered: —')
  })

  it('drops the scaffold marker and keeps the scaffolded heading', () => {
    scaffoldMemory()
    appendDecision({ decision: 'the first real call', reason: 'because' })
    const doc = read('.sylor/DECISIONS.md')
    expect(doc).not.toContain(SCAFFOLD_MARKER)
    expect(doc).toContain('the first real call')
  })
})

describe('session checkpoints', () => {
  const cp = {
    objective: 'Ship the admissions portal',
    completed: 'shell, nav, home page',
    inProgress: 'the programme list',
    nextAction: 'wire the programme list to the API',
    filesChanged: ['src/pages/Programmes.tsx', 'src/api/programmes.ts'],
    errors: 'none outstanding',
    decisions: 'server components for the list',
    doNotRediscover: 'the stack is Next 15 + Tailwind; the API base is /api/v1'
  }

  it('writes both a timestamped file and the stable latest.md pointer', () => {
    // Constructed in local time, because the stamp is local — minute resolution.
    const dated = writeSessionCheckpoint(cp, new Date(2026, 8, 3, 16, 42))

    expect(dated).toBe('.sylor/sessions/2026-09-03-1642.md')
    expect(latestCheckpointPath()).toBe('.sylor/sessions/latest.md')
    expect(read('.sylor/sessions/latest.md')).toBe(read(dated as string))
  })

  it('records every section a fresh session needs, including what NOT to rediscover', () => {
    writeSessionCheckpoint(cp)
    const doc = read(latestCheckpointPath())
    for (const heading of [
      '## Current objective',
      '## Completed this session',
      '## In progress',
      '## Next action',
      '## Files changed',
      '## Errors encountered',
      '## Decisions made',
      '## Do NOT rediscover'
    ]) {
      expect(doc).toContain(heading)
    }
    expect(doc).toContain('- src/pages/Programmes.tsx')
    expect(doc).toContain('the API base is /api/v1')
  })

  it('reads the latest checkpoint back, and null when there is none', () => {
    expect(readLatestCheckpoint()).toBeNull()
    writeSessionCheckpoint(cp)
    expect(readLatestCheckpoint()).toContain('Ship the admissions portal')
  })

  it('fills empty optional sections with an em dash rather than leaving them blank', () => {
    writeSessionCheckpoint({
      objective: '',
      completed: '',
      inProgress: '',
      nextAction: '',
      filesChanged: [],
      doNotRediscover: ''
    })
    const doc = read(latestCheckpointPath())
    expect(doc).toContain('## Files changed\n—')
    expect(doc).toContain('## Errors encountered\n—')
  })
})
