/**
 * CanvasPanel — the third surface that can own the right slot, beside the live
 * preview and the browser.
 *
 * It exists so the harness can be *watched* without turning the conversation into
 * a log: the chat pane keeps its bubbles, its tool cards and its one evolving
 * status row exactly as they were, and everything a curious user wants instead —
 * the timestamped run trace, the diff of the active write, the changed-file tree,
 * the task graph — lives here, opt-in, one click away.
 *
 * The slot is mutually exclusive (see the store's `open*` actions): whichever of
 * the three opens last owns the rectangle, because the other two draw over the
 * same region and only one can win.
 *
 * Only modes that are actually built are listed. A tab that opened a blank pane
 * would promise a surface that doesn't exist, so the strip grows as the surfaces
 * land rather than shipping ahead of them.
 */
import { useAppStore, type CanvasMode } from '@renderer/store/useAppStore'
import { IconClose } from '@renderer/components/browser/icons'
import { RunLog } from './RunLog'
import { Timeline } from './Timeline'
import { DiffView } from './DiffView'
import { FileTree } from './FileTree'
import { TaskGraph } from './TaskGraph'

/** A built canvas surface. Add a row here the same turn its component lands. */
const MODES: Array<{ mode: CanvasMode; label: string; title: string }> = [
  { mode: 'log', label: 'Log', title: 'Every step this run took, with times' },
  { mode: 'diff', label: 'Diff', title: 'The change Sylor is making, full height' },
  { mode: 'tree', label: 'Files', title: 'Which files this run has touched' },
  { mode: 'graph', label: 'Graph', title: 'What imports what around this change' },
  {
    mode: 'timeline',
    label: 'Timeline',
    title: 'Restore points Sylor saved before each change'
  }
]

export function CanvasPanel() {
  const canvasMode = useAppStore((s) => s.canvasMode)
  const setCanvasMode = useAppStore((s) => s.setCanvasMode)
  const closeCanvas = useAppStore((s) => s.closeCanvas)

  // A mode selected before its surface existed (or persisted from a later build)
  // falls back to the first built one instead of rendering nothing.
  const active = MODES.some((m) => m.mode === canvasMode) ? canvasMode : MODES[0].mode

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            onClick={() => setCanvasMode(m.mode)}
            title={m.title}
            className={
              'sylor-press rounded px-2 py-0.5 text-[11px] transition-colors ' +
              (active === m.mode
                ? 'bg-surface-2 text-text'
                : 'text-muted hover:bg-surface-2 hover:text-text')
            }
          >
            {m.label}
          </button>
        ))}
        <button
          type="button"
          aria-label="Close canvas"
          title="Close"
          onClick={closeCanvas}
          className="sylor-press ml-auto rounded p-1 text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          <IconClose />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {active === 'log' && <RunLog />}
        {active === 'diff' && <DiffView />}
        {active === 'tree' && <FileTree />}
        {active === 'graph' && <TaskGraph />}
        {active === 'timeline' && <Timeline />}
      </div>
    </div>
  )
}
