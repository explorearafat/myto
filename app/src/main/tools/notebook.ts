import { readFile, writeFile } from 'node:fs/promises'
import { toErrorMessage } from '../providers/http'
import { fsAvailable, resolveInWorkspace } from './fs'
import type { ToolDef } from './registry'

/**
 * `edit_notebook` — structured cell edits to a Jupyter notebook (.ipynb) in the
 * working folder. A notebook is JSON, so a blind `edit_file` on it is brittle: the
 * model would have to reproduce exact JSON escaping, `source` line-arrays, and the
 * `outputs`/`execution_count` scaffolding around a cell. This tool instead parses
 * the notebook, mutates ONE cell by index (replace / insert / delete), and writes
 * valid nbformat back — so the model works at the cell level and can't corrupt the
 * document structure.
 *
 * It goes through the same {@link resolveInWorkspace} sandbox chokepoint and
 * {@link fsAvailable} gate as the other filesystem tools, and (like write/edit/delete)
 * emits a {@link ToolContext.onFileSnapshot} so a notebook edit is rewindable and
 * shows a real diff. A `write`-tier action.
 */

/** nbformat stores a cell's `source` as a string or an array of lines. */
function textToSource(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  return lines.map((l, i) => (i < lines.length - 1 ? `${l}\n` : l))
}

/** A minimal, valid nbformat cell of the given type. */
function makeCell(cellType: 'code' | 'markdown', text: string): Record<string, unknown> {
  const base: Record<string, unknown> = { cell_type: cellType, metadata: {}, source: textToSource(text) }
  if (cellType === 'code') {
    base.execution_count = null
    base.outputs = []
  }
  return base
}

interface Notebook {
  cells?: unknown[]
  [k: string]: unknown
}

/** Read a string field from the input, or null. */
function str(o: Record<string, unknown>, key: string): string | null {
  const v = o[key]
  return typeof v === 'string' ? v : null
}

export const editNotebookTool: ToolDef = {
  name: 'edit_notebook',
  description:
    'Edit a Jupyter notebook (.ipynb) in the working folder by cell index. "op": "replace" (default) swaps a cell\'s source, "insert" adds a new cell at "index", "delete" removes it. Give "source" (the cell text) for replace/insert and "cell_type" ("code" or "markdown", required for insert). A write-tier action.',
  usage: '{"path": "analysis.ipynb", "op": "replace", "index": 0, "source": "import pandas as pd", "cell_type": "code"}',
  sideEffect: 'write',
  available: fsAvailable,
  async run(input, ctx) {
    const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const rel = str(o, 'path')
    if (!rel || !rel.trim()) {
      return 'edit_notebook needs a "path" to a .ipynb file (relative to the working folder).'
    }
    if (!rel.trim().toLowerCase().endsWith('.ipynb')) {
      return `edit_notebook only edits .ipynb notebooks; "${rel}" is not one. Use edit_file for other files.`
    }
    const abs = ctx.workspaceDir ? resolveInWorkspace(ctx.workspaceDir, rel.trim()) : null
    if (!abs) return `edit_notebook: "${rel}" is outside the working folder and was refused.`

    const op = (str(o, 'op') ?? 'replace').toLowerCase()
    if (op !== 'replace' && op !== 'insert' && op !== 'delete') {
      return 'edit_notebook "op" must be "replace", "insert", or "delete".'
    }
    const rawIndex = o.index
    if (typeof rawIndex !== 'number' || !Number.isFinite(rawIndex)) {
      return 'edit_notebook needs a numeric "index" (the 0-based cell position).'
    }
    const index = Math.floor(rawIndex)

    let before: string
    try {
      before = await readFile(abs, 'utf8')
    } catch (err) {
      return `edit_notebook could not read "${rel}": ${toErrorMessage(err)}`
    }
    let nb: Notebook
    try {
      nb = JSON.parse(before) as Notebook
    } catch (err) {
      return `edit_notebook: "${rel}" is not valid JSON (${toErrorMessage(err)}).`
    }
    const cells = Array.isArray(nb.cells) ? [...nb.cells] : []

    if (op === 'delete') {
      if (index < 0 || index >= cells.length) {
        return `edit_notebook: cell index ${index} is out of range (the notebook has ${cells.length} cell${cells.length === 1 ? '' : 's'}).`
      }
      cells.splice(index, 1)
    } else if (op === 'insert') {
      const cellType = str(o, 'cell_type')
      if (cellType !== 'code' && cellType !== 'markdown') {
        return 'edit_notebook insert needs "cell_type": "code" or "markdown".'
      }
      const source = str(o, 'source')
      if (source == null) return 'edit_notebook insert needs a "source" string (the cell contents).'
      const at = Math.max(0, Math.min(index, cells.length))
      cells.splice(at, 0, makeCell(cellType, source))
    } else {
      // replace
      if (index < 0 || index >= cells.length) {
        return `edit_notebook: cell index ${index} is out of range (the notebook has ${cells.length} cell${cells.length === 1 ? '' : 's'}).`
      }
      const source = str(o, 'source')
      if (source == null) return 'edit_notebook replace needs a "source" string (the new cell contents).'
      const existing = cells[index] && typeof cells[index] === 'object' ? (cells[index] as Record<string, unknown>) : {}
      const requested = str(o, 'cell_type')
      const cellType =
        requested === 'code' || requested === 'markdown'
          ? requested
          : existing.cell_type === 'markdown'
            ? 'markdown'
            : 'code'
      // Preserve existing cell metadata/outputs where sensible; refresh source + scaffolding.
      const rebuilt = makeCell(cellType, source)
      if (existing.metadata && typeof existing.metadata === 'object') rebuilt.metadata = existing.metadata
      cells[index] = rebuilt
    }

    nb.cells = cells
    const after = `${JSON.stringify(nb, null, 1)}\n`
    try {
      await writeFile(abs, after, 'utf8')
    } catch (err) {
      return `edit_notebook failed to write "${rel}": ${toErrorMessage(err)}`
    }
    // Rewindable + diffable, like the other mutation tools.
    ctx.onFileSnapshot?.({ path: abs, before, after, kind: 'edit', existed: true })

    const verb = op === 'delete' ? 'Deleted cell' : op === 'insert' ? 'Inserted cell at' : 'Replaced cell'
    return `${verb} ${index} in ${rel}. The notebook now has ${cells.length} cell${cells.length === 1 ? '' : 's'}.`
  }
}
