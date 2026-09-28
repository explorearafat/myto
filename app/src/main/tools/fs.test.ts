import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  resolveInWorkspace,
  resolveInWorkspaceReal,
  fsAvailable,
  listDirTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool
} from './fs'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { FileSnapshot } from '../../shared/types'
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

describe('resolveInWorkspaceReal (symlink containment — CVE-2026-31990 class)', () => {
  // Create a symlink, or return false so the test can skip. On Windows a real
  // symlink needs Developer Mode or elevation, but an NTFS *junction* (directory
  // only) needs neither and `realpath` resolves it identically — so it exercises
  // the exact same escape vector. We fall back to a junction for dir links there;
  // a genuine failure is logged so the case never silently passes as a no-op.
  function trySymlink(target: string, linkPath: string, type: 'dir' | 'file'): boolean {
    const attempts: Array<'dir' | 'file' | 'junction'> =
      process.platform === 'win32' && type === 'dir' ? ['junction', 'dir'] : [type]
    for (const t of attempts) {
      try {
        symlinkSync(target, linkPath, t)
        return true
      } catch {
        // try the next strategy
      }
    }
    // eslint-disable-next-line no-console
    console.warn('[fs.test] skipping symlink case — OS refused symlink/junction creation')
    return false
  }

  it('refuses reading a file through a symlink that escapes the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'myto-fs-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'top secret')
    if (!trySymlink(outside, join(ROOT, 'link'), 'dir')) {
      rmSync(outside, { recursive: true, force: true })
      return
    }
    // Lexically "link/secret.txt" looks inside; the real path is outside.
    expect(await resolveInWorkspaceReal(ROOT, 'link/secret.txt')).toBeNull()
    const out = await readFileTool.run({ path: 'link/secret.txt' }, ctx())
    expect(out).toMatch(/outside the working folder/i)
    expect(out).not.toMatch(/top secret/)
    rmSync(outside, { recursive: true, force: true })
  })

  it('refuses writing through a symlinked directory that escapes, creating nothing outside', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'myto-fs-outside-'))
    if (!trySymlink(outside, join(ROOT, 'out'), 'dir')) {
      rmSync(outside, { recursive: true, force: true })
      return
    }
    const res = await writeFileTool.run({ path: 'out/evil.txt', content: 'x' }, ctx())
    expect(res).toMatch(/outside the working folder/i)
    expect(existsSync(join(outside, 'evil.txt'))).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })

  it('still allows a symlink that stays inside the workspace (follow-within-root)', async () => {
    mkdirSync(join(ROOT, 'real'))
    writeFileSync(join(ROOT, 'real', 'a.txt'), 'inside')
    if (!trySymlink(join(ROOT, 'real'), join(ROOT, 'alias'), 'dir')) return
    expect(await resolveInWorkspaceReal(ROOT, 'alias/a.txt')).not.toBeNull()
    expect(await readFileTool.run({ path: 'alias/a.txt' }, ctx())).toBe('inside')
  })

  it('allows writing a brand-new file whose parent really exists', async () => {
    mkdirSync(join(ROOT, 'sub'))
    expect(await resolveInWorkspaceReal(ROOT, 'sub/new.txt')).toBe(resolve(ROOT, 'sub/new.txt'))
  })

  it('still refuses .. traversal and absolute paths at the real layer', async () => {
    expect(await resolveInWorkspaceReal(ROOT, '../escape.txt')).toBeNull()
    const abs = process.platform === 'win32' ? 'C:/Windows/system32' : '/etc/passwd'
    expect(await resolveInWorkspaceReal(ROOT, abs)).toBeNull()
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
  it('points at write_file when the target does not exist yet (no opaque ENOENT)', async () => {
    const out = await editFileTool.run({ path: 'brand-new.ts', old: 'foo', new: 'bar' }, ctx())
    expect(out).toMatch(/does not exist yet/i)
    expect(out).toMatch(/write_file/)
    expect(out).not.toMatch(/ENOENT/)
  })
})

describe('utf8 round-trip (no encoding corruption)', () => {
  // Symptom #6 from the fix brief: "some written content had corrupted characters."
  // These are the exact glyphs a broken pipeline mangles — em/en dashes, curly quotes,
  // arrows, accents, CJK, and a multi-byte emoji (a surrogate pair). write_file must
  // persist them byte-for-byte and read_file must return them unchanged; this locks in
  // the finding that the fs path is utf8 end-to-end (the decode is stream-safe too).
  const TRICKY = 'em—dash, en–dash, "curly" ‘quotes’, arrow → café résumé, 日本語, 😀🎉'

  it('write_file then read_file returns multi-byte content byte-for-byte', async () => {
    const wrote = await writeFileTool.run({ path: 'u.txt', content: TRICKY }, ctx())
    expect(wrote).toMatch(/Wrote/)
    // On disk (independent of our own read tool) the bytes decode back to the original.
    expect(readFileSync(join(ROOT, 'u.txt'), 'utf8')).toBe(TRICKY)
    // And the read_file tool returns it unchanged — no mojibake, no replacement chars.
    const readBack = await readFileTool.run({ path: 'u.txt' }, ctx())
    expect(readBack).toBe(TRICKY)
    expect(readBack).not.toContain('�') // the U+FFFD replacement char = corruption
  })

  it('edit_file preserves surrounding multi-byte content around a replacement', async () => {
    await writeFileTool.run({ path: 'u.txt', content: `${TRICKY}\nMARKER\n${TRICKY}` }, ctx())
    const out = await editFileTool.run({ path: 'u.txt', old: 'MARKER', new: 'réplacé→😀' }, ctx())
    expect(out).toMatch(/1 replacement/)
    expect(readFileSync(join(ROOT, 'u.txt'), 'utf8')).toBe(`${TRICKY}\nréplacé→😀\n${TRICKY}`)
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

describe('onFileSnapshot capture (#1 checkpoints)', () => {
  // A ctx that records every snapshot the mutation tools emit.
  const captureCtx = (): { ctx: ToolContext; snaps: FileSnapshot[] } => {
    const snaps: FileSnapshot[] = []
    return {
      snaps,
      ctx: { ...ctx(), onFileSnapshot: (s) => snaps.push(s) }
    }
  }

  it('write_file emits a create snapshot (before=null, existed=false)', async () => {
    const { ctx: c, snaps } = captureCtx()
    await writeFileTool.run({ path: 'new.txt', content: 'hello' }, c)
    expect(snaps).toHaveLength(1)
    expect(snaps[0]).toMatchObject({
      path: resolve(ROOT, 'new.txt'),
      before: null,
      after: 'hello',
      kind: 'write',
      existed: false
    })
  })

  it('write_file emits an overwrite snapshot with the prior bytes (existed=true)', async () => {
    writeFileSync(join(ROOT, 'x.txt'), 'old')
    const { ctx: c, snaps } = captureCtx()
    await writeFileTool.run({ path: 'x.txt', content: 'new' }, c)
    expect(snaps[0]).toMatchObject({ before: 'old', after: 'new', kind: 'write', existed: true })
  })

  it('edit_file emits an edit snapshot carrying before + after', async () => {
    writeFileSync(join(ROOT, 'a.txt'), 'the quick brown fox')
    const { ctx: c, snaps } = captureCtx()
    await editFileTool.run({ path: 'a.txt', old: 'quick', new: 'slow' }, c)
    expect(snaps[0]).toMatchObject({
      before: 'the quick brown fox',
      after: 'the slow brown fox',
      kind: 'edit',
      existed: true
    })
  })

  it('delete_file emits a delete snapshot (after=null) with the prior bytes', async () => {
    writeFileSync(join(ROOT, 'gone.txt'), 'bye')
    const { ctx: c, snaps } = captureCtx()
    await deleteFileTool.run({ path: 'gone.txt' }, c)
    expect(snaps[0]).toMatchObject({ before: 'bye', after: null, kind: 'delete', existed: true })
  })

  it('does not emit a snapshot when the write is refused (outside the workspace)', async () => {
    const { ctx: c, snaps } = captureCtx()
    await writeFileTool.run({ path: '../escape.txt', content: 'x' }, c)
    expect(snaps).toHaveLength(0)
  })
})

