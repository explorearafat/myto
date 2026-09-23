import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  resolveInWorkspace,
  fsAvailable,
  listDirTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool
} from './fs'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { ToolContext } from './registry'

// A real temp folder is the Cowork workspace for these tests; each test resets it.
const ROOT = mkdtempSync(join(tmpdir(), 'myto-fs-test-'))

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

/** A cowork ToolContext scoped to the temp workspace. */
const ctx = (workspaceDir: string | null = ROOT): ToolContext => ({
  settings: DEFAULT_PROVIDER_SETTINGS,
  mode: 'cowork',
  workspaceDir,
  signal: new AbortController().signal
})

beforeEach(() => {
  // Wipe and recreate the workspace so tests don't see each other's files.
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})

describe('resolveInWorkspace (sandbox)', () => {
  it('resolves a child path to an absolute path inside the root', () => {
    expect(resolveInWorkspace(ROOT, 'a/b.txt')).toBe(resolve(ROOT, 'a/b.txt'))
  })
  it('resolves the root itself for "." ', () => {
    expect(resolveInWorkspace(ROOT, '.')).toBe(resolve(ROOT))
  })
  it('refuses a parent traversal', () => {
    expect(resolveInWorkspace(ROOT, '../escape.txt')).toBeNull()
    expect(resolveInWorkspace(ROOT, 'a/../../escape.txt')).toBeNull()
  })
  it('refuses an absolute path', () => {
    const abs = process.platform === 'win32' ? 'C:/Windows/system32' : '/etc/passwd'
    expect(resolveInWorkspace(ROOT, abs)).toBeNull()
  })
  it('refuses when there is no workspace', () => {
    expect(resolveInWorkspace('', 'a.txt')).toBeNull()
  })
})

describe('fsAvailable', () => {
  const base = { settings: DEFAULT_PROVIDER_SETTINGS }
  it('is true only in cowork mode with a non-empty workspace', () => {
    expect(fsAvailable({ ...base, mode: 'cowork', workspaceDir: ROOT })).toBe(true)
    expect(fsAvailable({ ...base, mode: 'cowork', workspaceDir: '' })).toBe(false)
    expect(fsAvailable({ ...base, mode: 'cowork', workspaceDir: null })).toBe(false)
    expect(fsAvailable({ ...base, mode: 'chat', workspaceDir: ROOT })).toBe(false)
  })
})

describe('list_dir', () => {
  it('lists files and folders, marking directories', async () => {
    mkdirSync(join(ROOT, 'src'))
    writeFileSync(join(ROOT, 'readme.md'), '# hi')
    const out = await listDirTool.run({ path: '.' }, ctx())
    expect(out).toMatch(/\[dir\] src/)
    expect(out).toMatch(/readme\.md/)
  })
  it('reports an empty folder', async () => {
    const out = await listDirTool.run({ path: '.' }, ctx())
    expect(out).toMatch(/empty/i)
  })
  it('refuses a path outside the workspace', async () => {
    const out = await listDirTool.run({ path: '..' }, ctx())
    expect(out).toMatch(/outside the working folder/i)
  })
})

describe('read_file', () => {
  it('returns file contents', async () => {
    writeFileSync(join(ROOT, 'a.txt'), 'hello world')
    expect(await readFileTool.run({ path: 'a.txt' }, ctx())).toBe('hello world')
  })
  it('returns a message for a missing file', async () => {
    expect(await readFileTool.run({ path: 'nope.txt' }, ctx())).toMatch(/read_file failed/i)
  })
  it('needs a path', async () => {
    expect(await readFileTool.run({}, ctx())).toMatch(/needs a JSON input/i)
  })
  it('refuses a path outside the workspace', async () => {
    expect(await readFileTool.run({ path: '../a.txt' }, ctx())).toMatch(/outside the working folder/i)
  })
})

describe('write_file', () => {
  it('creates a file, making parent folders', async () => {
    const out = await writeFileTool.run({ path: 'deep/nested/x.txt', content: 'data' }, ctx())
    expect(out).toMatch(/Wrote 4 characters/)
    expect(readFileSync(join(ROOT, 'deep/nested/x.txt'), 'utf8')).toBe('data')
  })
  it('overwrites an existing file', async () => {
    writeFileSync(join(ROOT, 'x.txt'), 'old')
    await writeFileTool.run({ path: 'x.txt', content: 'new' }, ctx())
    expect(readFileSync(join(ROOT, 'x.txt'), 'utf8')).toBe('new')
  })
  it('needs content', async () => {
    expect(await writeFileTool.run({ path: 'x.txt' }, ctx())).toMatch(/needs a "content" string/i)
  })
  it('refuses to write outside the workspace and creates nothing there', async () => {
    const out = await writeFileTool.run({ path: '../escape.txt', content: 'x' }, ctx())
    expect(out).toMatch(/outside the working folder/i)
    expect(existsSync(join(ROOT, '..', 'escape.txt'))).toBe(false)
  })
})

describe('edit_file', () => {
  it('replaces a unique snippet', async () => {
    writeFileSync(join(ROOT, 'a.txt'), 'the quick brown fox')
    const out = await editFileTool.run({ path: 'a.txt', old: 'quick', new: 'slow' }, ctx())
    expect(out).toMatch(/Edited a\.txt \(1 replacement\)/)
    expect(readFileSync(join(ROOT, 'a.txt'), 'utf8')).toBe('the slow brown fox')
  })
  it('reports when the old text is not found', async () => {
    writeFileSync(join(ROOT, 'a.txt'), 'hello')
    expect(await editFileTool.run({ path: 'a.txt', old: 'xyz', new: 'q' }, ctx())).toMatch(
      /was not found/i
    )
  })
  it('refuses a non-unique snippet unless all is set', async () => {
    writeFileSync(join(ROOT, 'a.txt'), 'a a a')
    const out = await editFileTool.run({ path: 'a.txt', old: 'a', new: 'b' }, ctx())
    expect(out).toMatch(/appears 3 times/i)
    // With all: replaces every occurrence.
    const all = await editFileTool.run({ path: 'a.txt', old: 'a', new: 'b', all: true }, ctx())
    expect(all).toMatch(/3 replacements/)
    expect(readFileSync(join(ROOT, 'a.txt'), 'utf8')).toBe('b b b')
  })
  it('needs old and new strings', async () => {
    writeFileSync(join(ROOT, 'a.txt'), 'x')
    expect(await editFileTool.run({ path: 'a.txt', old: 'x' }, ctx())).toMatch(/needs/i)
  })
})

describe('delete_file', () => {
  it('deletes a file inside the workspace', async () => {
    writeFileSync(join(ROOT, 'scratch.py'), 'print(1)')
    const out = await deleteFileTool.run({ path: 'scratch.py' }, ctx())
    expect(out).toMatch(/Deleted scratch\.py/)
    expect(existsSync(join(ROOT, 'scratch.py'))).toBe(false)
  })
  it('refuses a path outside the workspace', async () => {
    expect(await deleteFileTool.run({ path: '../x.txt' }, ctx())).toMatch(/outside the working folder/i)
  })
  it('refuses to delete the workspace root', async () => {
    expect(await deleteFileTool.run({ path: '.' }, ctx())).toMatch(/refusing to delete the working folder/i)
  })
})
