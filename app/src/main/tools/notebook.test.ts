import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editNotebookTool } from './notebook'
import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults'
import type { FileSnapshot } from '../../shared/types'
import type { ToolContext } from './registry'

// A real temp folder is the Cowork workspace; each test resets it.
const ROOT = mkdtempSync(join(tmpdir(), 'myto-nb-test-'))

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

const snaps: FileSnapshot[] = []
const ctx = (workspaceDir: string | null = ROOT): ToolContext => ({
  settings: DEFAULT_PROVIDER_SETTINGS,
  mode: 'cowork',
  workspaceDir,
  signal: new AbortController().signal,
  onFileSnapshot: (s) => snaps.push(s)
})

/** A 2-cell notebook: one markdown, one code. */
function seed(): void {
  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Title'] },
      { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: ['x = 1'] }
    ]
  }
  writeFileSync(join(ROOT, 'nb.ipynb'), JSON.stringify(nb, null, 1))
}

/** Read the notebook back as a parsed object. */
function read(): { cells: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(ROOT, 'nb.ipynb'), 'utf8'))
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  snaps.length = 0
  seed()
})

describe('edit_notebook', () => {
  it('rejects a non-.ipynb path', async () => {
    expect(await editNotebookTool.run({ path: 'a.txt', op: 'replace', index: 0, source: 'x' }, ctx())).toMatch(
      /only edits \.ipynb/i
    )
  })

  it('refuses a path outside the working folder', async () => {
    const out = await editNotebookTool.run(
      { path: '../evil.ipynb', op: 'replace', index: 0, source: 'x' },
      ctx()
    )
    expect(out).toMatch(/outside the working folder/i)
  })

  it('replaces a cell source, keeping the cell type and valid nbformat', async () => {
    const out = await editNotebookTool.run({ path: 'nb.ipynb', op: 'replace', index: 1, source: 'x = 2' }, ctx())
    expect(out).toMatch(/Replaced cell 1/)
    const nb = read()
    expect(nb.cells[1].cell_type).toBe('code')
    expect(nb.cells[1].source).toEqual(['x = 2'])
    // Code cells keep their scaffolding.
    expect(nb.cells[1].outputs).toEqual([])
    expect(nb.cells[1].execution_count).toBeNull()
  })

  it('inserts a new cell at an index', async () => {
    const out = await editNotebookTool.run(
      { path: 'nb.ipynb', op: 'insert', index: 1, source: 'import os', cell_type: 'code' },
      ctx()
    )
    expect(out).toMatch(/Inserted cell at 1/)
    const nb = read()
    expect(nb.cells).toHaveLength(3)
    expect(nb.cells[1].source).toEqual(['import os'])
  })

  it('requires a cell_type when inserting', async () => {
    expect(await editNotebookTool.run({ path: 'nb.ipynb', op: 'insert', index: 0, source: 'x' }, ctx())).toMatch(
      /needs "cell_type"/i
    )
  })

  it('deletes a cell by index', async () => {
    const out = await editNotebookTool.run({ path: 'nb.ipynb', op: 'delete', index: 0 }, ctx())
    expect(out).toMatch(/Deleted cell 0/)
    const nb = read()
    expect(nb.cells).toHaveLength(1)
    expect(nb.cells[0].cell_type).toBe('code')
  })

  it('bounds-checks the index for replace/delete', async () => {
    expect(await editNotebookTool.run({ path: 'nb.ipynb', op: 'delete', index: 9 }, ctx())).toMatch(
      /out of range/i
    )
  })

  it('splits multi-line source into an nbformat line array', async () => {
    await editNotebookTool.run({ path: 'nb.ipynb', op: 'replace', index: 1, source: 'a = 1\nb = 2' }, ctx())
    // nbformat keeps the trailing newline on all but the last line.
    expect(read().cells[1].source).toEqual(['a = 1\n', 'b = 2'])
  })

  it('emits a rewindable edit snapshot', async () => {
    await editNotebookTool.run({ path: 'nb.ipynb', op: 'delete', index: 0 }, ctx())
    expect(snaps).toHaveLength(1)
    expect(snaps[0].kind).toBe('edit')
    expect(snaps[0].existed).toBe(true)
    expect(snaps[0].before).toContain('# Title')
    expect(snaps[0].after).not.toContain('# Title')
  })
})
