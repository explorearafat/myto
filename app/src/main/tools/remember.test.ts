import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rememberTool } from './remember'
import { __setUserMemoryDirForTest } from '../user-memory'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { ToolContext } from './registry'

/**
 * `remember` writes to two file-based stores: the injected global memory dir (user
 * scope) and the Cowork working folder's `.myto/journal.md` (project scope). Both get
 * a throwaway temp dir here.
 */
const ROOT = mkdtempSync(join(tmpdir(), 'myto-remember-'))
const MEM = join(ROOT, 'userdata')
const WORK = join(ROOT, 'work')

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

const ctx = (workspaceDir: string | null = WORK): ToolContext => ({
  settings: DEFAULT_PROVIDER_SETTINGS,
  mode: 'cowork',
  workspaceDir,
  signal: new AbortController().signal
})

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(MEM, { recursive: true })
  mkdirSync(WORK, { recursive: true })
  __setUserMemoryDirForTest(MEM)
})

describe('remember tool', () => {
  it('never triggers an approval prompt (writes only Myto memory, not the project)', () => {
    expect(rememberTool.sideEffect).toBeUndefined()
  })

  it('is always available when tools are on', () => {
    expect(rememberTool.available({ settings: DEFAULT_PROVIDER_SETTINGS, mode: 'chat', workspaceDir: null })).toBe(
      true
    )
  })

  it('needs a non-empty fact', async () => {
    expect(await rememberTool.run({}, ctx())).toMatch(/needs a non-empty "fact"/i)
    expect(await rememberTool.run({ fact: '   ' }, ctx())).toMatch(/needs a non-empty "fact"/i)
  })

  it('defaults to user (global) memory', async () => {
    const out = await rememberTool.run({ fact: 'The user prefers pnpm' }, ctx())
    expect(out).toMatch(/Remembered globally/)
    expect(readFileSync(join(MEM, 'memory.md'), 'utf8')).toMatch(/The user prefers pnpm/)
  })

  it('writes to the project journal for scope "project"', async () => {
    const out = await rememberTool.run({ fact: 'API base is /v2', scope: 'project' }, ctx())
    expect(out).toMatch(/Remembered for this project/)
    expect(readFileSync(join(WORK, '.myto', 'journal.md'), 'utf8')).toMatch(/note: API base is \/v2/)
    // A project note must NOT leak into global memory.
    expect(existsSync(join(MEM, 'memory.md'))).toBe(false)
  })

  it('falls back to global memory for scope "project" with no working folder', async () => {
    const out = await rememberTool.run({ fact: 'orphan note', scope: 'project' }, ctx(null))
    expect(out).toMatch(/global memory instead/i)
    expect(readFileSync(join(MEM, 'memory.md'), 'utf8')).toMatch(/orphan note/)
  })

  it('reports when global memory is unavailable', async () => {
    __setUserMemoryDirForTest(null)
    expect(await rememberTool.run({ fact: 'nowhere' }, ctx())).toMatch(/could not save/i)
  })
})
