import { useMemo, type ReactNode } from 'react'

/**
 * A compact, read-only inline diff (#5). Given the before/after text of a file
 * mutation, it shows a line-level diff — green additions, red deletions, plain
 * context — the way Claude Desktop's Code section renders `edit_file` changes.
 *
 * We compute the diff ourselves with a classic line-LCS rather than mounting a
 * Monaco DiffEditor: this app runs offline in Electron, and `@monaco-editor/react`
 * lazy-loads its editor + web workers (from a CDN by default), which is both heavy
 * and fragile for a small read-only diff. A hand-rolled line diff needs no worker,
 * no network, and matches the app's lightweight card aesthetic. It also adds no new
 * dependency — the same reason the plan reached for Monaco in the first place.
 */

type Row = { type: 'add' | 'del' | 'ctx'; text: string; oldNo: number | null; newNo: number | null }

/** Longest-common-subsequence line diff. O(n·m) — fine for the file sizes shown here. */
function diffLines(oldText: string, newText: string): Row[] {
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')
  const n = a.length
  const m = b.length

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const rows: Row[] = []
  let i = 0
  let j = 0
  let oldNo = 1
  let newNo = 1
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'ctx', text: a[i], oldNo: oldNo++, newNo: newNo++ })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: 'del', text: a[i], oldNo: oldNo++, newNo: null })
      i++
    } else {
      rows.push({ type: 'add', text: b[j], oldNo: null, newNo: newNo++ })
      j++
    }
  }
  while (i < n) rows.push({ type: 'del', text: a[i++], oldNo: oldNo++, newNo: null })
  while (j < m) rows.push({ type: 'add', text: b[j++], oldNo: null, newNo: newNo++ })
  return rows
}

const MAX_ROWS = 400

export function DiffView({ oldText, newText }: { oldText: string; newText: string }): ReactNode {
  const rows = useMemo(() => diffLines(oldText, newText), [oldText, newText])
  const shown = rows.slice(0, MAX_ROWS)
  const hidden = rows.length - shown.length

  return (
    <div className="overflow-x-auto bg-surface/60 font-mono text-[11.5px] leading-[1.55]">
      {shown.map((r, idx) => {
        const bg = r.type === 'add' ? 'bg-green-500/10' : r.type === 'del' ? 'bg-red-500/10' : ''
        const sign = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '
        const signColor =
          r.type === 'add' ? 'text-green-500' : r.type === 'del' ? 'text-red-500' : 'text-muted'
        return (
          <div key={idx} className={'flex whitespace-pre ' + bg}>
            <span className="w-9 shrink-0 select-none px-1 text-right text-[10px] text-muted/60">
              {r.oldNo ?? ''}
            </span>
            <span className="w-9 shrink-0 select-none px-1 text-right text-[10px] text-muted/60">
              {r.newNo ?? ''}
            </span>
            <span className={'w-4 shrink-0 select-none text-center ' + signColor}>{sign}</span>
            <span className="flex-1 pr-3 text-text/90">{r.text === '' ? ' ' : r.text}</span>
          </div>
        )
      })}
      {hidden > 0 && (
        <div className="px-3 py-1 text-[10px] italic text-muted">…{hidden} more line{hidden === 1 ? '' : 's'}</div>
      )}
    </div>
  )
}
