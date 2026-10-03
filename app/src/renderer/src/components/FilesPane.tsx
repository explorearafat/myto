import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useFilesStore } from '../store/useFilesStore'
import { useChatStore } from '../store/useChatStore'
import { buildFileTree, type FileTreeNode } from '../lib/file-tree'
import { DiffView } from './DiffView'
import type { FileSnapshotKind } from '@shared/types'

/**
 * Myto's Working-tree pane (Build mode) — a live directory tree of every file Myto
 * writes, edits, or deletes as it builds, fed from {@link useFilesStore}. Clicking a
 * file fetches its before/after text on demand and renders an inline {@link DiffView},
 * the way Claude Desktop's Code section shows a change.
 *
 * It mirrors {@link TerminalPane}'s shape (an h-11 header over a min-h-0 flex-1 body)
 * so the right-hand panes feel like one family. The tree sits in a bounded scroll
 * region up top; the selected file's diff fills the rest.
 */

/** A compact header control button (matches PreviewPane/TerminalPane's PaneButton). */
function PaneButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
    >
      {children}
    </button>
  )
}

/** Git-style one-letter badge for the mutation kind (A dded / M odified / D eleted). */
function KindBadge({ kind }: { kind: FileSnapshotKind }): ReactNode {
  const map = {
    write: { ch: 'A', cls: 'text-green-500' },
    edit: { ch: 'M', cls: 'text-amber-500' },
    delete: { ch: 'D', cls: 'text-red-500' }
  } as const
  const { ch, cls } = map[kind]
  return (
    <span className={`w-3 shrink-0 text-center font-mono text-[10px] font-semibold ${cls}`} title={kind}>
      {ch}
    </span>
  )
}

/** One tree row — a collapsible folder or a clickable file leaf. Recurses on dirs. */
function TreeNodeRow({
  node,
  depth,
  collapsed,
  toggle,
  selectedPath,
  onSelect
}: {
  node: FileTreeNode
  depth: number
  collapsed: Set<string>
  toggle: (path: string) => void
  selectedPath: string | null
  onSelect: (path: string) => void
}): ReactNode {
  const pad = { paddingLeft: `${8 + depth * 12}px` }

  if (node.type === 'dir') {
    const isCollapsed = collapsed.has(node.path)
    return (
      <>
        <button
          type="button"
          onClick={() => toggle(node.path)}
          style={pad}
          className="flex w-full items-center gap-1 py-1 pr-2 text-left text-[12px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className={`shrink-0 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
          >
            <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="truncate">{node.name}</span>
        </button>
        {!isCollapsed &&
          node.children?.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              toggle={toggle}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
      </>
    )
  }

  // A file leaf: kind badge + name + `+added −removed` counts; highlighted when selected.
  const change = node.change
  const selected = selectedPath === node.path
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      style={pad}
      className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[12px] transition-colors ${
        selected ? 'bg-primary/10 text-text' : 'text-muted hover:bg-surface-2 hover:text-text'
      }`}
    >
      {change && <KindBadge kind={change.kind} />}
      <span className="min-w-0 flex-1 truncate" title={node.path}>
        {node.name}
      </span>
      {change && (change.added > 0 || change.removed > 0) && (
        <span className="shrink-0 font-mono text-[10px]">
          {change.added > 0 && <span className="text-green-500">+{change.added}</span>}
          {change.added > 0 && change.removed > 0 && ' '}
          {change.removed > 0 && <span className="text-red-500">&minus;{change.removed}</span>}
        </span>
      )}
    </button>
  )
}

export function FilesPane(): ReactNode {
  const changes = useFilesStore((s) => s.changes)
  const selectedPath = useFilesStore((s) => s.selectedPath)
  const select = useFilesStore((s) => s.select)
  const clear = useFilesStore((s) => s.clear)
  const close = useFilesStore((s) => s.close)
  const sessionId = useChatStore((s) => s.sessionId)

  // Collapse state per dir path (empty = everything expanded).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const toggle = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const tree = useMemo(() => buildFileTree(changes), [changes])
  const selectedChange = selectedPath ? changes.find((c) => c.path === selectedPath) ?? null : null

  // The selected file's before/after text, fetched on demand when the selection changes.
  const [diff, setDiff] = useState<{ before: string; after: string } | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  useEffect(() => {
    if (!sessionId || !selectedPath) {
      setDiff(null)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    window.myto.sessions
      .fileDiff(sessionId, selectedPath)
      .then((res) => {
        if (!cancelled) setDiff(res)
      })
      .catch(() => {
        if (!cancelled) setDiff(null)
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, selectedPath])

  return (
    <div className="flex h-full flex-col border-l border-border bg-bg">
      {/* Header: identity on the left, controls on the right. */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center text-muted">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2 3.5h4l1.2 1.5H14a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-text">Working tree</div>
          <div className="text-[10px] text-muted">
            {changes.length === 0
              ? 'No changes yet'
              : `${changes.length} file${changes.length === 1 ? '' : 's'} changed`}
          </div>
        </div>
        {changes.length > 0 && (
          <PaneButton label="Clear working tree" onClick={clear}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3 4.5h10M6 4.5V3.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 .75.75V4.5M4.5 4.5l.6 8a1 1 0 0 0 1 .95h3.8a1 1 0 0 0 1-.95l.6-8"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </PaneButton>
        )}
        <PaneButton label="Close working tree" onClick={close}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </PaneButton>
      </div>

      {/* Body: empty hint, or the tree (bounded, up top) over the selected file's diff. */}
      {changes.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center px-4 text-center text-[12px] text-muted">
          No file changes yet. Files Build writes, edits or deletes show up here as it works.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="max-h-[45%] shrink-0 overflow-auto border-b border-border py-1">
            {tree.map((node) => (
              <TreeNodeRow
                key={node.path}
                node={node}
                depth={0}
                collapsed={collapsed}
                toggle={toggle}
                selectedPath={selectedPath}
                onSelect={select}
              />
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {!selectedPath ? (
              <div className="grid h-full place-items-center px-4 text-center text-[12px] text-muted">
                Select a file to see its changes.
              </div>
            ) : (
              <>
                <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border bg-bg px-3 py-1.5">
                  {selectedChange && <KindBadge kind={selectedChange.kind} />}
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text" title={selectedPath}>
                    {selectedPath}
                  </span>
                </div>
                {diffLoading ? (
                  <div className="px-3 py-3 text-[12px] text-muted">Loading diff&hellip;</div>
                ) : diff ? (
                  <DiffView oldText={diff.before} newText={diff.after} />
                ) : (
                  <div className="px-3 py-3 text-[12px] text-muted">No diff available for this file.</div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
