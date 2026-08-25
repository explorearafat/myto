import type {
  Attachment,
  PersistedMessage,
  PersistedSession,
  PersistedToolOp,
  SessionSummary,
  ToolProposal,
  ToolResult
} from '../../shared/types'
import { getDb } from './db'

/**
 * Typed CRUD over the session tables (Phase 5). The main process is the single
 * writer, so per-session `seq` ordering is derived with `MAX(seq)+1` at append
 * time without a race. JSON (de)serialization of tool proposals/results lives
 * here — the shared types are the contract; the DB stores their `_json` columns.
 *
 * Every function is defensively usable from fire-and-forget IPC: they throw only
 * on genuine programmer error, and the callers wrap append writes so a DB fault
 * never breaks the live chat or terminal.
 */

let idCounter = 0

/** Generate a unique session id. Time-free (Date.now is passed in) for tests. */
function nextSessionId(now: number): string {
  idCounter += 1
  return `sess-${now}-${idCounter}`
}

/**
 * The session terminal output is currently logged to. Set by the IPC layer on
 * load/create so the terminal choke point (`emitData`) knows where to append
 * without threading the id through every pty callback. Null before any session
 * is open (log nothing).
 */
let activeSessionId: string | null = null

/** Mark the session that live terminal output should be appended to. */
export function setActiveSession(id: string | null): void {
  activeSessionId = id
}

/** The session terminal output is being logged to, or null. */
export function getActiveSession(): string | null {
  return activeSessionId
}

/** Next append position within a session for the given table. */
function nextSeq(table: 'messages' | 'tool_ops' | 'terminal_logs', sessionId: string): number {
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
 * Sessions for a project root, newest-updated first, with message counts. When
 * `projectId` is provided, the list is further scoped to chats filed under that
 * project (pass `null` explicitly to list only *unfiled* chats).
 */
export function listSessions(
  projectRoot: string,
  projectId?: string | null
): SessionSummary[] {
  // `projectId === undefined` → no project filter; `null` → only unfiled chats;
  // a string → that project. SQLite can't bind IS NULL, so branch the clause.
  const filterByProject = projectId !== undefined
  const projectClause = filterByProject
    ? projectId === null
      ? ' AND s.project_id IS NULL'
      : ' AND s.project_id = ?'
    : ''
  const stmt = getDb().prepare(
    `SELECT s.id, s.title, s.project_root, s.project_id, s.created_at, s.updated_at,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
     FROM sessions s
     WHERE s.project_root = ?${projectClause}
     ORDER BY s.updated_at DESC`
  )
  const rows = (
    filterByProject && projectId !== null ? stmt.all(projectRoot, projectId) : stmt.all(projectRoot)
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

/**
 * Search a project root's sessions by substring, newest-updated first: a session
 * matches when its title OR any of its message bodies contains `query`
 * (case-insensitive). Scoped like {@link listSessions} — `projectId` narrows to a
 * project (`null` → only unfiled chats, `undefined` → all chats under the root).
 * Returns `[]` for a blank query. Substring `LIKE` (FTS5 deferred; fine at the
 * local, single-user scale).
 */
export function searchSessions(
  projectRoot: string,
  query: string,
  projectId?: string | null
): SessionSummary[] {
  const trimmed = query.trim()
  if (trimmed === '') return []
  // Escape LIKE wildcards so a literal %, _, or \ in the query matches itself.
  const pattern = `%${trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`

  // Same project-scope branching as listSessions (SQLite can't bind IS NULL).
  const filterByProject = projectId !== undefined
  const projectClause = filterByProject
    ? projectId === null
      ? ' AND s.project_id IS NULL'
      : ' AND s.project_id = ?'
    : ''
  const stmt = getDb().prepare(
    `SELECT s.id, s.title, s.project_root, s.project_id, s.created_at, s.updated_at,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
     FROM sessions s
     WHERE s.project_root = ?${projectClause}
       AND (
         s.title LIKE ? ESCAPE '\\'
         OR EXISTS (
           SELECT 1 FROM messages mm
           WHERE mm.session_id = s.id AND mm.content LIKE ? ESCAPE '\\'
         )
       )
     ORDER BY s.updated_at DESC`
  )
  const rows = (
    filterByProject && projectId !== null
      ? stmt.all(projectRoot, projectId, pattern, pattern)
      : stmt.all(projectRoot, pattern, pattern)
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
 * The session to reopen on startup for a project root, or null when there are
 * none.
 *
 * Prefers the most-recently-updated session that actually has messages. A blank
 * session — the one the New Chat button creates, then left unused — carries a
 * fresh `updated_at` and would otherwise win, booting the user into an empty
 * chat and making the work they left behind look deleted. Falls back to the
 * newest session of any kind so a genuinely empty history still opens something.
 */
export function mostRecentSession(projectRoot: string): string | null {
  const withMessages = getDb()
    .prepare(
      `SELECT s.id FROM sessions s
       WHERE s.project_root = ?
         AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
       ORDER BY s.updated_at DESC LIMIT 1`
    )
    .get(projectRoot) as { id: string } | undefined
  if (withMessages) return withMessages.id

  const newest = getDb()
    .prepare(
      `SELECT id FROM sessions WHERE project_root = ? ORDER BY updated_at DESC LIMIT 1`
    )
    .get(projectRoot) as { id: string } | undefined
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
 * Load a session's full contents for rehydration: metadata, then messages,
 * tools, and terminal chunks each in `seq` order. Returns null if the id is
 * unknown (e.g. deleted in another window between list and open).
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

  const toolRows = getDb()
    .prepare(
      `SELECT id, after_msg_id, run_id, auto, decision, proposal_json, result_json, content_offset
       FROM tool_ops WHERE session_id = ? ORDER BY seq`
    )
    .all(id) as Array<{
    id: string
    after_msg_id: string
    run_id: string
    auto: number
    decision: string | null
    proposal_json: string
    result_json: string | null
    content_offset: number | null
  }>
  const tools: PersistedToolOp[] = toolRows.map((t) => ({
    id: t.id,
    afterMessageId: t.after_msg_id,
    runId: t.run_id,
    auto: t.auto === 1,
    ...(t.decision != null ? { decision: t.decision as PersistedToolOp['decision'] } : {}),
    proposal: JSON.parse(t.proposal_json) as ToolProposal,
    ...(t.result_json != null ? { result: JSON.parse(t.result_json) as ToolResult } : {}),
    ...(t.content_offset != null ? { contentOffset: t.content_offset } : {})
  }))

  const terminalRows = getDb()
    .prepare(`SELECT data FROM terminal_logs WHERE session_id = ? ORDER BY seq`)
    .all(id) as Array<{ data: string }>
  const terminal = terminalRows.map((r) => r.data)

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
  return { session, messages, tools, terminal, attachments }
}

/** Append (or replace, by id) a chat message and bump the session. */
export function appendMessage(sessionId: string, msg: PersistedMessage, now: number): void {
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, seq, role, content, error)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content, error = excluded.error`
    )
    .run(
      msg.id,
      sessionId,
      nextSeq('messages', sessionId),
      msg.role,
      msg.content,
      msg.error ?? null
    )
  touch(sessionId, now)
}

/** Finalize a streamed assistant turn's content/error (no seq change). */
export function updateMessage(id: string, content: string, error: string | undefined, now: number): void {
  const row = getDb().prepare(`SELECT session_id FROM messages WHERE id = ?`).get(id) as
    | { session_id: string }
    | undefined
  if (!row) return
  getDb()
    .prepare(`UPDATE messages SET content = ?, error = ? WHERE id = ?`)
    .run(content, error ?? null, id)
  touch(row.session_id, now)
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
 * slot (the same id, overwritten on completion): delete the tool ops anchored
 * beneath it and blank its content/error/feedback/flag. Purely local — nothing
 * leaves the machine. Called before the regenerated run starts so a reload shows
 * only the new result, not the discarded one plus its stale tool cards.
 */
export function resetMessageForRegenerate(messageId: string): void {
  const db = getDb()
  db.prepare(`DELETE FROM tool_ops WHERE after_msg_id = ?`).run(messageId)
  db.prepare(
    `UPDATE messages SET content = '', error = NULL, feedback = NULL, flagged = 0 WHERE id = ?`
  ).run(messageId)
}

/** Append (or replace, by id) a completed tool operation and bump the session. */
export function appendToolOp(sessionId: string, op: PersistedToolOp, now: number): void {
  getDb()
    .prepare(
      `INSERT INTO tool_ops
         (id, session_id, seq, after_msg_id, run_id, auto, decision, proposal_json, result_json, content_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         decision = excluded.decision,
         result_json = excluded.result_json`
    )
    .run(
      op.id,
      sessionId,
      nextSeq('tool_ops', sessionId),
      op.afterMessageId,
      op.runId,
      op.auto ? 1 : 0,
      op.decision ?? null,
      JSON.stringify(op.proposal),
      op.result != null ? JSON.stringify(op.result) : null,
      // content_offset anchors this card at the point in the assistant's prose
      // where it was proposed (think → act → think). Set once at first insert;
      // not in the ON CONFLICT UPDATE (the result arrives later but the anchor
      // never moves). Nullable — older rows / non-anchored ops stay NULL.
      op.contentOffset ?? null
    )
  touch(sessionId, now)
}

/** Append a raw terminal output chunk (ANSI preserved). Does not touch(). */
export function appendTerminalChunk(sessionId: string, data: string): void {
  getDb()
    .prepare(`INSERT INTO terminal_logs (session_id, seq, data) VALUES (?, ?, ?)`)
    .run(sessionId, nextSeq('terminal_logs', sessionId), data)
}
