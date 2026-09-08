/**
 * Timeline — the restore points Sylor took before it changed anything.
 *
 * The engine snapshots the project before every write and every command (see
 * `main/checkpoint/checkpoints.ts`), so this list is not a feature anyone has to
 * remember to switch on: it is already there by the time they wish it were. Each
 * row is one point, labelled with what was about to happen, and putting the files
 * back is one click plus a confirm.
 *
 * Honesty rules it keeps:
 *  - a restore reports what actually changed on disk (`restored`), so "nothing to
 *    put back" reads as exactly that instead of as a silent success;
 *  - it names the undo point the engine took first, because a rollback the user
 *    cannot themselves roll back is not a safety net;
 *  - a `files` point says so — it holds only what Sylor wrote, not the whole tree —
 *    so nobody expects a git-grade snapshot from a project without git;
 *  - restoring is refused while a run is live, since the agent would be writing
 *    into the very tree being rewritten.
 */
import { useEffect, useState } from 'react'
import { useChatStore } from '@renderer/store/useChatStore'
import { useAppStore } from '@renderer/store/useAppStore'
import { formatClock } from '@renderer/lib/duration'
import type { CheckpointInfo, RestoreResult } from '@shared/types'

/** The verdict of the one restore this panel has run, if any. */
interface Outcome {
  id: string
  ok: boolean
  text: string
}

/**
 * One honest sentence for a finished restore. `restored` is the list of files the
 * engine actually rewrote, so an empty list is reported as a no-op rather than
 * dressed up as a successful rollback.
 */
function describeRestore(result: RestoreResult): { ok: boolean; text: string } {
  if (!result.ok) return { ok: false, text: result.error ?? 'The restore did not run.' }
  const undo = result.safety ? ' An undo point was saved first.' : ''
  const count = result.restored?.length ?? 0
  if (count === 0) {
    return { ok: true, text: 'Nothing to put back — the files already match this point.' + undo }
  }
  return { ok: true, text: `Put back ${count} file${count === 1 ? '' : 's'}.` + undo }
}

/** Short date for a point taken on an earlier day; null when it was taken today. */
function dayOf(at: number): string | null {
  if (!Number.isFinite(at) || at <= 0) return null
  const when = new Date(at)
  if (when.toDateString() === new Date().toDateString()) return null
  return when.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** What each storage kind can actually bring back — the chip's tooltip. */
const KIND_TITLE: Record<CheckpointInfo['kind'], string> = {
  git: 'A snapshot of the whole tracked tree, held as a git object',
  files: 'Copies of the files Sylor wrote — a restore brings back only those'
}

export function Timeline() {
  const checkpoints = useChatStore((s) => s.checkpoints)
  const refreshCheckpoints = useChatStore((s) => s.refreshCheckpoints)
  const restoreCheckpoint = useChatStore((s) => s.restoreCheckpoint)
  const running = useChatStore((s) => s.running)
  const workspaceRoot = useAppStore((s) => s.workspaceRoot)
  const armed = useAppStore((s) => s.armedCheckpoint)
  const armCheckpoint = useAppStore((s) => s.armCheckpoint)

  /** The row asking "sure?" — one stray click must not rewrite the tree. */
  const [confirming, setConfirming] = useState<string | null>(null)
  /** The point being restored right now; every other row locks while it runs. */
  const [busy, setBusy] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  // The command palette can point at a restore point (see the store's
  // `armCheckpoint`). It arms rather than restores — a fuzzy match plus a reflexive
  // Enter must not rewrite files — so all it does is land here with the row's confirm
  // already showing. Consumed on arrival, so re-opening the panel doesn't re-arm it.
  useEffect(() => {
    if (armed == null) return
    setConfirming(armed)
    armCheckpoint(null)
  }, [armed, armCheckpoint])

  // Checkpoints belong to the folder on disk, so the list is re-read on mount and
  // again whenever the root changes: a folder switch is a different timeline, and
  // leaving the previous folder's points up would offer to restore files that are
  // no longer in scope. The null guard skips the boot instant before the workspace
  // has loaded, when a read would hit whatever root the main process defaulted to.
  useEffect(() => {
    if (workspaceRoot === null) return
    refreshCheckpoints()
  }, [refreshCheckpoints, workspaceRoot])

  const restore = async (id: string): Promise<void> => {
    setConfirming(null)
    setBusy(id)
    try {
      setOutcome({ id, ...describeRestore(await restoreCheckpoint(id)) })
    } catch (error) {
      const text = error instanceof Error ? error.message : 'The restore failed.'
      setOutcome({ id, ok: false, text })
    } finally {
      setBusy(null)
    }
  }

  if (checkpoints.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-[15rem]">
          <p className="text-[12px] text-muted">No restore points yet.</p>
          <p className="mt-1 text-[11px] text-muted/70">
            Sylor saves one automatically before it writes a file or runs a command, so
            there is always a way back from the last change.
          </p>
        </div>
      </div>
    )
  }

  // One reason at a time, and always the true one: a live run is a different
  // blocker from another restore still finishing, and the button says which.
  const lockedReason = running
    ? 'Stop the run first — restoring while Sylor is still writing would fight its own edits'
    : busy != null
      ? 'Another restore is still running'
      : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-2.5 py-1.5 text-[10.5px] text-muted/80">
        {checkpoints.length} restore point{checkpoints.length === 1 ? '' : 's'} for this folder
        {running && ' · restoring is paused while a run is live'}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {checkpoints.map((point) => (
          <PointRow
            key={point.id}
            point={point}
            confirming={confirming === point.id}
            busy={busy === point.id}
            lockedReason={busy === point.id ? null : lockedReason}
            outcome={outcome?.id === point.id ? outcome : null}
            onAsk={() => setConfirming((id) => (id === point.id ? null : point.id))}
            onConfirm={() => void restore(point.id)}
          />
        ))}
      </div>
    </div>
  )
}

/** One restore point: when, what was about to happen, and the way back to it. */
function PointRow({
  point,
  confirming,
  busy,
  lockedReason,
  outcome,
  onAsk,
  onConfirm
}: {
  point: CheckpointInfo
  confirming: boolean
  busy: boolean
  /** Why restoring is unavailable, or null when it is available. */
  lockedReason: string | null
  outcome: Outcome | null
  onAsk: () => void
  onConfirm: () => void
}) {
  const day = dayOf(point.at)
  const chip = 'shrink-0 rounded bg-surface-2 px-1 font-mono text-[9.5px] text-muted'

  return (
    <div className="border-l border-border/40 pl-1">
      <div className="flex items-center gap-1.5 px-1 py-[3px]">
        <span className="w-[52px] shrink-0 font-mono text-[10px] text-muted/70 tabular-nums">
          {formatClock(point.at)}
        </span>
        <span className="w-3 shrink-0 text-center text-[10px] text-muted/60" aria-hidden="true">
          ↺
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-text/80" title={point.label}>
          {point.label}
        </span>
        {day && <span className="shrink-0 font-mono text-[9.5px] text-muted/70">{day}</span>}
        {point.auto && (
          <span className={chip} title="Taken automatically so a restore could itself be undone">
            undo
          </span>
        )}
        <span className={chip} title={KIND_TITLE[point.kind]}>
          {point.kind}
        </span>
        <RestoreButton
          confirming={confirming}
          busy={busy}
          lockedReason={lockedReason}
          onAsk={onAsk}
          onConfirm={onConfirm}
        />
      </div>

      {confirming && (
        <p className="mb-1 ml-[52px] mr-1 rounded border border-border bg-bg px-2 py-1 text-[10.5px] leading-snug text-muted">
          Puts the files back as they were at this point. An undo point is saved first,
          and nothing is deleted — a file created after this point stays.
        </p>
      )}

      {outcome && (
        <p
          className={
            'mb-1 ml-[52px] mr-1 text-[10.5px] leading-snug ' +
            (outcome.ok ? 'text-muted' : 'text-amber-300/90')
          }
        >
          {outcome.text}
        </p>
      )}
    </div>
  )
}

/**
 * The row's action. Two steps on purpose: the first click only arms it, so the
 * click that actually rewrites files is one the user meant to make.
 */
function RestoreButton({
  confirming,
  busy,
  lockedReason,
  onAsk,
  onConfirm
}: {
  confirming: boolean
  busy: boolean
  lockedReason: string | null
  onAsk: () => void
  onConfirm: () => void
}) {
  const base = 'sylor-press shrink-0 rounded px-1.5 py-0.5 text-[10.5px] transition-colors'

  if (busy) {
    return <span className="shrink-0 px-1.5 text-[10.5px] text-muted/70">Restoring…</span>
  }

  if (confirming) {
    return (
      <span className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={onConfirm}
          className={base + ' bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'}
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={onAsk}
          aria-label="Cancel this restore"
          title="Cancel"
          className={base + ' px-1 leading-none text-muted/70 hover:text-text'}
        >
          ×
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={onAsk}
      disabled={lockedReason != null}
      title={lockedReason ?? 'Put the files back as they were at this point'}
      className={
        base +
        (lockedReason != null
          ? ' cursor-not-allowed text-muted/40'
          : ' text-muted hover:bg-surface-2 hover:text-text')
      }
    >
      Restore to here
    </button>
  )
}
