/**
 * FileTree — what this run actually touched, as a folder tree.
 *
 * The Log answers "what happened, in order"; this answers the other question a
 * reviewer has, "which files am I about to have to look at". It is built from the
 * same tool cards, folded into nested folders, so a run that rewrites six files in
 * two directories reads as two directories instead of six unrelated rows.
 *
 * Reads are shown as well as writes, dimmer: knowing Sylor opened a file and left
 * it alone is part of knowing what it based the change on. Nothing here is a
 * filesystem listing — an untouched file never appears, because the panel is about
 * the run, not the project.
 */
import { useMemo } from 'react'
import { useChatStore, type ToolCardUI } from '@renderer/store/useChatStore'
import { useAppStore } from '@renderer/store/useAppStore'
import { lineDiffStats } from '@renderer/lib/diff-stats'

/** One file the run touched, folded across however many ops touched it. */
interface Touched {
  path: string
  added: number
  removed: number
  /** True once any write landed (or is awaiting); false for read-only contact. */
  written: boolean
  /** True while a write on this file is still awaiting a decision or running. */
  live: boolean
  rejected: boolean
  failed: boolean
  ops: number
}

/** A folder in the tree; `files` are its own children, `dirs` its subfolders. */
interface DirNode {
  name: string
  dirs: Map<string, DirNode>
  files: Touched[]
}

function emptyDir(name: string): DirNode {
  return { name, dirs: new Map(), files: [] }
}

/** Paths arrive POSIX-relative from the sandbox, but be tolerant of both slashes. */
function segments(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0)
}

/**
 * Which path a card touched, if any. Only `read_file` names a real file: the other
 * read ops target a directory ('.' for a project-wide search), and listing those as
 * touched files would put a folder in the tree as if Sylor had opened it.
 */
function pathOf(card: ToolCardUI): { path: string | null; write: boolean } {
  const p = card.proposal
  if (p.kind === 'write_file') return { path: p.path, write: true }
  if (p.kind === 'read' && p.op === 'read_file') return { path: p.path, write: false }
  return { path: null, write: false }
}

/** Folds the run's cards into one row per file, newest state winning. */
function collect(tools: ToolCardUI[]): Touched[] {
  const byPath = new Map<string, Touched>()

  for (const card of tools) {
    const { path, write } = pathOf(card)
    if (!path) continue
    const row =
      byPath.get(path) ??
      ({
        path,
        added: 0,
        removed: 0,
        written: false,
        live: false,
        rejected: false,
        failed: false,
        ops: 0
      } satisfies Touched)

    row.ops += 1
    if (write && card.proposal.kind === 'write_file') {
      // A rejected write changed nothing on disk, so its +/− would overstate the
      // run's footprint; it still marks the file as one Sylor tried to change.
      if (card.decision !== 'reject') {
        const stats = lineDiffStats(card.proposal.oldContent, card.proposal.newContent)
        row.added += stats.added
        row.removed += stats.removed
      }
      row.written = true
      row.live = card.status !== 'complete'
      if (card.decision === 'reject') row.rejected = true
      if (card.result?.kind === 'write_file' && !card.result.ok) row.failed = true
    }
    byPath.set(path, row)
  }

  return [...byPath.values()].sort((a, b) => {
    // Writes first — they are what needs reviewing — then alphabetically so the
    // tree is stable across renders rather than reordering as ops land.
    if (a.written !== b.written) return a.written ? -1 : 1
    return a.path.localeCompare(b.path)
  })
}

/** Builds the folder tree, then collapses single-child chains into `a/b/c`. */
function buildTree(rows: Touched[]): DirNode {
  const root = emptyDir('')
  for (const row of rows) {
    const parts = segments(row.path)
    const file = parts.pop()
    if (!file) continue
    let dir = root
    for (const part of parts) {
      const next = dir.dirs.get(part) ?? emptyDir(part)
      dir.dirs.set(part, next)
      dir = next
    }
    dir.files.push(row)
  }
  collapse(root)
  return root
}

/**
 * `src` → `renderer` → `src` → `components` is four rows of indentation carrying
 * one bit of information. A folder with exactly one subfolder and no files of its
 * own is merged into its child, the way a file explorer's compact mode does it.
 */
function collapse(dir: DirNode): void {
  for (const child of dir.dirs.values()) collapse(child)
  if (dir.name !== '' && dir.files.length === 0 && dir.dirs.size === 1) {
    const [only] = [...dir.dirs.values()]
    dir.name = dir.name + '/' + only.name
    dir.dirs = only.dirs
    dir.files = only.files
  }
}

function toneFor(row: Touched): string {
  if (row.rejected || row.failed) return 'text-amber-300/90'
  if (row.live) return 'text-primary'
  if (row.written) return 'text-text/85'
  return 'text-muted/70'
}

function titleFor(row: Touched): string {
  const times = row.ops === 1 ? 'once' : `${row.ops} times`
  if (row.rejected) return `${row.path} — you turned this write down`
  if (row.failed) return `${row.path} — the write did not land`
  if (row.live) return `${row.path} — being written now`
  if (row.written) return `${row.path} — written ${times} this run`
  return `${row.path} — read, not changed`
}

function FileRow({ row, depth }: { row: Touched; depth: number }) {
  return (
    <div
      className="flex items-center gap-1.5 rounded px-1 py-[2px] hover:bg-surface-2"
      style={{ paddingLeft: 4 + depth * 12 }}
      title={titleFor(row)}
    >
      <span
        aria-hidden
        className={
          'h-1 w-1 shrink-0 rounded-full ' +
          (row.live
            ? 'animate-pulse bg-primary'
            : row.rejected || row.failed
              ? 'bg-amber-300/80'
              : row.written
                ? 'bg-emerald-500/80'
                : 'bg-muted/40')
        }
      />
      <span className={'min-w-0 flex-1 truncate text-[11px] ' + toneFor(row)}>
        {segments(row.path).slice(-1)[0]}
      </span>
      {row.written ? (
        <span className="shrink-0 font-mono text-[10px] tabular-nums">
          <span className="text-emerald-500">+{row.added}</span>{' '}
          <span className="text-red-400">−{row.removed}</span>
        </span>
      ) : (
        <span className="shrink-0 text-[10px] text-muted/50">read</span>
      )}
    </div>
  )
}

function DirRows({ dir, depth }: { dir: DirNode; depth: number }) {
  return (
    <>
      {[...dir.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((child) => (
          <div key={child.name}>
            <div
              className="truncate py-[2px] font-mono text-[10px] text-muted/60"
              style={{ paddingLeft: 4 + depth * 12 }}
            >
              {child.name}
            </div>
            <DirRows dir={child} depth={depth + 1} />
          </div>
        ))}
      {dir.files.map((row) => (
        <FileRow key={row.path} row={row} depth={depth} />
      ))}
    </>
  )
}

export function FileTree() {
  const tools = useChatStore((s) => s.tools)
  const setCanvasMode = useAppStore((s) => s.setCanvasMode)

  const rows = useMemo(() => collect(tools), [tools])
  const tree = useMemo(() => buildTree(rows), [rows])

  const writes = rows.filter((r) => r.written)
  const totals = writes.reduce(
    (acc, r) => ({ added: acc.added + r.added, removed: acc.removed + r.removed }),
    { added: 0, removed: 0 }
  )

  if (rows.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-[15rem]">
          <p className="text-[12px] text-muted">Nothing touched yet.</p>
          <p className="mt-1 text-[11px] text-muted/70">
            Files Sylor reads and writes during a run collect here, so you can see the
            shape of a change without scrolling the thread.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
        <span className="text-[11px] text-muted">
          {writes.length} changed, {rows.length - writes.length} read
        </span>
        <span className="ml-auto font-mono text-[10.5px] tabular-nums">
          <span className="text-emerald-500">+{totals.added}</span>{' '}
          <span className="text-red-400">−{totals.removed}</span>
        </span>
        {writes.length > 0 && (
          <button
            type="button"
            onClick={() => setCanvasMode('diff')}
            className="sylor-press shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
            title="Open the diff of the current write"
          >
            see the diff
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        <DirRows dir={tree} depth={0} />
      </div>
    </div>
  )
}
