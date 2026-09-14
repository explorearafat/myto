import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { contextManager } from '@main/context/manager'
import {
  EVIDENCE_EXCERPT_MAX,
  hasCompleteRead,
  readCacheKey,
  readEvidence,
  recordEvidence,
  servedFromReadCache,
  updateReadCache
} from '@main/workflow/readCache'
import type { ReadCacheEntry } from '@main/workflow/readCache'
import type {
  Evidence,
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
let cache: Map<string, ReadCacheEntry>
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
/** A successful read. `truncated` is what decides the entry's `complete` flag. */
function readOk(path: string, truncated = false): ReadResult {
  return {
    id: `r-${path}`,
    kind: 'read',
    ok: true,
    output: 'file body',
    truncated,
    summary: truncated ? 'lines 1–10 of 999' : '1 line'
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
    expect(served?.output).toContain('already read')
    expect(served?.output).toContain('a.ts')
  })

  it('lets a COMPLETE whole-file read answer for a later window of the same file', () => {
    // The third read in the user's 13-step report was `Navbar.tsx · lines 1–70 of
    // 172`, after Navbar.tsx had already been read in full. Those 70 lines are
    // verbatim above in the conversation, so the window must be served, not re-read.
    writeFileSync(join(root, 'b.ts'), 'x\n'.repeat(50))
    const whole = readProp('b.ts')
    updateReadCache(cache, whole, readOk('b.ts'))

    expect(servedFromReadCache(cache, readProp('b.ts', 10, 5))).not.toBeNull()
    expect(servedFromReadCache(cache, readProp('b.ts', 1, 70))).not.toBeNull()
    expect(servedFromReadCache(cache, whole)).not.toBeNull()
  })

  it('lets a CLIPPED read serve its own window but never a continuation past it', () => {
    // A clipped read genuinely never showed the lines past its cut, so an offset
    // into them is a real continuation — the one honest reason to read a path twice.
    writeFileSync(join(root, 'big.ts'), 'x\n'.repeat(200))
    const first = readProp('big.ts')
    updateReadCache(cache, first, readOk('big.ts', true))

    expect(servedFromReadCache(cache, first)).not.toBeNull()
    expect(servedFromReadCache(cache, readProp('big.ts', 120))).toBeNull()
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

describe('hasCompleteRead', () => {
  it('is false before any read, true after a whole one, false after a clipped one', () => {
    writeFileSync(join(root, 'k.ts'), 'x\n'.repeat(20))
    expect(hasCompleteRead(cache, 'k.ts')).toBe(false)

    updateReadCache(cache, readProp('k.ts'), readOk('k.ts'))
    expect(hasCompleteRead(cache, 'k.ts')).toBe(true)

    const clipped = new Map<string, ReadCacheEntry>()
    updateReadCache(clipped, readProp('k.ts'), readOk('k.ts', true))
    // Clipped → the next `offset` is a continuation, so `planReadWindow` must honour
    // it rather than forcing another whole-file read that would clip identically.
    expect(hasCompleteRead(clipped, 'k.ts')).toBe(false)
  })

  it('is false again once the file changes on disk', () => {
    const abs = join(root, 'l.ts')
    writeFileSync(abs, 'one')
    updateReadCache(cache, readProp('l.ts'), readOk('l.ts'))
    expect(hasCompleteRead(cache, 'l.ts')).toBe(true)

    writeFileSync(abs, 'one two three')
    expect(hasCompleteRead(cache, 'l.ts')).toBe(false)
  })

  it('does not count a WINDOWED read as having read the whole file', () => {
    writeFileSync(join(root, 'm.ts'), 'x\n'.repeat(20))
    updateReadCache(cache, readProp('m.ts', 5, 5), readOk('m.ts'))
    expect(hasCompleteRead(cache, 'm.ts')).toBe(false)
  })
})

/**
 * Evidence capture (Principle 3): turning a real read into the bounded record a
 * downstream agent inherits so it builds on the exact text instead of re-reading.
 * Pure over (proposal, result) — no disk or contextManager needed.
 */
function readBody(path: string, output: string, offset?: number): ReadResult {
  return { id: readProp(path, offset).id, kind: 'read', ok: true, output, truncated: false, summary: '' }
}

describe('readEvidence', () => {
  it('anchors a whole-file read at line 1 and spans every line it saw', () => {
    const ev = readEvidence(readProp('a.ts'), readBody('a.ts', 'one\ntwo\nthree'))
    expect(ev).not.toBeNull()
    expect(ev?.path).toBe('a.ts')
    expect(ev?.range).toEqual([1, 3])
    expect(ev?.excerpt).toBe('one\ntwo\nthree')
  })

  it('anchors a windowed read at its offset', () => {
    const ev = readEvidence(readProp('a.ts', 40, 10), readBody('a.ts', 'x\ny\nz', 40))
    expect(ev?.range).toEqual([40, 42])
  })

  it('gives identical content the same sha and different content a different one', () => {
    const a = readEvidence(readProp('a.ts'), readBody('a.ts', 'same body'))
    const b = readEvidence(readProp('b.ts'), readBody('b.ts', 'same body'))
    const c = readEvidence(readProp('c.ts'), readBody('c.ts', 'other body'))
    expect(a?.sha).toBe(b?.sha)
    expect(a?.sha).not.toBe(c?.sha)
  })

  it('clamps the excerpt to EVIDENCE_EXCERPT_MAX but keeps the full seen span', () => {
    const body = 'L\n'.repeat(2_000) // ~4 000 chars, 2 000 lines
    const ev = readEvidence(readProp('big.ts'), readBody('big.ts', body))
    expect(ev?.excerpt.length).toBeLessThanOrEqual(EVIDENCE_EXCERPT_MAX + 1) // +1 for the ellipsis
    expect(ev?.excerpt.endsWith('…')).toBe(true)
    // The range still reflects every line the reader saw, before the excerpt was cut.
    expect(ev?.range).toEqual([1, 2_001])
  })

  it('returns null for anything that is not a usable text read', () => {
    // a non-read op
    expect(readEvidence(writeProp('a.ts', 'x'), writeOk('a.ts'))).toBeNull()
    // a listing that rode the read rails
    const listing = readProp('.')
    listing.op = 'list_files'
    expect(readEvidence(listing, readBody('.', 'a.ts\nb.ts'))).toBeNull()
    // a failed read
    expect(
      readEvidence(readProp('a.ts'), {
        id: 'x',
        kind: 'read',
        ok: false,
        output: '',
        truncated: false,
        summary: '',
        error: 'nope'
      })
    ).toBeNull()
    // a media (image) read
    expect(
      readEvidence(readProp('pic.png'), {
        id: 'x',
        kind: 'read',
        ok: true,
        output: '(image)',
        truncated: false,
        summary: 'image',
        media: { kind: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }
      })
    ).toBeNull()
    // an empty / whitespace-only file
    expect(readEvidence(readProp('empty.ts'), readBody('empty.ts', '   \n  '))).toBeNull()
  })
})

describe('recordEvidence', () => {
  const mk = (path: string, range: [number, number], sha: string): Evidence => ({
    path,
    range,
    sha,
    excerpt: `${path}@${sha}`
  })

  it('keeps one record per path+range, newest wins', () => {
    const ledger: Evidence[] = []
    recordEvidence(ledger, mk('a.ts', [1, 10], 'aaa'))
    recordEvidence(ledger, mk('a.ts', [1, 10], 'bbb')) // same span, re-read
    recordEvidence(ledger, mk('a.ts', [20, 30], 'ccc')) // different span, kept
    expect(ledger).toHaveLength(2)
    expect(ledger[0].sha).toBe('bbb')
    expect(ledger[0].excerpt).toBe('a.ts@bbb')
  })

  it('caps the ledger, dropping the oldest first', () => {
    const ledger: Evidence[] = []
    for (let i = 1; i <= 20; i++) recordEvidence(ledger, mk('f.ts', [i, i], `s${i}`))
    expect(ledger).toHaveLength(16) // MAX_EVIDENCE_PER_NODE
    expect(ledger[0].range).toEqual([5, 5]) // 1..4 dropped as oldest
    expect(ledger[ledger.length - 1].range).toEqual([20, 20])
  })
})
