/**
 * DiffView — the canvas's "show me the change" surface.
 *
 * The chat pane already puts a diff inside each write's tool card, but that diff
 * is 14 rem tall and buried in a thread that keeps growing. This is the same data
 * given the whole panel: whichever write is *current* (the one awaiting approval,
 * or else the most recent one) rendered full-height, with the earlier writes of
 * the run listed beneath so any of them can be brought back up.
 *
 * It reads the store's tool cards and nothing else — no new IPC, and no second
 * copy of the file on disk. That means it shows exactly what Sylor proposed, old
 * bytes on the left: a write that was rejected still has its diff here, which is
 * the whole point of being able to look back at one.
 */
import { useEffect, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { useChatStore, type ToolCardUI } from '@renderer/store/useChatStore'
import { useAppStore } from '@renderer/store/useAppStore'
import { languageForPath, monacoThemeFor } from '@renderer/lib/monaco-theme'
import { lineDiffStats } from '@renderer/lib/diff-stats'
import { formatClock } from '@renderer/lib/duration'
import type { ToolProposal } from '@shared/types'

/** A tool card that is definitely a file write — narrowed once, used everywhere. */
type WriteCard = ToolCardUI & { proposal: Extract<ToolProposal, { kind: 'write_file' }> }

function isWrite(card: ToolCardUI): card is WriteCard {
  return card.proposal.kind === 'write_file'
}

/** Last path segment — the diff header shows the name big and the folder small. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** Everything before the last segment, or '' for a file at the root. */
function dirName(path: string): string {
  const i = path.replace(/\\/g, '/').lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** What became of this write — the one word that decides how to read the diff. */
function verdictOf(card: WriteCard): { text: string; tone: string } {
  if (card.decision === 'reject') return { text: 'rejected', tone: 'text-amber-300/90' }
  if (card.status === 'awaiting') return { text: 'awaiting your go-ahead', tone: 'text-primary' }
  // Narrow the result too: a card's proposal kind does not type-correlate with its
  // result kind, and `ok` only exists on some of the result variants.
  const failed = card.result?.kind === 'write_file' && !card.result.ok
  if (failed) return { text: 'failed', tone: 'text-amber-300/90' }
  if (card.status === 'complete') return { text: 'applied', tone: 'text-muted' }
  return { text: 'running', tone: 'text-muted' }
}

export function DiffView() {
  const tools = useChatStore((s) => s.tools)
  const theme = useAppStore((s) => s.theme)

  const writes = tools.filter(isWrite)
  // Newest last in the store, so the tail is the current write. One still awaiting a
  // decision wins outright: if Sylor is blocked on you, that is the diff in question.
  const current = writes.find((c) => c.status === 'awaiting') ?? writes[writes.length - 1]
  const [pinned, setPinned] = useState<string | null>(null)

  // A pin is a choice about a specific card, so it is dropped once that card is no
  // longer among the run's writes (a new chat, a cleared thread) rather than
  // silently showing nothing.
  useEffect(() => {
    if (pinned && !writes.some((c) => c.id === pinned)) setPinned(null)
  }, [pinned, writes])

  const shown = writes.find((c) => c.id === pinned) ?? current

  if (!shown) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-[15rem]">
          <p className="text-[12px] text-muted">No file changes yet.</p>
          <p className="mt-1 text-[11px] text-muted/70">
            Every write Sylor proposes shows up here as a diff — before it is applied,
            and still afterwards.
          </p>
        </div>
      </div>
    )
  }

  const { proposal } = shown
  const stats = lineDiffStats(proposal.oldContent, proposal.newContent)
  const verdict = verdictOf(shown)
  const folder = dirName(proposal.path)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-baseline gap-1.5 border-b border-border px-2.5 py-1.5">
        <span className="min-w-0 truncate text-[12px] text-text" title={proposal.path}>
          {baseName(proposal.path)}
        </span>
        {folder && (
          <span className="min-w-0 shrink truncate font-mono text-[10px] text-muted/70">
            {folder}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[10.5px] tabular-nums">
          <span className="text-emerald-500">+{stats.added}</span>{' '}
          <span className="text-red-400">−{stats.removed}</span>
        </span>
        <span className={'shrink-0 text-[10.5px] ' + verdict.tone}>{verdict.text}</span>
      </div>

      <div className="min-h-0 flex-1">
        <DiffEditor
          // Remount per card: Monaco keeps view state (scroll, folds) per instance,
          // and carrying one file's scroll position into another file's diff lands
          // the reader in an arbitrary place.
          key={shown.id}
          theme={monacoThemeFor(theme)}
          language={languageForPath(proposal.path)}
          original={proposal.oldContent}
          modified={proposal.newContent}
          options={{
            readOnly: true,
            renderSideBySide: false,
            fontFamily: 'JetBrains Mono Variable, monospace',
            fontSize: 12,
            lineHeight: 18,
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            renderOverviewRuler: false,
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 }
          }}
          loading={<div className="p-3 text-[11px] text-muted">Loading diff…</div>}
        />
      </div>

      {writes.length > 1 && (
        <div className="max-h-32 shrink-0 overflow-y-auto border-t border-border px-1.5 py-1">
          {writes
            .slice()
            .reverse()
            .map((card) => {
              const s = lineDiffStats(card.proposal.oldContent, card.proposal.newContent)
              return (
                <button
                  key={card.id}
                  type="button"
                  onClick={() => setPinned(card.id === shown.id ? null : card.id)}
                  title={card.proposal.path}
                  className={
                    'sylor-press flex w-full items-center gap-1.5 rounded px-1 py-[3px] text-left transition-colors ' +
                    (card.id === shown.id ? 'bg-surface-2' : 'hover:bg-surface-2')
                  }
                >
                  <span className="w-[52px] shrink-0 font-mono text-[10px] text-muted/70 tabular-nums">
                    {formatClock(card.startedAt ?? 0)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-text/80">
                    {baseName(card.proposal.path)}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted">
                    +{s.added} −{s.removed}
                  </span>
                </button>
              )
            })}
        </div>
      )}
    </div>
  )
}
