import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { contextManager } from '@main/context/manager'
import {
  SCAFFOLD_MARKER,
  activePlanPath,
  buildMemoryPreamble,
  isPlaceholder,
  memoryDocPath,
  readMemoryDoc,
  resolveMemoryHome,
  scaffoldMemory
} from '@main/context/projectMemory'

// Drives the REAL context manager + fs sandbox against a throwaway project root,
// so directory detection, scaffolding, and the injected preamble all run end-to-end
// with nothing mocked.
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
  root = mkdtempSync(join(tmpdir(), 'sylor-memory-'))
  roots.push(root)
  contextManager.setRoot(root)
})

afterEach(() => {
  // Point the singleton somewhere harmless before the dirs are removed.
  contextManager.setRoot(tmpdir())
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('resolveMemoryHome', () => {
  it('defaults to .sylor when the project has no agent-memory directory', () => {
    expect(resolveMemoryHome()).toEqual({
      dir: '.sylor',
      instructions: 'SYLOR.md',
      existed: false
    })
  })

  it('adopts an existing .claude directory and names its instructions CLAUDE.md', () => {
    mkdirSync(join(root, '.claude'))
    expect(resolveMemoryHome()).toEqual({
      dir: '.claude',
      instructions: 'CLAUDE.md',
      existed: true
    })
  })

  it('adopts an existing .sylor directory', () => {
    mkdirSync(join(root, '.sylor'))
    expect(resolveMemoryHome()).toEqual({
      dir: '.sylor',
      instructions: 'SYLOR.md',
      existed: true
    })
  })

  it('prefers .claude when both directories are present', () => {
    mkdirSync(join(root, '.claude'))
    mkdirSync(join(root, '.sylor'))
    expect(resolveMemoryHome().dir).toBe('.claude')
  })

  it('ignores a plain FILE named like a memory directory', () => {
    write('.claude', 'not a directory')
    expect(resolveMemoryHome().dir).toBe('.sylor')
  })
})

describe('memoryDocPath', () => {
  it('resolves doc paths against the active home', () => {
    expect(memoryDocPath('state')).toBe('.sylor/STATE.md')
    expect(memoryDocPath('instructions')).toBe('.sylor/SYLOR.md')
    mkdirSync(join(root, '.claude'))
    expect(memoryDocPath('state')).toBe('.claude/STATE.md')
    expect(memoryDocPath('instructions')).toBe('.claude/CLAUDE.md')
  })
})

describe('scaffoldMemory', () => {
  it('creates the full document set once, then reports nothing left to create', () => {
    const created = scaffoldMemory()
    expect(created).toEqual([
      '.sylor/SYLOR.md',
      '.sylor/PROJECT.md',
      '.sylor/ARCHITECTURE.md',
      '.sylor/FILEMAP.md',
      '.sylor/CONVENTIONS.md',
      '.sylor/DECISIONS.md',
      '.sylor/STATE.md',
      '.sylor/TASKS.md'
    ])
    expect(scaffoldMemory()).toEqual([])
  })

  it('marks every scaffold as a placeholder and keeps the section headings', () => {
    scaffoldMemory()
    for (const rel of ['.sylor/PROJECT.md', '.sylor/STATE.md', '.sylor/TASKS.md']) {
      expect(isPlaceholder(read(rel))).toBe(true)
    }
    expect(read('.sylor/PROJECT.md')).toContain('## Success criteria')
    expect(read('.sylor/STATE.md')).toContain('Preview: UNKNOWN')
    expect(read('.sylor/TASKS.md')).toContain('## Phase 1 — Foundation')
    expect(read('.sylor/FILEMAP.md')).toContain('Purpose:')
  })

  it('never overwrites a document another tool or a human already wrote', () => {
    mkdirSync(join(root, '.claude'))
    write('.claude/CLAUDE.md', '# House rules\n\nUse tabs.')
    write('.claude/PROJECT.md', '# Spec\n\nAlready written by hand.')

    const created = scaffoldMemory()
    expect(created).not.toContain('.claude/CLAUDE.md')
    expect(created).not.toContain('.claude/PROJECT.md')
    expect(created).toContain('.claude/STATE.md')
    expect(read('.claude/CLAUDE.md')).toBe('# House rules\n\nUse tabs.')
    expect(read('.claude/PROJECT.md')).toBe('# Spec\n\nAlready written by hand.')
  })
})

describe('readMemoryDoc', () => {
  it('returns null when the doc is missing or blank, and the text when written', () => {
    expect(readMemoryDoc('state')).toBeNull()
    write('.sylor/STATE.md', '   \n\n')
    expect(readMemoryDoc('state')).toBeNull()
    write('.sylor/STATE.md', '# Current state\n\nPhase: 2\n')
    expect(readMemoryDoc('state')).toBe('# Current state\n\nPhase: 2')
  })
})

describe('activePlanPath', () => {
  it('falls back to the historical root-level plan.md', () => {
    expect(activePlanPath()).toBe('plan.md')
    write('plan.md', '# Phase 1\n\n- [ ] do the thing')
    expect(activePlanPath()).toBe('plan.md')
  })

  it('prefers a plan inside the memory directory once one exists', () => {
    write('plan.md', '# stale root plan')
    write('.sylor/plan.md', '# Phase 3\n\n- [ ] the current phase')
    expect(activePlanPath()).toBe('.sylor/plan.md')
  })

  it('follows the adopted .claude home', () => {
    write('.claude/plan.md', '# Phase 1')
    expect(activePlanPath()).toBe('.claude/plan.md')
  })
})

describe('buildMemoryPreamble', () => {
  it('adds nothing to the prompt for a project with no memory at all', () => {
    expect(buildMemoryPreamble()).toBe('')
  })

  it('costs almost nothing right after scaffolding — names the docs, injects no bodies', () => {
    scaffoldMemory()
    const out = buildMemoryPreamble()

    expect(out).toContain('## Project memory (.sylor/)')
    expect(out).toContain('### Not written yet')
    for (const file of [
      'PROJECT.md',
      'ARCHITECTURE.md',
      'FILEMAP.md',
      'CONVENTIONS.md',
      'DECISIONS.md',
      'STATE.md',
      'TASKS.md'
    ]) {
      expect(out).toContain(file)
      expect(out).not.toContain(`### ${file} —`)
    }
    // The un-filled skeletons must never reach the prompt.
    expect(out).not.toContain(SCAFFOLD_MARKER)
    expect(out).not.toContain('## Success criteria')
  })

  it('injects written docs with their purpose, and leaves the instructions doc to instructions.ts', () => {
    scaffoldMemory()
    write('.sylor/FILEMAP.md', 'src/app.tsx\nPurpose: the application shell.')
    write('.sylor/STATE.md', 'Phase: 2\nBuild: PASSING\nPreview: RUNNING')

    const out = buildMemoryPreamble()
    expect(out).toContain('### FILEMAP.md — what each important file is responsible for')
    expect(out).toContain('Purpose: the application shell.')
    expect(out).toContain('### STATE.md — where the work stands right now')
    expect(out).toContain('Build: PASSING')
    // Injected by the instruction loader instead, so it is never sent twice.
    expect(out).not.toContain('### SYLOR.md')
    expect(out).toContain('### Not written yet')
    expect(out).toContain('PROJECT.md')
  })

  it('states the read-discipline and maintenance contract against the real directory', () => {
    mkdirSync(join(root, '.claude'))
    scaffoldMemory()
    write('.claude/STATE.md', 'Phase: 1')

    const out = buildMemoryPreamble()
    expect(out).toContain('## Project memory (.claude/)')
    expect(out).toContain('never open a file just to')
    expect(out).toContain('.claude/STATE.md and .claude/TASKS.md after every meaningful step')
    expect(out).toContain('.claude/FILEMAP.md whenever a file is created')
  })

  it('clips an over-budget doc from the start', () => {
    write('.sylor/FILEMAP.md', `head-of-filemap\n${'x'.repeat(9_000)}\ntail-of-filemap`)
    const out = buildMemoryPreamble()
    expect(out).toContain('head-of-filemap')
    expect(out).not.toContain('tail-of-filemap')
    expect(out).toContain('… (truncated)')
  })

  it('clips the append-only decision log from the END so the newest calls survive', () => {
    write(
      '.sylor/DECISIONS.md',
      `## 2026-01-01 — the-oldest-call\n${'filler line\n'.repeat(300)}## 2026-09-03 — the-newest-call`
    )
    const out = buildMemoryPreamble()
    expect(out).toContain('the-newest-call')
    expect(out).not.toContain('the-oldest-call')
    expect(out).toContain('… (earlier entries omitted)')
  })

  it('drops whole low-priority sections when the docs overrun the total budget', () => {
    for (const file of [
      'PROJECT.md',
      'ARCHITECTURE.md',
      'FILEMAP.md',
      'CONVENTIONS.md',
      'DECISIONS.md',
      'STATE.md',
      'TASKS.md'
    ]) {
      write(`.sylor/${file}`, `${file} body\n${'x'.repeat(5_000)}`)
    }

    const out = buildMemoryPreamble()
    // Where the work stands is the last thing squeezed out; the decision log goes first.
    expect(out).toContain('### STATE.md')
    expect(out).toContain('### TASKS.md')
    expect(out).toContain('### FILEMAP.md')
    expect(out).toContain('### CONVENTIONS.md')
    expect(out).not.toContain('### DECISIONS.md')
    expect(out.length).toBeLessThan(13_000)
  })

  it('never injects the follow-up log, nor lists it as unwritten', () => {
    // A list of unrelated open issues in every prompt would invite exactly the scope
    // creep the flag exists to prevent, and it is the USER's list to pick from.
    expect(memoryDocPath('followups')).toBe('.sylor/FOLLOWUPS.md')
    scaffoldMemory()
    write('.sylor/FOLLOWUPS.md', '# Follow-ups\n\n## 2026-09-05 — fix-the-badge')
    const out = buildMemoryPreamble()
    expect(out).not.toContain('FOLLOWUPS.md')
    expect(out).not.toContain('fix-the-badge')
  })
})
