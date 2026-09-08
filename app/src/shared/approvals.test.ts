import { describe, expect, it } from 'vitest'
import type { ToolProposal } from './types'
import { standingApprovalKey, standingApprovalLabel, standingApprovalNote } from './approvals'

const write = (path: string): ToolProposal => ({
  id: `w-${path}`,
  kind: 'write_file',
  path,
  oldContent: '',
  newContent: 'x',
  exists: false
})

const cmd = (command: string): ToolProposal => ({ id: 'c1', kind: 'run_command', command })

describe('standingApprovalKey', () => {
  it('covers every write in the run under one key', () => {
    // The grant is "stop asking about file edits", not "stop asking about this
    // file" — a build writes dozens of files it never named up front.
    expect(standingApprovalKey(write('src/a.ts'))).toBe('write_file')
    expect(standingApprovalKey(write('src/b.ts'))).toBe('write_file')
  })

  it('keys a command on the exact command, so yes to npm test is not yes to rm', () => {
    expect(standingApprovalKey(cmd('npm test'))).toBe('run_command:npm test')
    expect(standingApprovalKey(cmd('  npm test  '))).toBe('run_command:npm test')
    expect(standingApprovalKey(cmd('rm -rf build'))).not.toBe(standingApprovalKey(cmd('npm test')))
  })

  it('keys a diagnostics run on its scope', () => {
    expect(standingApprovalKey({ id: 'd1', kind: 'diagnostics', scope: 'all' })).toBe(
      'diagnostics:all'
    )
  })

  it('refuses to escalate anything that reaches the outside world', () => {
    // No standing grant for network egress, plugin installs, or browsing — the
    // browser has its own policy (payment refused, send/delete always asked) and a
    // per-run shortcut here would quietly outrank it.
    expect(standingApprovalKey({ id: 'b1', kind: 'browse', action: 'click', risk: 'send' })).toBeNull()
    expect(standingApprovalKey({ id: 'f1', kind: 'web_fetch', url: 'https://example.com' })).toBeNull()
    expect(standingApprovalKey({ id: 's1', kind: 'web_search', query: 'q' })).toBeNull()
    expect(
      standingApprovalKey({ id: 'm1', kind: 'mcp_call', server: 'fs', name: 'read', arguments: {} })
    ).toBeNull()
    expect(
      standingApprovalKey({ id: 'i1', kind: 'install_plugin', source: 'x', scope: 'project' })
    ).toBeNull()
  })
})

describe('standingApprovalLabel', () => {
  it('says exactly what the grant covers, so its scope is never a surprise', () => {
    expect(standingApprovalLabel(write('src/a.ts'))).toContain('file edits')
    expect(standingApprovalLabel(cmd('npm test'))).toContain('`npm test`')
    expect(standingApprovalLabel(cmd('npm test'))).toContain('rest of this run')
  })

  it('offers nothing where no grant is possible', () => {
    expect(standingApprovalLabel({ id: 'f1', kind: 'web_fetch', url: 'https://x.dev' })).toBeNull()
    expect(
      standingApprovalLabel({ id: 'b1', kind: 'browse', action: 'click', risk: 'send' })
    ).toBeNull()
  })
})

describe('standingApprovalNote', () => {
  it('records the grant in the past tense, matching the scope that was granted', () => {
    expect(standingApprovalNote(write('src/a.ts'))).toBe(
      "Standing approval — I won't ask again about file edits for the rest of this run."
    )
    expect(standingApprovalNote(cmd('npm test'))).toContain('`npm test`')
  })

  it('has nothing to record where no grant is possible', () => {
    expect(standingApprovalNote({ id: 'f1', kind: 'web_fetch', url: 'https://x.dev' })).toBeNull()
  })
})
