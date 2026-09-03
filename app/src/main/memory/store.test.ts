import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore } from '@main/memory/store'

// Each test gets its own throwaway directory so the file-per-fact store is
// exercised against the real filesystem with zero cross-talk.
const dirs: string[] = []
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sylor-mem-'))
  dirs.push(d)
  return d
}
const ISO = '2026-09-01T00:00:00.000Z'

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('MemoryStore — remembering facts', () => {
  it('starts empty and records the first fact as a prompt bullet', () => {
    const store = new MemoryStore(freshDir())
    expect(store.list()).toEqual([])
    expect(store.asBullets()).toBe('')

    const res = store.remember('Prefers clean minimal sites', ISO)
    expect(res.added).toBe(true)
    expect(store.asBullets()).toBe('- Prefers clean minimal sites')
  })

  it('dedupes case-insensitively and rejects blank notes', () => {
    const store = new MemoryStore(freshDir())
    expect(store.remember('Prefers clean minimal sites', ISO).added).toBe(true)
    expect(store.remember('prefers CLEAN minimal sites', ISO).added).toBe(false)
    expect(store.remember('   ', ISO).added).toBe(false)
    expect(store.asBullets()).toBe('- Prefers clean minimal sites')
  })

  it('collapses inner whitespace and preserves insertion order', () => {
    const store = new MemoryStore(freshDir())
    store.remember('Prefers clean minimal sites', ISO)
    store.remember('Uses   a   serif\nfor headings', ISO)
    store.remember('Name is Arafat', ISO)
    expect(store.asBullets()).toBe(
      '- Prefers clean minimal sites\n- Uses a serif for headings\n- Name is Arafat'
    )
  })

  it('writes one frontmattered file per fact plus a MEMORY.md index', () => {
    const dir = freshDir()
    const store = new MemoryStore(dir)
    store.remember('Prefers dark mode', ISO)

    const files = readdirSync(dir).sort()
    expect(files).toContain('MEMORY.md')
    const factFile = files.find((f) => /^\d+-.*\.md$/.test(f) && f !== 'MEMORY.md')
    expect(factFile).toBe('0001-prefers-dark-mode.md')

    const contents = readFileSync(join(dir, factFile as string), 'utf-8')
    expect(contents).toContain('---')
    expect(contents).toContain('name: prefers-dark-mode')
    expect(contents).toContain(`created: ${ISO}`)
    expect(contents.trimEnd().endsWith('Prefers dark mode')).toBe(true)

    const index = readFileSync(join(dir, 'MEMORY.md'), 'utf-8')
    expect(index).toContain('# Sylor long-term memory')
    expect(index).toContain('1 fact remembered')
    expect(index).toContain('[Prefers dark mode](0001-prefers-dark-mode.md)')
  })

  it('reloads facts written by a previous store instance (files are the truth)', () => {
    const dir = freshDir()
    new MemoryStore(dir).remember('Ships offline-first desktop apps', ISO)
    // A brand-new instance over the same dir sees the persisted fact.
    expect(new MemoryStore(dir).asBullets()).toBe('- Ships offline-first desktop apps')
  })

  it('tolerates a hand-edited fact file with no frontmatter', () => {
    const dir = freshDir()
    writeFileSync(join(dir, '0001-handwritten.md'), 'A fact typed straight into the file\n', 'utf-8')
    expect(new MemoryStore(dir).asBullets()).toBe('- A fact typed straight into the file')
  })

  it('prunes the oldest facts past the cap', () => {
    const dir = freshDir()
    const store = new MemoryStore(dir, { maxFacts: 3 })
    for (const n of ['one', 'two', 'three', 'four']) store.remember(`fact ${n}`, ISO)
    expect(store.list().map((f) => f.text)).toEqual(['fact two', 'fact three', 'fact four'])
    // The pruned fact's file is gone from disk, not just the cache.
    expect(readdirSync(dir)).not.toContain('0001-fact-one.md')
  })

  it('gives colliding slugs distinct filenames', () => {
    const dir = freshDir()
    const store = new MemoryStore(dir)
    store.remember('Design system', ISO)
    store.remember('Design system!', ISO) // same slug base, different text
    const factFiles = readdirSync(dir).filter((f) => f !== 'MEMORY.md').sort()
    expect(factFiles).toEqual(['0001-design-system.md', '0002-design-system-2.md'])
  })
})

describe('MemoryStore — relevance recall', () => {
  const seed = (dir: string): MemoryStore => {
    const store = new MemoryStore(dir)
    store.remember('Prefers dark minimal UI with generous whitespace', ISO)
    store.remember('Runs vitest before every commit and never breaks the lint baseline', ISO)
    store.remember('Building an offline-first Electron desktop workspace', ISO)
    store.remember('Name is Arafat', ISO)
    return store
  }

  it('ranks the fact matching the query first', () => {
    const store = seed(freshDir())
    const hits = store.recall('how do I run the vitest suite', 2)
    expect(hits[0].text).toContain('vitest')
    expect(hits).toHaveLength(2)
  })

  it('fills the remainder with the most-recent facts when few match', () => {
    const store = seed(freshDir())
    // Only one fact mentions "electron"; the rest of the budget is recency-filled.
    const hits = store.recall('electron', 3)
    expect(hits[0].text).toContain('Electron')
    expect(hits).toHaveLength(3)
    // The newest fact ("Name is Arafat") is pulled in as filler.
    expect(hits.some((f) => f.text === 'Name is Arafat')).toBe(true)
  })

  it('falls back to the most-recent facts for a query with no usable tokens', () => {
    const store = seed(freshDir())
    const hits = store.recall('the and for', 2)
    expect(hits.map((f) => f.text)).toEqual([
      'Building an offline-first Electron desktop workspace',
      'Name is Arafat'
    ])
  })

  it('returns nothing from an empty store', () => {
    expect(new MemoryStore(freshDir()).recall('anything', 5)).toEqual([])
  })
})
