import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  emptyIndex,
  INDEX_VERSION,
  indexPath,
  loadIndex,
  readHead,
  saveIndex,
  summarizeSource,
  type ProjectIndex
} from '@main/context/projectIndex'

/**
 * Covers the structural summariser (deterministic, no model calls — Problem 1's
 * "cheap, free" index) and the JSON persistence round-trip / freshness handling.
 */

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sylor-index-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('summarizeSource — code', () => {
  it('extracts exports and imports from a TS module', () => {
    const src = [
      `import { readFileSync } from 'node:fs'`,
      `import React from 'react'`,
      ``,
      `export function alpha() {}`,
      `export class Beta {}`,
      `export const gamma = 1`,
      `export interface Delta {}`
    ].join('\n')
    const { summary, symbols } = summarizeSource('src/mod.ts', src)
    expect(summary).toContain('exports: ')
    expect(symbols).toEqual(['alpha', 'Beta', 'gamma', 'Delta'])
    expect(summary).toContain('alpha')
    expect(summary).toContain('imports: ')
    expect(summary).toContain('node:fs')
    expect(summary).toContain('react')
  })

  it('leads with the doc comment when present', () => {
    const src = ['/**', ' * The widget factory.', ' */', 'export const make = () => 1'].join('\n')
    const { summary } = summarizeSource('factory.ts', src)
    expect(summary.startsWith('The widget factory.')).toBe(true)
    expect(summary).toContain('exports: make')
  })

  it('captures named re-export groups (with `as` aliases)', () => {
    const src = `export { foo, bar as baz } from './x'`
    const { symbols } = summarizeSource('reexport.ts', src)
    expect(symbols).toContain('foo')
    expect(symbols).toContain('baz')
    expect(symbols).not.toContain('bar')
  })

  it('records a default export', () => {
    const src = `export default function App() {}`
    const { symbols } = summarizeSource('App.tsx', src)
    // `export default function App` matches the declaration form → the name wins.
    expect(symbols).toContain('App')
  })

  it('falls back to the first non-empty line for code with no exports', () => {
    const src = ['', '   ', 'const local = 42', 'doThing(local)'].join('\n')
    const { summary, symbols } = summarizeSource('script.js', src)
    expect(summary).toBe('const local = 42')
    expect(symbols).toEqual([])
  })
})

describe('summarizeSource — markdown / json / generic', () => {
  it('lists the top headings of a markdown file', () => {
    const src = ['# Title', 'blah', '## Section A', '### Sub', 'text'].join('\n')
    const { summary, symbols } = summarizeSource('README.md', src)
    expect(summary).toContain('headings: ')
    expect(summary).toContain('Title')
    expect(summary).toContain('Section A')
    expect(symbols).toEqual(['Title', 'Section A', 'Sub'])
  })

  it('lists the top-level keys of a JSON object', () => {
    const src = JSON.stringify({ name: 'x', version: '1.0.0', scripts: {} })
    const { summary, symbols } = summarizeSource('package.json', src)
    expect(summary).toContain('keys: ')
    expect(symbols).toEqual(['name', 'version', 'scripts'])
  })

  it('degrades to the first line for a JSON array (not an object)', () => {
    const src = '[1, 2, 3]'
    const { summary, symbols } = summarizeSource('data.json', src)
    expect(summary).toBe('[1, 2, 3]')
    expect(symbols).toEqual([])
  })

  it('uses the first non-empty line for an unknown extension', () => {
    const src = ['', 'hello world', 'second'].join('\n')
    const { summary } = summarizeSource('notes.txt', src)
    expect(summary).toBe('hello world')
  })

  it('flags binary-looking content', () => {
    // Build the NUL at runtime — no control char in the test source.
    const src = `abc${String.fromCharCode(0)}def`
    const { summary } = summarizeSource('blob.bin', src)
    expect(summary).toBe('(binary)')
  })

  it('clips an over-long summary to the budget', () => {
    // A dozen long export names blow past the 240-char summary budget.
    const names = Array.from({ length: 12 }, (_, i) => `veryLongExportedSymbolName${i}`)
    const src = names.map((n) => `export const ${n} = 1`).join('\n')
    const { summary } = summarizeSource('big.ts', src)
    expect(summary.length).toBeLessThanOrEqual(240)
    expect(summary.endsWith('…')).toBe(true)
  })
})

describe('readHead', () => {
  it('reads only a bounded prefix of a large file', () => {
    const abs = join(root, 'big.txt')
    writeFileSync(abs, 'A'.repeat(200_000))
    const head = readHead(abs, 1024)
    expect(head.length).toBe(1024)
    expect(head).toBe('A'.repeat(1024))
  })

  it('reads the whole file when it is shorter than the cap', () => {
    const abs = join(root, 'small.txt')
    writeFileSync(abs, 'tiny')
    expect(readHead(abs, 1024)).toBe('tiny')
  })
})

describe('index persistence', () => {
  it('emptyIndex has the current version and no files', () => {
    const idx = emptyIndex(root)
    expect(idx.version).toBe(INDEX_VERSION)
    expect(idx.root).toBe(root)
    expect(idx.files).toEqual({})
  })

  it('round-trips through save then load', () => {
    const idx: ProjectIndex = {
      version: INDEX_VERSION,
      root,
      files: {
        'src/a.ts': { size: 10, mtime: 123, summary: 'exports: a', symbols: ['a'], indexedAt: 1 }
      }
    }
    saveIndex(root, idx)
    const loaded = loadIndex(root)
    expect(loaded.files['src/a.ts']?.summary).toBe('exports: a')
    expect(loaded.files['src/a.ts']?.size).toBe(10)
    expect(loaded.root).toBe(root)
  })

  it('writes the index under <root>/.sylor/index.json', () => {
    saveIndex(root, emptyIndex(root))
    expect(indexPath(root)).toBe(join(root, '.sylor', 'index.json'))
    const onDisk = JSON.parse(readFileSync(indexPath(root), 'utf-8'))
    expect(onDisk.version).toBe(INDEX_VERSION)
  })

  it('returns an empty index for a missing file', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'sylor-index-none-'))
    try {
      expect(loadIndex(fresh).files).toEqual({})
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('returns an empty index for corrupt JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sylor-index-bad-'))
    try {
      saveIndex(dir, emptyIndex(dir))
      writeFileSync(indexPath(dir), '{ this is not json ')
      expect(loadIndex(dir).files).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns an empty index on a version mismatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sylor-index-ver-'))
    try {
      saveIndex(dir, emptyIndex(dir))
      writeFileSync(
        indexPath(dir),
        JSON.stringify({ version: INDEX_VERSION + 1, root: dir, files: { 'x.ts': {} } })
      )
      expect(loadIndex(dir).files).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
