import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { contextManager } from '@main/context/manager'
import {
  applyEdit,
  EditMatchError,
  listDirectory,
  PathEscapeError,
  proposeWrite,
  readFileSlice,
  readProjectFile,
  resolveSafe,
  searchProject,
  writeProjectFile
} from '@main/fs/operations'

/**
 * These exercise the sandbox against a throwaway project root. The fs operations
 * layer resolves everything relative to `contextManager.getRoot()`, so we point
 * the singleton at a temp dir for the duration of the suite and restore it after.
 */
let root: string
let originalRoot: string

beforeAll(() => {
  originalRoot = contextManager.getRoot()
  root = mkdtempSync(join(tmpdir(), 'sylor-fs-'))
  contextManager.setRoot(root)
})

afterAll(() => {
  contextManager.setRoot(originalRoot)
  rmSync(root, { recursive: true, force: true })
})

describe('resolveSafe (sandbox boundary)', () => {
  it('resolves a project-relative path to an absolute path inside the root', () => {
    const abs = resolveSafe('src/foo.ts')
    expect(abs).toBe(join(root, 'src', 'foo.ts'))
  })

  it('rejects a parent-traversal path that escapes the root', () => {
    expect(() => resolveSafe('../escape.ts')).toThrow(PathEscapeError)
  })

  it('rejects a deep traversal that climbs out of the root', () => {
    expect(() => resolveSafe('src/../../escape.ts')).toThrow(PathEscapeError)
  })

  it('rejects an absolute path outside the root', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\system32' : '/etc/passwd'
    expect(() => resolveSafe(outside)).toThrow(PathEscapeError)
  })

  it('allows an absolute path that is already within the root', () => {
    const inside = join(root, 'nested', 'file.ts')
    expect(resolveSafe(inside)).toBe(inside)
  })

  it('normalises interior traversal that stays within the root', () => {
    expect(resolveSafe('a/b/../c.ts')).toBe(join(root, 'a', 'c.ts'))
  })

  it('rejects a path that escapes through a symlink inside the root', () => {
    // The lexical check alone is fooled by a symlink inside the root that points
    // outside it; the realpath gate must catch it. Symlink creation needs elevated
    // privileges on Windows, so skip cleanly when the OS refuses.
    const outside = mkdtempSync(join(tmpdir(), 'sylor-outside-'))
    const link = join(root, 'link-out')
    let linked = false
    try {
      symlinkSync(outside, link, 'dir')
      linked = true
    } catch {
      // Insufficient privileges (typical on Windows without Developer Mode) — skip.
    }
    if (!linked) return
    try {
      // Lexically "link-out/evil.ts" sits inside the root, but it resolves through
      // the symlink to an out-of-root location.
      expect(() => resolveSafe('link-out/evil.ts')).toThrow(PathEscapeError)
      // An escape via an EXISTING file behind the symlink is caught too.
      writeFileSync(join(outside, 'real.ts'), 'secret')
      expect(() => resolveSafe('link-out/real.ts')).toThrow(PathEscapeError)
    } finally {
      rmSync(link, { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('still allows a real subdirectory that is not a symlink', () => {
    mkdirSync(join(root, 'realdir'), { recursive: true })
    expect(resolveSafe('realdir/ok.ts')).toBe(join(root, 'realdir', 'ok.ts'))
  })
})

describe('writeProjectFile / readProjectFile', () => {
  it('round-trips content, creating parent directories', () => {
    writeProjectFile('deep/nested/dir/hello.txt', 'hi there')
    expect(existsSync(join(root, 'deep', 'nested', 'dir', 'hello.txt'))).toBe(true)
    expect(readProjectFile('deep/nested/dir/hello.txt')).toBe('hi there')
  })

  it('overwrites an existing file', () => {
    writeProjectFile('over.txt', 'first')
    writeProjectFile('over.txt', 'second')
    expect(readProjectFile('over.txt')).toBe('second')
  })

  it('refuses to write outside the sandbox', () => {
    expect(() => writeProjectFile('../evil.txt', 'nope')).toThrow(PathEscapeError)
    expect(existsSync(join(root, '..', 'evil.txt'))).toBe(false)
  })
})

describe('proposeWrite', () => {
  it('reports a new file: exists=false, empty old content, echoed new content', () => {
    const proposal = proposeWrite('brand-new.ts', 'export const x = 1')
    expect(proposal.exists).toBe(false)
    expect(proposal.oldContent).toBe('')
    expect(proposal.newContent).toBe('export const x = 1')
    // proposeWrite must NOT touch disk.
    expect(existsSync(join(root, 'brand-new.ts'))).toBe(false)
  })

  it('reports an existing file: exists=true with current content as old', () => {
    writeFileSync(join(root, 'existing.ts'), 'old body')
    const proposal = proposeWrite('existing.ts', 'new body')
    expect(proposal.exists).toBe(true)
    expect(proposal.oldContent).toBe('old body')
    expect(proposal.newContent).toBe('new body')
    // Unchanged on disk until an actual write.
    expect(readFileSync(join(root, 'existing.ts'), 'utf-8')).toBe('old body')
  })

  it('throws on a sandbox escape before reading anything', () => {
    expect(() => proposeWrite('../../secret.ts', 'x')).toThrow(PathEscapeError)
  })
})

/**
 * Project inspection — the tools that let the agent work on code it did NOT just
 * write. Each is scoped to its own subdirectory so the suite stays independent of
 * what the earlier describes left lying in the shared temp root.
 */
describe('readFileSlice', () => {
  it('numbers every line and reports the total', () => {
    writeProjectFile('look/three.ts', 'one\ntwo\nthree\n')
    const out = readFileSlice('look/three.ts')
    expect(out.output).toBe('1\tone\n2\ttwo\n3\tthree')
    expect(out.summary).toBe('3 lines')
    expect(out.truncated).toBe(false)
  })

  it('windows by offset/limit, numbering from the real line and flagging the rest', () => {
    writeProjectFile('look/ten.ts', Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'))
    const out = readFileSlice('look/ten.ts', 4, 2)
    expect(out.output).toBe('4\tline4\n5\tline5')
    expect(out.summary).toBe('lines 4–5 of 10')
    // More file remains past the window — the model must be told, or it will
    // assume it has seen everything and edit against a partial picture.
    expect(out.truncated).toBe(true)
  })

  it('says so for an empty file rather than returning nothing', () => {
    writeProjectFile('look/empty.ts', '')
    expect(readFileSlice('look/empty.ts').output).toBe('(empty file)')
  })

  it('refuses to dump a binary file as text', () => {
    writeProjectFile('look/blob.bin', 'MZ\0\0\0binary')
    expect(readFileSlice('look/blob.bin').summary).toBe('binary file')
  })

  it('is sandbox-checked', () => {
    expect(() => readFileSlice('../outside.ts')).toThrow(PathEscapeError)
  })
})

describe('listDirectory', () => {
  it('lists folders first, then files with sizes, skipping build/vendor noise', () => {
    writeProjectFile('ls/b.ts', 'xx')
    writeProjectFile('ls/a.ts', 'x')
    writeProjectFile('ls/sub/nested.ts', 'x')
    writeProjectFile('ls/node_modules/pkg/index.js', 'x')
    const out = listDirectory('ls')
    expect(out.output).toBe('sub/\na.ts  (1 B)\nb.ts  (2 B)')
    expect(out.output).not.toContain('node_modules')
    expect(out.summary).toBe('1 folder, 2 files')
  })

  it('says so for an empty directory', () => {
    mkdirSync(join(root, 'ls-empty'), { recursive: true })
    expect(listDirectory('ls-empty').output).toBe('(empty directory)')
  })
})

describe('searchProject', () => {
  beforeAll(() => {
    writeProjectFile('grep/a.ts', 'export const useAuth = 1\nconst other = 2\n')
    writeProjectFile('grep/b.tsx', 'import { useAuth } from "./a"\n')
    writeProjectFile('grep/notes.md', 'useAuth is documented here\n')
    writeProjectFile('grep/lit.ts', 'a[b(c\n')
    writeProjectFile('grep/node_modules/dep/index.js', 'useAuth in a dependency\n')
  })

  it('returns path:line: text hits and counts files, skipping ignored dirs', () => {
    const out = searchProject('useAuth', 'grep')
    expect(out.output).toContain('grep/a.ts:1: export const useAuth = 1')
    expect(out.output).toContain('grep/b.tsx:1: import { useAuth } from "./a"')
    expect(out.output).not.toContain('node_modules')
    expect(out.summary).toBe('3 matches in 3 files')
  })

  it('narrows by glob, matching the basename when the pattern has no slash', () => {
    const out = searchProject('useAuth', 'grep', '*.tsx')
    expect(out.output).toContain('grep/b.tsx:1')
    expect(out.output).not.toContain('grep/a.ts')
    expect(out.summary).toBe('1 match in 1 file')
  })

  it('treats the query as a regular expression', () => {
    expect(searchProject('const \\w+ = \\d', 'grep').summary).toBe('2 matches in 1 file')
  })

  it('does not throw on an unparseable regex — falls back to a literal match', () => {
    const out = searchProject('a[b(c', 'grep')
    expect(out.output).toContain('grep/lit.ts:1')
  })

  it('reports no matches plainly', () => {
    const out = searchProject('zzz-nothing-here', 'grep')
    expect(out.summary).toBe('no matches')
    expect(out.output).toContain('No matches')
  })
})

describe('applyEdit', () => {
  it('replaces a unique occurrence and leaves disk untouched', () => {
    writeProjectFile('edit/one.ts', 'const a = 1\nconst b = 2\n')
    const { oldContent, newContent } = applyEdit('edit/one.ts', 'const b = 2', 'const b = 99')
    expect(oldContent).toBe('const a = 1\nconst b = 2\n')
    expect(newContent).toBe('const a = 1\nconst b = 99\n')
    // Staging only — the engine turns this into a write_file proposal to approve.
    expect(readProjectFile('edit/one.ts')).toBe('const a = 1\nconst b = 2\n')
  })

  it('deletes text when new_string is empty', () => {
    writeProjectFile('edit/del.ts', 'keep\nremove me\n')
    expect(applyEdit('edit/del.ts', 'remove me\n', '').newContent).toBe('keep\n')
  })

  it('inserts a replacement containing $& literally, not as a substitution pattern', () => {
    // String.replace would expand `$&` to the matched text and corrupt the file;
    // the splice must treat it as ordinary characters.
    writeProjectFile('edit/dollar.ts', 'price = X\n')
    expect(applyEdit('edit/dollar.ts', 'X', '"$& $1 $`"').newContent).toBe('price = "$& $1 $`"\n')
  })

  it('refuses an old_string that is not in the file, and says why', () => {
    writeProjectFile('edit/miss.ts', 'actual contents\n')
    expect(() => applyEdit('edit/miss.ts', 'imagined contents', 'x')).toThrow(EditMatchError)
    // The message is written for the model: it must name the line-number trap,
    // which is the single most common way an edit misses.
    expect(() => applyEdit('edit/miss.ts', 'imagined contents', 'x')).toThrow(/line numbers/i)
  })

  it('refuses an ambiguous match rather than picking one', () => {
    writeProjectFile('edit/dup.ts', 'x = 1\ny = 2\nx = 1\n')
    expect(() => applyEdit('edit/dup.ts', 'x = 1', 'x = 9')).toThrow(/more than once/i)
  })

  it('replaces every occurrence when replace_all is set', () => {
    writeProjectFile('edit/all.ts', 'x = 1\ny = 2\nx = 1\n')
    expect(applyEdit('edit/all.ts', 'x = 1', 'x = 9', true).newContent).toBe('x = 9\ny = 2\nx = 9\n')
  })

  it('refuses to edit a file that does not exist, pointing at write_file', () => {
    expect(() => applyEdit('edit/ghost.ts', 'a', 'b')).toThrow(/does not exist/i)
  })

  it('is sandbox-checked', () => {
    expect(() => applyEdit('../outside.ts', 'a', 'b')).toThrow(PathEscapeError)
  })
})
