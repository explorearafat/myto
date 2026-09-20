import type {
  Attachment,
  PersistedMessage,
  PersistedSession,
  SessionSummary
} from '../../shared/types'
import { getDb } from './db'

/**
 * Typed CRUD over the session tables (Phase 5). The main process is the single
 * writer, so per-session `seq` ordering is derived with `MAX(seq)+1` at append
 * time without a race.
 *
 * Every function is defensively usable from fire-and-forget IPC: they throw only
 * on genuine programmer error, and the callers wrap append writes so a DB fault
 * never breaks the live chat.
 */

let idCounter = 0

/** Generate a unique session id. Time-free (Date.now is passed in) for tests. */
function nextSessionId(now: number): string {
  idCounter += 1
  return `sess-${now}-${idCounter}`
}

/**
 * The session currently open in the window. Set by the IPC layer on load/create
 * so the delete handler knows whether it's removing the active chat. Null before
 * any session is open.
 */
let activeSessionId: string | null = null

/** Mark the session currently open in the window. */
export function setActiveSession(id: string | null): void {
  activeSessionId = id
}

/** The session currently open in the window, or null. */
export function getActiveSession(): string | null {
  return activeSessionId
}

/** Next append position within a session for the messages table. */
function nextSeq(table: 'messages', sessionId: string): number {
  const row = getDb()
    .prepare(`SELECT MAX(seq) AS maxSeq FROM ${table} WHERE session_id = ?`)
    .get(sessionId) as { maxSeq: number | null } | undefined
  return (row?.maxSeq ?? -1) + 1
}

/** Create a new, empty session and return its summary. */
export function createSession(
  projectRoot: string,
  title: string,
  now: number,
  projectId: string | null = null
): SessionSummary {
  const id = nextSessionId(now)
  getDb()
    .prepare(
      `INSERT INTO sessions (id, title, project_root, project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, title, projectRoot, projectId, now, now)
  return { id, title, projectRoot, projectId, createdAt: now, updatedAt: now, messageCount: 0 }
}

/**
 * All sessions, newest-updated first, with message counts. History is GLOBAL —
 * never scoped to a project root — so switching the working folder (or toggling
 * cowork/code) never hides past chats; they stay in one flat, chronological list
 * like Claude's desktop app. Pass a `projectId` to narrow to chats filed under
 * that project; `null`/`undefined` both mean "every chat" (what the rail's
 * "All chats" entry uses).
 */
export function listSessions(projectId?: string | null): SessionSummary[] {
  // Only a concrete project id filters; null/undefined list every chat globally.
  const byProject = typeof projectId === 'string'
  const stmt = getDb().prepare(
    `SELECT s.id, s.title, s.project_root, s.project_id, s.created_at, s.updated_at,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
     FROM sessions s
     ${byProject ? 'WHERE s.project_id = ?' : ''}
     ORDER BY s.updated_at DESC`
  )
  const rows = (byProject ? stmt.all(projectId) : stmt.all()) as Array<{
    id: string
    title: string
    project_root: string
    project_id: string | null
    created_at: number
    updated_at: number
    message_count: number
  }>
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    projectRoot: r.project_root,
    projectId: r.project_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count
  }))
}

/**
 * Search all sessions by substring, newest-updated first: a session matches when
 * its title OR any of its message bodies contains `query` (case-insensitive).
 * Global like {@link listSessions} — a `projectId` narrows to one project;
 * `null`/`undefined` search every chat. Returns `[]` for a blank query. Substring
 * `LIKE` (FTS5 deferred; fine at the local, single-user scale).
 */
export function searchSessions(query: string, projectId?: string | null): SessionSummary[] {
  const trimmed = query.trim()
  if (trimmed === '') return []
  // Escape LIKE wildcards so a literal %, _, or \ in the query matches itself.
  const pattern = `%${trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`

  // Only a concrete project id filters; null/undefined search all chats globally.
  const byProject = typeof projectId === 'string'
  const stmt = getDb().prepare(
    `SELECT s.id, s.title, s.project_root, s.project_id, s.created_at, s.updated_at,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
     FROM sessions s
     WHERE ${byProject ? 's.project_id = ? AND ' : ''}(
         s.title LIKE ? ESCAPE '\\'
         OR EXISTS (
           SELECT 1 FROM messages mm
           WHERE mm.session_id = s.id AND mm.content LIKE ? ESCAPE '\\'
         )
       )
     ORDER BY s.updated_at DESC`
  )
  const rows = (
    byProject ? stmt.all(projectId, pattern, pattern) : stmt.all(pattern, pattern)
  ) as Array<{
    id: string
    title: string
    project_root: string
    project_id: string | null
    created_at: number
    updated_at: number
    message_count: number
  }>
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    projectRoot: r.project_root,
    projectId: r.project_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count
  }))
}

/** Rename a session and bump its updated_at. */
export function renameSession(id: string, title: string, now: number): void {
  getDb()
    .prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title, now, id)
}

/** Delete a session; child rows cascade (foreign_keys pragma is on). */
export function deleteSession(id: string): void {
  getDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
}

/**
 * The most-recently-updated session that has messages, or null when history is
 * empty. Global (never project-scoped).
 *
 * Prefers a session that actually has messages so a stray empty draft never wins,
 * falling back to the newest session of any kind. Retained for callers that want
 * to resume the last real chat; startup no longer calls it — the app opens on a
 * fresh landing page instead (see the store's `boot`).
 */
export function mostRecentSession(): string | null {
  const withMessages = getDb()
    .prepare(
      `SELECT s.id FROM sessions s
       WHERE EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
       ORDER BY s.updated_at DESC LIMIT 1`
    )
    .get() as { id: string } | undefined
  if (withMessages) return withMessages.id

  const newest = getDb()
    .prepare(`SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1`)
    .get() as { id: string } | undefined
  return newest?.id ?? null
}

/** Shown on an assistant turn whose run never finished (see {@link reconcileInterruptedRuns}). */
export const INTERRUPTED_NOTE =
  'Interrupted — Sylor closed while this reply was still being written. Press Rewrite to run it again.'

/**
 * Tag assistant turns left empty by a run that never finished.
 *
 * Called once at startup, before any window exists — so no run can be in flight
 * and every empty assistant row is, by definition, the residue of a task cut off
 * by an app quit or crash. Untagged, such a row renders as a blank bubble that
 * looks permanently stuck, and because the message action bar requires content
 * or an error to show, it has no Rewrite button either: a dead end the user
 * can't recover from. Writing the note both explains the gap and brings the
 * Rewrite (resume) action back.
 *
 * Returns how many turns were tagged. Idempotent — `error IS NULL` skips rows
 * already tagged or already carrying a real error.
 */
export function reconcileInterruptedRuns(): number {
  const info = getDb()
    .prepare(
      `UPDATE messages SET error = ?
       WHERE role = 'assistant' AND error IS NULL AND (content IS NULL OR content = '')`
    )
    .run(INTERRUPTED_NOTE)
  return Number(info.changes ?? 0)
}

/** Bump a session's updated_at (called on every child write). */
export function touch(id: string, now: number): void {
  getDb().prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(now, id)
}

/**
 * Load a session's full contents for rehydration: metadata, then messages in
 * `seq` order, then the attachments bound to sent messages. Returns null if the
 * id is unknown (e.g. deleted in another window between list and open).
 */
export function loadSession(id: string): PersistedSession | null {
  const s = getDb()
    .prepare(
      `SELECT id, title, project_root, project_id, created_at, updated_at FROM sessions WHERE id = ?`
    )
    .get(id) as
    | {
        id: string
        title: string
        project_root: string
        project_id: string | null
        created_at: number
        updated_at: number
      }
    | undefined
  if (!s) return null

  const messageRows = getDb()
    .prepare(
      `SELECT id, role, content, error, feedback, flagged FROM messages WHERE session_id = ? ORDER BY seq`
    )
    .all(id) as Array<{
    id: string
    role: string
    content: string
    error: string | null
    feedback: string | null
    flagged: number
  }>
  const messages: PersistedMessage[] = messageRows.map((m) => ({
    id: m.id,
    role: m.role as 'user' | 'assistant',
    content: m.content,
    ...(m.error != null ? { error: m.error } : {}),
    ...(m.feedback === 'like' || m.feedback === 'dislike' ? { feedback: m.feedback } : {}),
    ...(m.flagged === 1 ? { flagged: true } : {})
  }))

  // Only attachments bound to a sent message are history; pending rows (no
  // message_id yet) belong to an in-flight compose and are not rehydrated.
  const attachmentRows = getDb()
    .prepare(
      `SELECT id, session_id, message_id, name, mime, path, size, created_at
       FROM attachments WHERE session_id = ? AND message_id IS NOT NULL ORDER BY created_at`
    )
    .all(id) as Array<{
    id: string
    session_id: string
    message_id: string
    name: string
    mime: string
    path: string
    size: number
    created_at: number
  }>
  const attachments: Attachment[] = attachmentRows.map((a) => ({
    id: a.id,
    sessionId: a.session_id,
    messageId: a.message_id,
    name: a.name,
    mime: a.mime,
    path: a.path,
    size: a.size,
    createdAt: a.created_at
  }))

  const session: SessionSummary = {
    id: s.id,
    title: s.title,
    projectRoot: s.project_root,
    projectId: s.project_id,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    messageCount: messages.length
  }
  return { session, messages, attachments }
}

/**
 * Append (or replace, by id) a chat message and bump the session.
 *
 * `created_at` and `model` are written only on the first insert — deliberately
 * absent from the ON CONFLICT update — so the streaming checkpoints that re-upsert
 * the same assistant row (and a Rewrite that reuses it) keep the moment the turn
 * actually started rather than sliding it forward on every flush.
 */
export function appendMessage(sessionId: string, msg: PersistedMessage, now: number): void {
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, seq, role, content, error, created_at, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content, error = excluded.error`
    )
    .run(
      msg.id,
      sessionId,
      nextSeq('messages', sessionId),
      msg.role,
      msg.content,
      msg.error ?? null,
      now,
      msg.model ?? null
    )
  touch(sessionId, now)
}

/**
 * Set a message's local feedback (like/dislike) and report flag (Phase 5 message
 * actions). Both are local-only markers — never transmitted. A no-op if the id is
 * unknown. Does not touch() the session: an annotation isn't a content change and
 * shouldn't reorder the sidebar.
 */
export function setMessageFeedback(
  id: string,
  feedback: 'like' | 'dislike' | null,
  flagged: boolean
): void {
  getDb()
    .prepare(`UPDATE messages SET feedback = ?, flagged = ? WHERE id = ?`)
    .run(feedback, flagged ? 1 : 0, id)
}

/**
 * Reset an assistant message so a Rewrite/regenerate re-run streams into a clean
 * slot (the same id, overwritten on completion): blank its
 * content/error/feedback/flag. Purely local — nothing leaves the machine. Called
 * before the regenerated run starts so a reload shows only the new result, not
 * the discarded one.
 */
export function resetMessageForRegenerate(messageId: string): void {
  getDb()
    .prepare(
      `UPDATE messages SET content = '', error = NULL, feedback = NULL, flagged = 0 WHERE id = ?`
    )
    .run(messageId)
}
