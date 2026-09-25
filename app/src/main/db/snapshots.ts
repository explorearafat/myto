import type { FileSnapshot, FileSnapshotKind, PersistedFileSnapshot } from '../../shared/types'
import { getDb } from './db'

/**
 * Typed access to the `file_snapshots` table (#1 checkpoints / rewind). Every Cowork
 * mutation tool (write, edit, delete) emits a {@link FileSnapshot} through
 * `ctx.onFileSnapshot`; the stream loop persists it here, keyed by session + the user
 * message the run answers + the run id. Rewind (Wave 2) reads them back with
 * {@link listFileSnapshots} and replays in reverse to restore an earlier state.
 *
 * Writes are fire-and-forget from the tool loop, so {@link insertFileSnapshot}
 * swallows nothing — callers wrap it — but it never derives ordering from a race:
 * the AUTOINCREMENT `id` is the total order rewind walks backwards.
 */

/** One row to persist. `before`/`after` follow {@link FileSnapshot}; the rest are keys. */
export interface NewFileSnapshot extends FileSnapshot {
  sessionId: string
  /** The user message the run answered, or null when the run had none yet. */
  afterMsgId: string | null
  runId: string
  createdAt: number
}

/** Insert one snapshot row and return its new id. */
export function insertFileSnapshot(s: NewFileSnapshot): number {
  const info = getDb()
    .prepare(
      `INSERT INTO file_snapshots
         (session_id, after_msg_id, run_id, path, before_content, after_content, kind, existed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      s.sessionId,
      s.afterMsgId,
      s.runId,
      s.path,
      s.before,
      s.after,
      s.kind,
      s.existed ? 1 : 0,
      s.createdAt
    )
  return Number(info.lastInsertRowid)
}

/** Shape of a raw `file_snapshots` row as sqlite hands it back. */
interface SnapshotRow {
  id: number
  session_id: string
  after_msg_id: string | null
  run_id: string
  path: string
  before_content: string | null
  after_content: string | null
  kind: string
  existed: number
  created_at: number
}

/** Map a DB row to the shared camelCase shape. */
function toPersisted(r: SnapshotRow): PersistedFileSnapshot {
  return {
    id: r.id,
    sessionId: r.session_id,
    afterMsgId: r.after_msg_id,
    runId: r.run_id,
    path: r.path,
    before: r.before_content,
    after: r.after_content,
    kind: r.kind as FileSnapshotKind,
    existed: r.existed !== 0,
    createdAt: r.created_at
  }
}

/** All snapshots for a session, oldest first (ascending id = the order they happened). */
export function listFileSnapshots(sessionId: string): PersistedFileSnapshot[] {
  const rows = getDb()
    .prepare(`SELECT * FROM file_snapshots WHERE session_id = ? ORDER BY id ASC`)
    .all(sessionId) as unknown as SnapshotRow[]
  return rows.map(toPersisted)
}

/**
 * The pre-change bytes of the most-recent write/edit whose *after* content equals
 * `after`, scoped to the session — the diff base a file card needs to show a real
 * overwrite (removed + added) instead of an all-additions view (#5). Matching on
 * the after-content (which the card already holds verbatim) is content-addressed,
 * so it sidesteps the snapshot's absolute path vs. the card's relative path, and
 * pins the exact write even when the same path was written several times. Returns
 * the `before_content` (which may be an empty string for a write over an empty
 * file) or `null` when there's no such snapshot or it was a fresh create (no base).
 */
export function findSnapshotBefore(sessionId: string, after: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT before_content FROM file_snapshots
         WHERE session_id = ? AND after_content = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(sessionId, after) as { before_content: string | null } | undefined
  return row?.before_content ?? null
}

/** Delete snapshot rows for a session with id greater than `afterId` (used after a rewind). */
export function deleteFileSnapshotsAfter(sessionId: string, afterId: number): void {
  getDb().prepare(`DELETE FROM file_snapshots WHERE session_id = ? AND id > ?`).run(sessionId, afterId)
}

/**
 * Delete a precise set of snapshot rows by id (scoped to the session). Rewind uses
 * this rather than an `id >` cutoff because the undone set isn't always a
 * contiguous id-suffix: regenerating an earlier turn appends *new* high-id
 * snapshots that carry a *low* message seq, so they must be removed by exact id
 * without disturbing untouched later rows.
 */
export function deleteFileSnapshotsByIds(sessionId: string, ids: number[]): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(', ')
  getDb()
    .prepare(`DELETE FROM file_snapshots WHERE session_id = ? AND id IN (${placeholders})`)
    .run(sessionId, ...ids)
}
