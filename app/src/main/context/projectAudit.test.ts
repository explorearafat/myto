import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The §3 audit: one pass over a project, persisted, so no later turn opens a file
 * just to find out what it is for. Everything here is deterministic, so the tests
 * assert the exact documents — a file's own docblock becomes its purpose line, the
 * layout rollup survives clipping, and a map somebody wrote by hand is never
 * overwritten.
 */

const files = vi.hoisted(() => ({ list: [] as string[], contents: {} as Record<string, string> }))

vi.mock('../context/manager', () => ({
  contextManager: {
    getRoot: () => '/project',
    listFiles: () => files.list,
    readFile: (rel: string) => files.contents[rel] ?? null
  }
}))

vi.mock('./projectIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projectIndex')>()
  return {
    ...actual,
    // Reads the fake project instead of the disk; a missing file throws, as fs would.
    readHead: (abs: string) => {
      const rel = abs.replace(/^[/\\]project[/\\]?/, '').split('\\').join('/')
      const text = files.contents[rel]
      if (text === undefined) throw new Error(`ENOENT: ${rel}`)
      return text
    }
  }
})

import {
  buildAuditInventory,
  describeFile,
  parseFileMap,
  renderFileMap,
  FILEMAP_MARKER
} from './projectAudit'
import { SCAFFOLD_MARKER } from './projectMemory'

/** Installs a fake project: paths → contents. */
function project(contents: Record<string, string>): void {
  files.contents = contents
  files.list = Object.keys(contents)
}

beforeEach(() => {
  files.list = []
  files.contents = {}
})

describe('describeFile', () => {
  it('quotes the file’s own docblock as its purpose', () => {
    const purpose = describeFile(
      'src/main/db/db.ts',
      '/**\n * SQLite connection and migrations — the app’s only writer.\n *\n * More detail.\n */\nexport const db = 1\n'
    )
    expect(purpose).toBe('SQLite connection and migrations — the app’s only writer.')
  })

  it('collapses a wrapped docblock line into one line', () => {
    const purpose = describeFile('a.ts', '// Runs one work turn end to end\nexport const x = 1\n')
    expect(purpose).toBe('Runs one work turn end to end')
  })

  it('falls back to what the path implies, enriched with exports', () => {
    expect(describeFile('src/hooks/useCart.ts', 'export function useCart() {}\n')).toBe(
      'React hook: useCart. Exports useCart.'
    )
    expect(describeFile('src/components/CartRow.tsx', 'export function CartRow() {}\n')).toBe(
      'React component: CartRow. Exports CartRow.'
    )
    expect(describeFile('src/db/db.test.ts', 'it("works", () => {})\n')).toBe('Tests for db.')
    expect(describeFile('package.json', '{"name":"x"}')).toBe(
      'Package manifest — name, scripts and dependencies.'
    )
    expect(describeFile('src/api/index.ts', 'export const get = 1\n')).toBe(
      'Entry point for api. Exports get.'
    )
  })

  it('uses a markdown file’s first heading', () => {
    expect(describeFile('docs/setup.md', '# Getting started\n\nRun npm i.\n')).toBe('Getting started.')
  })

  it('says so when it genuinely cannot tell', () => {
    expect(describeFile('src/thing.ts', 'const x = 1\n')).toBe(
      'Purpose not recorded yet — describe it here.'
    )
  })
})

describe('buildAuditInventory', () => {
  it('renders a layout rollup and a purpose line per file', () => {
    project({
      'package.json': '{"name":"shop","dependencies":{"react":"18"},"scripts":{"dev":"vite"}}',
      'src/main.tsx': '/**\n * Boots the React app into #root.\n */\nexport default 1\n',
      'src/components/Cart.tsx': 'export function Cart() {}\n'
    })

    const audit = buildAuditInventory()
    expect(audit.files).toBe(3)
    // The rollup comes first, so a clipped read still shows the shape of the tree.
    expect(audit.filemap.indexOf('## Layout')).toBeLessThan(audit.filemap.indexOf('## src'))
    expect(audit.filemap).toContain('- `src/components` — 1 file · UI components')
    expect(audit.filemap).toContain('- `src/main.tsx` — Boots the React app into #root.')
    expect(audit.filemap).toContain('- `src/components/Cart.tsx` — React component: Cart. Exports Cart.')
    // The digest is what the ARCHITECTURE/CONVENTIONS call sees: manifest + map.
    expect(audit.digest).toContain('Package: shop')
    expect(audit.digest).toContain('Dependencies: react')
    expect(audit.digest).toContain('- dev: vite')
    expect(audit.digest).toContain('- src/main.tsx — Boots the React app into #root.')
  })

  it('skips lock files, assets and binaries', () => {
    project({
      'package-lock.json': '{}',
      'src/logo.svg': '<svg/>',
      'src/app.ts': 'export const app = 1\n'
    })
    const audit = buildAuditInventory()
    expect(audit.files).toBe(1)
    expect(audit.filemap).toContain('src/app.ts')
    expect(audit.filemap).not.toContain('package-lock.json')
    expect(audit.filemap).not.toContain('logo.svg')
  })

  it('describes an unreadable file from its path alone', () => {
    files.contents = { 'src/gone.ts': 'export const x = 1\n' }
    files.list = ['src/gone.ts', 'src/Vanished.tsx']
    const audit = buildAuditInventory()
    expect(audit.files).toBe(2)
    expect(audit.filemap).toContain('- `src/Vanished.tsx` — React component: Vanished.')
  })

  it('keeps a purpose line that was already refined, and adds the new file', () => {
    project({
      'src/a.ts': 'export const a = 1\n',
      'src/b.ts': 'export const b = 1\n'
    })
    const existing = [
      FILEMAP_MARKER,
      '# File map',
      '',
      '## src',
      '',
      '- `src/a.ts` — Hand-refined: owns the auth token lifecycle.'
    ].join('\n')

    const audit = buildAuditInventory(existing)
    expect(audit.filemap).toContain('- `src/a.ts` — Hand-refined: owns the auth token lifecycle.')
    expect(audit.filemap).toContain('- `src/b.ts` — ')
  })

  it('refuses to touch a file map somebody wrote by hand', () => {
    project({ 'src/a.ts': 'export const a = 1\n' })
    // No marker: this is their document, in their format.
    const audit = buildAuditInventory('# Files\n\nsrc/a.ts does the auth.\n')
    expect(audit.filemap).toBe('')
    // The digest is still built — it costs nothing and hurts nothing.
    expect(audit.digest).toContain('src/a.ts')
  })

  it('treats its own untouched scaffold as absent', () => {
    project({ 'src/a.ts': 'export const a = 1\n' })
    const audit = buildAuditInventory(`${SCAFFOLD_MARKER}\n# File map\n\nFormat: …\n`)
    expect(audit.filemap).toContain('- `src/a.ts` — ')
  })

  it('reports nothing to audit for an empty project', () => {
    project({})
    expect(buildAuditInventory().files).toBe(0)
  })
})

describe('renderFileMap', () => {
  it('round-trips through parseFileMap', () => {
    const doc = renderFileMap([
      { path: 'src/a.ts', purpose: 'Does A.' },
      { path: 'src/b/c.ts', purpose: 'Does C.' }
    ])
    const parsed = parseFileMap(doc)
    expect(parsed.get('src/a.ts')).toBe('Does A.')
    expect(parsed.get('src/b/c.ts')).toBe('Does C.')
  })

  it('says how many files are still undescribed', () => {
    const doc = renderFileMap([{ path: 'a.ts', purpose: 'A.' }], { total: 9 })
    expect(doc).toContain('1 file described, 8 more not yet described.')
  })
})
