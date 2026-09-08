import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { contextManager } from '@main/context/manager'

/**
 * Full-PC access is read by `resolveSafe` through `fullAccessEnabled()`. We mock
 * that single seam so the sandbox can be toggled per-test without writing real
 * settings to disk. Default false — every existing sandbox test runs confined.
 */
let fullAccessFlag = false
vi.mock('@main/settings', async (importActual) => {
  const actual = await importActual<typeof import('@main/settings')>()
  return { ...actual, fullAccessEnabled: () => fullAccessFlag }
})
afterEach(() => {
  fullAccessFlag = false
})
import {
  applyEdit,
  applyEdits,
  EditMatchError,
  findFiles,
  listDirectory,
  PathEscapeError,
  proposeWrite,
  readFileSlice,
  readMediaFile,
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

  describe('full-PC access (sandbox off)', () => {
    it('lets an absolute path outside the root through', () => {
      fullAccessFlag = true
      const outside = process.platform === 'win32' ? 'C:\\Windows\\system32' : '/etc/passwd'
      // Confined, this throws PathEscapeError; with full access it resolves as-is.
      expect(resolveSafe(outside)).toBe(resolve(outside))
    })

    it('lets a parent-traversal path out of the root', () => {
      fullAccessFlag = true
      // `../escape.ts` resolves to the root's parent, no longer refused.
      expect(resolveSafe('../escape.ts')).toBe(resolve(root, '../escape.ts'))
    })

    it('still resolves a project-relative path against the root', () => {
      fullAccessFlag = true
      // Ordinary "src/foo.ts" keeps meaning "inside the project" — the switch only
      // stops REFUSING escapes, it doesn't change where relative paths anchor.
      expect(resolveSafe('src/foo.ts')).toBe(join(root, 'src', 'foo.ts'))
    })

    it('re-confines immediately when the switch is turned back off', () => {
      fullAccessFlag = false
      expect(() => resolveSafe('../escape.ts')).toThrow(PathEscapeError)
    })
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
    expect(out.output).toContain('4\tline4\n5\tline5')
    expect(out.summary).toBe('lines 4–5 of 10')
    // More file remains past the window — the model must be told, or it will
    // assume it has seen everything and edit against a partial picture.
    expect(out.truncated).toBe(true)
    // And told the ONE way to get it: the exact next offset. Anything vaguer ('ask
    // for a narrower range') is what turned one read into a run of keyholes.
    expect(out.output).toContain('stopped at line 5 of 10')
    expect(out.output).toContain('"offset": 6')
  })

  it('stops at a whole line when the char cap bites, and says which line', () => {
    // 40 lines × ~4k chars each overflows MAX_READ_CHARS (80k) around line 20, so
    // the summary must name the line the text really ended on — not line 40, which
    // is what the old clip-the-joined-string path claimed.
    const fat = Array.from({ length: 40 }, (_, i) => `${i + 1}:${'x'.repeat(4_000)}`).join('\n')
    writeProjectFile('look/fat.ts', fat)
    const out = readFileSlice('look/fat.ts')
    expect(out.truncated).toBe(true)
    const shown = out.summary.match(/^lines 1–(\d+) of 40$/)
    expect(shown).not.toBeNull()
    const shownEnd = Number(shown?.[1])
    expect(shownEnd).toBeGreaterThan(0)
    expect(shownEnd).toBeLessThan(40)
    // The last line present is whole (it ends in x, never mid-escape), and the tail
    // hands back the offset to resume from.
    expect(out.output).toContain(`${shownEnd}:${'x'.repeat(4_000)}`)
    expect(out.output).toContain('the rest would not fit in one read')
    expect(out.output).toContain(`"offset": ${shownEnd + 1}`)
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

describe('readMediaFile', () => {
  beforeAll(() => {
    // Raw writeFileSync (unlike writeProjectFile) does not create parent dirs.
    mkdirSync(join(root, 'media'), { recursive: true })
  })

  it('returns base64 bytes + a caption for an image, tagged with its MIME type', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    writeFileSync(join(root, 'media', 'tiny.png'), bytes)
    const out = readMediaFile('media/tiny.png')
    expect(out).not.toBeNull()
    expect(out?.media).toEqual({
      kind: 'image',
      mediaType: 'image/png',
      dataBase64: bytes.toString('base64')
    })
    expect(out?.summary).toContain('image')
    expect(out?.output).toContain('tiny.png')
    expect(out?.truncated).toBe(false)
  })

  it('maps .jpg and .jpeg both to image/jpeg, and .gif/.webp to their types', () => {
    writeFileSync(join(root, 'media', 'p.jpg'), Buffer.from([1]))
    writeFileSync(join(root, 'media', 'p.jpeg'), Buffer.from([2]))
    writeFileSync(join(root, 'media', 'p.gif'), Buffer.from([3]))
    writeFileSync(join(root, 'media', 'p.webp'), Buffer.from([4]))
    expect(readMediaFile('media/p.jpg')?.media?.mediaType).toBe('image/jpeg')
    expect(readMediaFile('media/p.jpeg')?.media?.mediaType).toBe('image/jpeg')
    expect(readMediaFile('media/p.gif')?.media?.mediaType).toBe('image/gif')
    expect(readMediaFile('media/p.webp')?.media?.mediaType).toBe('image/webp')
  })

  it('is case-insensitive about the extension', () => {
    writeFileSync(join(root, 'media', 'CAP.PNG'), Buffer.from([9]))
    expect(readMediaFile('media/CAP.PNG')?.media?.mediaType).toBe('image/png')
  })

  it('returns null for an ordinary text file so the caller reads it as text', () => {
    writeProjectFile('media/code.ts', 'const x = 1\n')
    expect(readMediaFile('media/code.ts')).toBeNull()
  })

  it('refuses an image past the size ceiling, with no bytes attached', () => {
    // 6 MB is over the 5 MB vision ceiling — a caption, not the bytes, comes back.
    writeFileSync(join(root, 'media', 'huge.png'), Buffer.alloc(6 * 1024 * 1024, 0))
    const out = readMediaFile('media/huge.png')
    expect(out?.media).toBeUndefined()
    expect(out?.summary).toBe('image too large')
  })

  it('recognises a PDF but returns a caption without bytes (not renderable)', () => {
    writeProjectFile('media/doc.pdf', '%PDF-1.4\n')
    const out = readMediaFile('media/doc.pdf')
    expect(out?.media).toBeUndefined()
    expect(out?.summary).toBe('pdf (not viewable)')
    expect(out?.output).toContain('PDF')
  })

  it('is sandbox-checked for an image path that escapes the root', () => {
    expect(() => readMediaFile('../outside.png')).toThrow(PathEscapeError)
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

describe('searchProject — context lines, multiline, and output modes', () => {
  beforeAll(() => {
    writeProjectFile(
      'ctx/story.ts',
      ['line one', 'MATCH here', 'line three', 'line four', 'line five', 'MATCH again', 'line seven'].join(
        '\n'
      )
    )
    writeProjectFile('ctx/multi.ts', 'function f() {\n  return 42\n}\n')
    writeProjectFile('ctx/counts-a.ts', 'foo\nfoo\nbar\n')
    writeProjectFile('ctx/counts-b.ts', 'foo\n')
  })

  it('prints trailing context (-A) with a dash separator for the context line', () => {
    const out = searchProject('MATCH here', 'ctx', undefined, { after: 1 })
    expect(out.output).toContain('ctx/story.ts:2: MATCH here')
    expect(out.output).toContain('ctx/story.ts:3- line three')
  })

  it('prints leading context (-B)', () => {
    const out = searchProject('MATCH here', 'ctx', undefined, { before: 1 })
    expect(out.output).toContain('ctx/story.ts:1- line one')
    expect(out.output).toContain('ctx/story.ts:2: MATCH here')
  })

  it('prints symmetric context (-C) and divides non-adjacent groups with --', () => {
    const out = searchProject('MATCH', 'ctx', undefined, { context: 1 })
    expect(out.output).toContain('ctx/story.ts:2: MATCH here')
    expect(out.output).toContain('ctx/story.ts:6: MATCH again')
    // The two hits are far apart, so a -- divider separates their context groups.
    expect(out.output).toContain('\n--\n')
  })

  it('matches a pattern that spans lines when multiline is set', () => {
    // `function … {  return` crosses a newline — a per-line grep would never see it.
    // Only ctx/multi.ts contains it, so searching the whole ctx dir isolates it.
    const out = searchProject('function f\\(\\)\\s*\\{\\s*return', 'ctx', undefined, {
      multiline: true
    })
    expect(out.summary).toBe('1 match in 1 file')
    expect(out.output).toContain('ctx/multi.ts:1')
  })

  it('mode "files" returns only the matching paths, sorted', () => {
    const out = searchProject('foo', 'ctx', undefined, { mode: 'files' })
    expect(out.output).toBe(['ctx/counts-a.ts', 'ctx/counts-b.ts'].join('\n'))
    expect(out.summary).toBe('2 files')
  })

  it('mode "count" tallies matches per file', () => {
    const out = searchProject('foo', 'ctx', undefined, { mode: 'count' })
    expect(out.output).toContain('ctx/counts-a.ts:2')
    expect(out.output).toContain('ctx/counts-b.ts:1')
    expect(out.summary).toBe('3 matches in 2 files')
  })

  it('with no options, output stays the plain per-line search (no -- separators)', () => {
    const out = searchProject('MATCH', 'ctx')
    expect(out.output).not.toContain('--')
    expect(out.output).toBe('ctx/story.ts:2: MATCH here\nctx/story.ts:6: MATCH again')
  })
})

describe('findFiles', () => {
  beforeAll(() => {
    writeProjectFile('find/src/app.ts', 'x')
    writeProjectFile('find/src/util.ts', 'x')
    writeProjectFile('find/src/app.test.ts', 'x')
    writeProjectFile('find/readme.md', 'x')
    writeProjectFile('find/src/deep/inner.ts', 'x')
    writeProjectFile('find/node_modules/dep/index.ts', 'x')
  })

  it('matches a basename glob at any depth, skipping ignored dirs, sorted', () => {
    const out = findFiles('*.ts', 'find')
    expect(out.output).toBe(
      ['find/src/app.test.ts', 'find/src/app.ts', 'find/src/deep/inner.ts', 'find/src/util.ts'].join('\n')
    )
    expect(out.output).not.toContain('node_modules')
    expect(out.output).not.toContain('readme.md')
    expect(out.summary).toBe('4 files')
    expect(out.truncated).toBe(false)
  })

  it('matches the project-relative path when the pattern has a slash', () => {
    const out = findFiles('find/src/*.ts', '.')
    expect(out.output).toBe(['find/src/app.test.ts', 'find/src/app.ts', 'find/src/util.ts'].join('\n'))
    // deep/inner.ts is one segment deeper, so a single-* segment glob excludes it.
    expect(out.output).not.toContain('inner.ts')
    expect(out.summary).toBe('3 files')
  })

  it('reports no matches plainly with a singular/plural-safe summary', () => {
    const out = findFiles('*.rs', 'find')
    expect(out.summary).toBe('no files')
    expect(out.output).toContain('No files match')
  })

  it('uses the singular noun for a single match', () => {
    expect(findFiles('util.ts', 'find').summary).toBe('1 file')
  })

  it('is sandbox-checked', () => {
    expect(() => findFiles('*.ts', '../outside')).toThrow(PathEscapeError)
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

describe('applyEdits', () => {
  const edit = (oldString: string, newString: string, replaceAll = false): {
    oldString: string
    newString: string
    replaceAll: boolean
  } => ({ oldString, newString, replaceAll })

  it('applies a sequence of edits in one pass, reading the file once', () => {
    writeProjectFile('edits/seq.ts', 'const a = 1\nconst b = 2\nconst c = 3\n')
    const { oldContent, newContent } = applyEdits('edits/seq.ts', [
      edit('const a = 1', 'const a = 10'),
      edit('const c = 3', 'const c = 30')
    ])
    expect(oldContent).toBe('const a = 1\nconst b = 2\nconst c = 3\n')
    expect(newContent).toBe('const a = 10\nconst b = 2\nconst c = 30\n')
    // Staging only — disk is untouched until the write_file proposal is approved.
    expect(readProjectFile('edits/seq.ts')).toBe('const a = 1\nconst b = 2\nconst c = 3\n')
  })

  it('lets a later edit target text an earlier edit introduced', () => {
    // Edits fold over the evolving content, not the original — so the second edit can
    // match what the first one just wrote.
    writeProjectFile('edits/chain.ts', 'value = OLD\n')
    const { newContent } = applyEdits('edits/chain.ts', [
      edit('OLD', 'MID'),
      edit('MID', 'NEW')
    ])
    expect(newContent).toBe('value = NEW\n')
  })

  it('honors replace_all per edit', () => {
    writeProjectFile('edits/all.ts', 'x = 1\ny = 2\nx = 1\n')
    const { newContent } = applyEdits('edits/all.ts', [edit('x = 1', 'x = 9', true)])
    expect(newContent).toBe('x = 9\ny = 2\nx = 9\n')
  })

  it('throws if any edit in the sequence misses, leaving nothing written', () => {
    writeProjectFile('edits/miss.ts', 'first\nsecond\n')
    expect(() =>
      applyEdits('edits/miss.ts', [edit('first', 'FIRST'), edit('nope', 'x')])
    ).toThrow(EditMatchError)
    expect(readProjectFile('edits/miss.ts')).toBe('first\nsecond\n')
  })

  it('refuses to edit a file that does not exist, pointing at write_file', () => {
    expect(() => applyEdits('edits/ghost.ts', [edit('a', 'b')])).toThrow(/does not exist/i)
  })

  it('is sandbox-checked', () => {
    expect(() => applyEdits('../outside.ts', [edit('a', 'b')])).toThrow(PathEscapeError)
  })
})
