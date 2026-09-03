import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { contextManager } from '@main/context/manager'
import { readCacheKey, servedFromReadCache, updateReadCache } from '@main/workflow/readCache'
import type {
  ReadProposal,
  ReadResult,
  RunCommandProposal,
  WriteFileProposal,
  WriteFileResult
} from '@shared/types'

/**
 * Drives the in-run read-dedup helpers (Problem 1) against the REAL
 * {@link contextManager}, pointed at a throwaway project root — the same pattern
 * as `operations.test.ts`. Freshness assertions change file SIZE (not just mtime)
 * so they hold regardless of the filesystem's mtime resolution.
 */

let root: string
let originalRoot: string

beforeAll(() => {
  originalRoot = contextManager.getRoot()
  root = mkdtempSync(join(tmpdir(), 'sylor-readcache-'))
  contextManager.setRoot(root)
})

afterAll(() => {
  contextManager.setRoot(originalRoot)
  rmSync(root, { recursive: true, force: true })
})

// Each test gets a clean map; the singleton root is shared but files are per-test.
let cache: Map<string, string>
afterEach(() => {
  cache = new Map()
})
cache = new Map()

function readProp(path: string, offset?: number, limit?: number): ReadProposal {
  return {
    id: `r-${path}-${offset ?? ''}-${limit ?? ''}`,
    kind: 'read',
    op: 'read_file',
    path,
    offset,
    limit
  }
}
function readOk(path: string): ReadResult {
  return {
    id: `r-${path}`,
    kind: 'read',
    ok: true,
    output: 'file body',
    truncated: false,
    summary: '1 line'
  }
}
function writeProp(path: string, newContent: string): WriteFileProposal {
  return { id: `w-${path}`, kind: 'write_file', path, oldContent: '', newContent, exists: false }
}
function writeOk(path: string): WriteFileResult {
  return { id: `w-${path}`, kind: 'write_file', ok: true }
}

describe('servedFromReadCache / updateReadCache', () => {
  it('returns null on the first read, then a note on an identical repeat', () => {
    writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
    const p = readProp('a.ts')

    expect(servedFromReadCache(cache, p)).toBeNull()
    updateReadCache(cache, p, readOk('a.ts'))

    const served = servedFromReadCache(cache, p)
    expect(served).not.toBeNull()
    expect(served?.kind).toBe('read')
    expect(served?.ok).toBe(true)
    expect(served?.id).toBe(p.id)
    expect(served?.summary).toBe('already read (unchanged)')
    expect(served?.output).toContain('Already read')
    expect(served?.output).toContain('a.ts')
  })

  it('keys by line window — a different offset/limit is a distinct read', () => {
    writeFileSync(join(root, 'b.ts'), 'x\n'.repeat(50))
    const whole = readProp('b.ts')
    updateReadCache(cache, whole, readOk('b.ts'))

    // Same file, different window → not served from the whole-file entry.
    expect(servedFromReadCache(cache, readProp('b.ts', 10, 5))).toBeNull()
    // The original window is still served.
    expect(servedFromReadCache(cache, whole)).not.toBeNull()
  })

  it('forces a fresh read when the file size changes (stale eviction)', () => {
    const abs = join(root, 'c.ts')
    writeFileSync(abs, 'aaa')
    const p = readProp('c.ts')
    updateReadCache(cache, p, readOk('c.ts'))
    expect(servedFromReadCache(cache, p)).not.toBeNull()

    writeFileSync(abs, 'aaaaaaaaa') // different size → stamp differs
    expect(servedFromReadCache(cache, p)).toBeNull()
    // The stale entry was evicted, not left to mislead a later check.
    expect(cache.has(readCacheKey(root, 'c.ts', undefined, undefined))).toBe(false)
  })

  it('does not cache a media (image) read', () => {
    const p = readProp('pic.png')
    const mediaResult: ReadResult = {
      id: p.id,
      kind: 'read',
      ok: true,
      output: '(image)',
      truncated: false,
      summary: 'image',
      media: { kind: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }
    }
    updateReadCache(cache, p, mediaResult)
    expect(servedFromReadCache(cache, p)).toBeNull()
  })

  it('evicts every window of a path when it is written', () => {
    const abs = join(root, 'd.ts')
    writeFileSync(abs, 'export const d = 1\n')
    const whole = readProp('d.ts')
    const window = readProp('d.ts', 1, 10)
    updateReadCache(cache, whole, readOk('d.ts'))
    updateReadCache(cache, window, readOk('d.ts'))
    expect(servedFromReadCache(cache, whole)).not.toBeNull()

    // A write to the same path must drop BOTH cached windows so the next read is fresh.
    writeFileSync(abs, 'export const d = 2\n')
    updateReadCache(cache, writeProp('d.ts', 'export const d = 2\n'), writeOk('d.ts'))
    expect(servedFromReadCache(cache, whole)).toBeNull()
    expect(servedFromReadCache(cache, window)).toBeNull()
  })

  it('does not let a write to one path evict a same-prefix sibling', () => {
    writeFileSync(join(root, 'e.ts'), '1')
    writeFileSync(join(root, 'e.ts.bak'), '1')
    updateReadCache(cache, readProp('e.ts'), readOk('e.ts'))
    updateReadCache(cache, readProp('e.ts.bak'), readOk('e.ts.bak'))

    writeFileSync(join(root, 'e.ts'), '2')
    updateReadCache(cache, writeProp('e.ts', '2'), writeOk('e.ts'))

    // `e.ts` evicted, but `e.ts.bak` (which merely shares the `e.ts` prefix) survives.
    expect(servedFromReadCache(cache, readProp('e.ts'))).toBeNull()
    expect(servedFromReadCache(cache, readProp('e.ts.bak'))).not.toBeNull()
  })

  it('clears the whole cache after a command (it can touch anything)', () => {
    writeFileSync(join(root, 'f.ts'), '1')
    writeFileSync(join(root, 'g.ts'), '1')
    updateReadCache(cache, readProp('f.ts'), readOk('f.ts'))
    updateReadCache(cache, readProp('g.ts'), readOk('g.ts'))
    expect(cache.size).toBe(2)

    const cmd: RunCommandProposal = { id: 'cmd', kind: 'run_command', command: 'npm run build' }
    updateReadCache(cache, cmd, {
      id: 'cmd',
      kind: 'run_command',
      exitCode: 0,
      output: '',
      truncated: false
    })
    expect(cache.size).toBe(0)
    expect(servedFromReadCache(cache, readProp('f.ts'))).toBeNull()
  })

  it('ignores non-read ops in servedFromReadCache', () => {
    expect(servedFromReadCache(cache, writeProp('h.ts', 'x'))).toBeNull()
    const listing = readProp('.')
    listing.op = 'list_files'
    expect(servedFromReadCache(cache, listing)).toBeNull()
  })
})
