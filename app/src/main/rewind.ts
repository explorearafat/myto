import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PersistedFileSnapshot, RewindResult } from '../shared/types'
import { getMessageSeq, truncateSessionAfter } from './db/sessions'
import { deleteFileSnapshotsByIds, listFileSnapshots } from './db/snapshots'

/*
 * Rewind (#1 checkpoints / "restore to here").
 *
 * A Cowork run records a {@link FileSnapshot} for every file it writes, edits, or
 * deletes — the bytes *before* the change, keyed by the user message the run was
 * answering. Rewinding to a message means: undo every file change made on or after
 * that turn, then drop the chat turns that followed.
 *
 * The replay walks the affected snapshots **newest-first** and writes each one's
 * `before` bytes back (or deletes the file when it didn't exist at snapshot time).
 * Newest-first is what makes it correct across repeated edits to the same file: the
 * *oldest* snapshot in the undo window holds the bytes as they were before the whole
 * window, and by applying newest→oldest that oldest `before` wins and lands last.
 * (Deletes that recreate a file, creates that are later deleted, etc. all reduce to
 * the same rule — the final write is the earliest change's `before`.)
 *
 * Kept electron-free (only `node:fs`/`node:path` + the DB helpers) so it runs under
 * vitest against a throwaway file DB and real temp files.
 */

/** Restore one snapshot: delete the file if it didn't exist, else write its `before` bytes back. */
function undoOne(snap: PersistedFileSnapshot): 'restored' | 'deleted' {
  if (!snap.existed) {
    // The file was created by this run — remove it (force: a prior undo in the
    // same pass, or a user delete, may already be gone).
    rmSync(snap.path, { force: true, recursive: false })
    return 'deleted'
  }
  // The file existed before the change — put its original bytes back. `before` is
  // only null for a pure create (existed === false), handled above; treat a stray
  // null defensively as empty.
  mkdirSync(dirname(snap.path), { recursive: true })
  writeFileSync(snap.path, snap.before ?? '', 'utf8')
  return 'restored'
}

/**
 * Rewind `sessionId` to just after `afterMsgId`: reverse-replay the file snapshots
 * from that turn onward, then truncate the chat after it. Returns a summary; with
 * `ok: false` when the message id isn't in the session (a no-op).
 *
 * `now` is injected (not `Date.now()`) so tests get a deterministic updatedAt.
 */
export function rewindSession(sessionId: string, afterMsgId: string, now: number): RewindResult {
  const targetSeq = getMessageSeq(sessionId, afterMsgId)
  if (targetSeq == null) {
    return {
      ok: false,
      filesRestored: 0,
      filesDeleted: 0,
      messagesRemoved: 0,
      reason: 'That message is no longer in this chat.'
    }
  }

  // Snapshots come back oldest-first (ascending id). A snapshot belongs to the undo
  // window when the turn it was recorded against sits at or after the cut point.
  // Snapshots whose message has already been truncated away map to null and are
  // skipped (inert) — a safety net that keeps replay correct after earlier rewinds.
  const seqCache = new Map<string, number | null>()
  const seqOf = (msgId: string | null): number | null => {
    if (msgId == null) return null
    if (!seqCache.has(msgId)) seqCache.set(msgId, getMessageSeq(sessionId, msgId))
    return seqCache.get(msgId) ?? null
  }

  const toUndo = listFileSnapshots(sessionId).filter((s) => {
    const seq = seqOf(s.afterMsgId)
    return seq != null && seq >= targetSeq
  })

  let filesRestored = 0
  let filesDeleted = 0
  // Newest-first: iterate the (ascending) undo set from the end.
  for (let i = toUndo.length - 1; i >= 0; i--) {
    try {
      if (undoOne(toUndo[i]) === 'deleted') filesDeleted++
      else filesRestored++
    } catch {
      // A single unreadable/locked path shouldn't abort the whole restore; skip it
      // and press on (the chat truncation below still runs).
    }
  }

  // Remove exactly the rows we undid (by id — the set may not be a contiguous
  // id-suffix once regenerates are involved), then drop the later chat turns.
  deleteFileSnapshotsByIds(
    sessionId,
    toUndo.map((s) => s.id)
  )
  const messagesRemoved = truncateSessionAfter(sessionId, targetSeq, now)

  return { ok: true, filesRestored, filesDeleted, messagesRemoved }
}
