import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A temp dir stands in for the user's Documents folder; app.getPath('documents')
// returns it so ensureDefaultWorkspace creates <tmp>/Myto under our control.
let DOCS = ''
vi.mock('electron', () => ({ app: { getPath: () => DOCS } }))

import {
  DEFAULT_WORKSPACE_NAME,
  FALLBACK_WORKSPACE_NAME,
  defaultWorkspaceIn,
  ensureDefaultWorkspace,
  sanitizeWorkspaceName,
  workspaceOnDesktop,
  ensureWorkspaceOnDesktop
} from './cowork-workspace'

describe('cowork-workspace', () => {
  beforeAll(async () => {
    DOCS = await mkdtemp(join(tmpdir(), 'myto-docs-'))
  })
  afterAll(async () => {
    await rm(DOCS, { recursive: true, force: true })
  })

  it('derives <documents>/Myto (pure)', () => {
    expect(defaultWorkspaceIn('/home/u/Documents')).toBe(join('/home/u/Documents', DEFAULT_WORKSPACE_NAME))
  })

  it('creates the default working folder and returns its path', async () => {
    const dir = await ensureDefaultWorkspace()
    expect(dir).toBe(join(DOCS, 'Myto'))
    expect((await stat(dir)).isDirectory()).toBe(true)
  })

  it('is idempotent — a second call on an existing folder is fine', async () => {
    const a = await ensureDefaultWorkspace()
    const b = await ensureDefaultWorkspace()
    expect(a).toBe(b)
    expect((await stat(b)).isDirectory()).toBe(true)
  })

  it('sanitizes a user-supplied folder name for Windows', () => {
    expect(sanitizeWorkspaceName('ZahMon Cafe & Restaurant')).toBe('ZahMon Cafe & Restaurant')
    expect(sanitizeWorkspaceName('my/project:site*?')).toBe('my project site')
    expect(sanitizeWorkspaceName('  spaced  out  ')).toBe('spaced out')
    expect(sanitizeWorkspaceName('trailing dots...')).toBe('trailing dots')
    expect(sanitizeWorkspaceName('a'.repeat(200)).length).toBe(80)
  })

  it('falls back to a safe name for blank or reserved input', () => {
    expect(sanitizeWorkspaceName('')).toBe(FALLBACK_WORKSPACE_NAME)
    expect(sanitizeWorkspaceName('   ')).toBe(FALLBACK_WORKSPACE_NAME)
    expect(sanitizeWorkspaceName('///')).toBe(FALLBACK_WORKSPACE_NAME)
    expect(sanitizeWorkspaceName('CON')).toBe(FALLBACK_WORKSPACE_NAME)
    expect(sanitizeWorkspaceName('nul')).toBe(FALLBACK_WORKSPACE_NAME)
  })

  it('places and creates the named folder on the Desktop', async () => {
    expect(workspaceOnDesktop('/home/u/Desktop', 'Cafe Site')).toBe(join('/home/u/Desktop', 'Cafe Site'))
    const dir = await ensureWorkspaceOnDesktop('Cafe Site')
    expect(dir).toBe(join(DOCS, 'Cafe Site'))
    expect((await stat(dir)).isDirectory()).toBe(true)
  })
})
