import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildInstructionsPreamble, expandImports } from '@main/context/instructions'
import { contextManager } from '@main/context/manager'

// These tests drive the REAL context manager + fs sandbox against throwaway dirs:
// a temp "project root" (pointed at via contextManager.setRoot) and a separate
// temp "user dir" (passed as opts.userDir), so the whole three-level merge +
// @import machinery runs end-to-end with nothing mocked.
const roots: string[] = []
let root = ''
let userDir = ''

function write(base: string, rel: string, content: string): void {
  const abs = join(base, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf-8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sylor-instr-root-'))
  userDir = mkdtempSync(join(tmpdir(), 'sylor-instr-user-'))
  roots.push(root, userDir)
  contextManager.setRoot(root)
})

afterEach(() => {
  // Point the singleton somewhere harmless before the dirs are removed.
  contextManager.setRoot(tmpdir())
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('buildInstructionsPreamble — hierarchical merge', () => {
  it('returns empty when no instruction file exists anywhere', () => {
    expect(buildInstructionsPreamble({ userDir })).toBe('')
  })

  it('merges user, project-root, and subdir levels in least→most-specific order', () => {
    write(userDir, 'SYLOR.md', 'User pref: prefers dark mode everywhere.')
    write(root, '.sylor/SYLOR.md', 'Repo rule: indent with tabs.')
    write(root, 'packages/api/SYLOR.md', 'API package: never log secrets.')

    const out = buildInstructionsPreamble({ userDir })

    expect(out).toContain('## User instructions (from ~/.sylor/SYLOR.md)')
    expect(out).toContain('## Repository instructions (from .sylor/SYLOR.md)')
    expect(out).toContain('## Repository instructions (from packages/api/SYLOR.md)')
    // Precedence: user first, then project root, then the nested package.
    expect(out.indexOf('prefers dark mode')).toBeLessThan(out.indexOf('indent with tabs'))
    expect(out.indexOf('indent with tabs')).toBeLessThan(out.indexOf('never log secrets'))
    // The standing-guidance trailer is appended once.
    expect(out).toContain('Follow these repository instructions as standing guidance')
  })

  it('prefers .sylor/SYLOR.md over a legacy AGENTS.md, keeping both distinct files', () => {
    write(root, '.sylor/SYLOR.md', 'Sylor rules win.')
    write(root, 'AGENTS.md', 'Legacy agents guidance.')
    const out = buildInstructionsPreamble({ userDir })
    expect(out.indexOf('Sylor rules win.')).toBeLessThan(out.indexOf('Legacy agents guidance.'))
  })

  it('picks up a Claude-Code repo unchanged (.claude/CLAUDE.md and root CLAUDE.md)', () => {
    write(root, '.claude/CLAUDE.md', 'Claude dir guidance.')
    write(root, 'CLAUDE.md', 'Root Claude guidance.')

    const out = buildInstructionsPreamble({ userDir })
    expect(out).toContain('## Repository instructions (from .claude/CLAUDE.md)')
    expect(out).toContain('## Repository instructions (from CLAUDE.md)')
    expect(out.indexOf('Claude dir guidance.')).toBeLessThan(out.indexOf('Root Claude guidance.'))
  })
})

describe('buildInstructionsPreamble — @import inlining', () => {
  it('inlines a project @import relative to the importing file', () => {
    write(root, '.sylor/SYLOR.md', 'Base rules.\n@shared/style.md\nEnd of rules.')
    write(root, '.sylor/shared/style.md', 'Detailed style guide contents.')

    const out = buildInstructionsPreamble({ userDir })
    expect(out).toContain('Detailed style guide contents.')
    // The marker line is replaced, not left behind.
    expect(out).not.toContain('@shared/style.md')
  })

  it('inlines a user-level @import confined to ~/.sylor', () => {
    write(userDir, 'SYLOR.md', 'Global prefs.\n@extra.md')
    write(userDir, 'extra.md', 'Imported user preferences.')
    const out = buildInstructionsPreamble({ userDir })
    expect(out).toContain('Imported user preferences.')
  })

  it('refuses an @import that escapes the project root, leaving the line literal', () => {
    // A sibling of the root — must never be inlined.
    write(dirname(root), 'sylor-instr-secret.md', 'TOP SECRET OUTSIDE ROOT')
    write(root, '.sylor/SYLOR.md', 'Rules.\n@../../sylor-instr-secret.md')

    const out = buildInstructionsPreamble({ userDir })
    expect(out).not.toContain('TOP SECRET OUTSIDE ROOT')
    expect(out).toContain('@../../sylor-instr-secret.md')
  })

  it('terminates on a cyclic @import chain (a → b → a)', () => {
    write(root, '.sylor/SYLOR.md', 'Alpha.\n@b.md')
    write(root, '.sylor/b.md', 'Bravo.\n@SYLOR.md')
    const out = buildInstructionsPreamble({ userDir })
    expect(out).toContain('Alpha.')
    expect(out).toContain('Bravo.')
  })
})

describe('expandImports — unit', () => {
  it('leaves incidental @tokens (handles, @media, @param) untouched', () => {
    const read = (): string | null => 'SHOULD NOT APPEAR'
    const src = ['Contact @arafat on chat', '@media (max-width: 600px) {', ' * @param foo the thing'].join('\n')
    expect(expandImports(src, '', read, new Set(), 5)).toBe(src)
  })

  it('replaces a whole-line @path with the resolved content', () => {
    const read = (rel: string): string | null => (rel === 'notes.md' ? 'INLINED' : null)
    expect(expandImports('before\n@notes.md\nafter', '', read, new Set(), 5)).toBe('before\nINLINED\nafter')
  })
})
