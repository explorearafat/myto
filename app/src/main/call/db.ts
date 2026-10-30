/**
 * Persistence for the voice-call system, layered on the same node:sqlite
 * database as sessions/projects (see main/db/db.ts). Two tables:
 *
 *  - `call_tasks`   — tasks started from a call ("finish the auth system"), with
 *                     a callback state machine so a task can be answered, missed,
 *                     and retried exactly once per terminal state (no dup calls).
 *  - `call_audit`   — every command the call system executed: what, which
 *                     permission tier, who approved, how it ended. The paper trail
 *                     that makes remote execution auditable.
 */
import { getDb } from '../db/db'

/** Terminal/progress states of a call-started task. */
export type CallTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'calling' // the callback is ringing
  | 'called' // the callback was answered and delivered
  | 'acknowledged' // delivered via notification (user never answered, saw the push)

export interface CallTaskRow {
  id: string
  callId: string | null
  sessionId: string
  workspaceDir: string
  prompt: string
  status: CallTaskStatus
  /** The outcome that triggered the callback flow ('completed' | 'failed' | 'blocked'). */
  terminalStatus: CallTaskStatus | null
  summary: string
  createdAt: number
  updatedAt: number
  terminalAt: number | null
  callbackAttempts: number
  lastCallbackAt: number | null
}

export interface CallAuditRow {
  id: number
  callId: string
  taskId: string | null
  ts: number
  command: string
  tier: string
  approvedBy: string
  exitCode: number | null
  outcome: string
}

export function insertCallTask(
  task: Omit<
    CallTaskRow,
    'createdAt' | 'updatedAt' | 'terminalAt' | 'callbackAttempts' | 'lastCallbackAt' | 'terminalStatus'
  >
): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO call_tasks (id, call_id, session_id, workspace_dir, prompt, status, terminal_status, summary,
         created_at, updated_at, terminal_at, callback_attempts, last_callback_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 0, NULL)`
    )
    .run(task.id, task.callId, task.sessionId, task.workspaceDir, task.prompt, task.status, task.summary, now, now)
}

export function updateCallTask(id: string, patch: Partial<CallTaskRow>): void {
  const existing = getCallTask(id)
  if (!existing) return
  const next: CallTaskRow = { ...existing, ...patch, updatedAt: Date.now() }
  getDb()
    .prepare(
      `UPDATE call_tasks SET call_id = ?, status = ?, terminal_status = ?, summary = ?, updated_at = ?,
         terminal_at = ?, callback_attempts = ?, last_callback_at = ? WHERE id = ?`
    )
    .run(
      next.callId,
      next.status,
      next.terminalStatus,
      next.summary,
      next.updatedAt,
      next.terminalAt,
      next.callbackAttempts,
      next.lastCallbackAt,
      id
    )
}

export function getCallTask(id: string): CallTaskRow | null {
  const row = getDb().prepare(`SELECT * FROM call_tasks WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  return row ? rowToTask(row) : null
}

export function listCallTasks(limit = 50): CallTaskRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM call_tasks ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>
  return rows.map(rowToTask)
}

/**
 * Tasks that reached a terminal state and still owe the user a callback — the
 * sweep the callback manager runs at boot and after every terminal event.
 */
export function pendingCallbackTasks(): CallTaskRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM call_tasks
       WHERE terminal_status IN ('completed', 'failed', 'blocked')
         AND status NOT IN ('calling', 'called', 'acknowledged', 'cancelled')
       ORDER BY terminal_at IS NULL DESC, terminal_at DESC`
    )
    .all() as Array<Record<string, unknown>>
  return rows.map(rowToTask)
}

/** Stale in-flight callbacks from a previous run (restart mid-callback). */
export function staleCallingTasks(): CallTaskRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM call_tasks WHERE status = 'calling'`)
    .all() as Array<Record<string, unknown>>
  return rows.map(rowToTask)
}

export function insertCallAudit(row: Omit<CallAuditRow, 'id' | 'ts'> & { ts?: number }): void {
  getDb()
    .prepare(
      `INSERT INTO call_audit (call_id, task_id, ts, command, tier, approved_by, exit_code, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.callId,
      row.taskId,
      row.ts ?? Date.now(),
      row.command,
      row.tier,
      row.approvedBy,
      row.exitCode,
      row.outcome
    )
}

export function listCallAudit(limit = 200): CallAuditRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM call_audit ORDER BY id DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    callId: String(r.call_id ?? ''),
    taskId: (r.task_id as string | null) ?? null,
    ts: Number(r.ts),
    command: String(r.command ?? ''),
    tier: String(r.tier ?? ''),
    approvedBy: String(r.approved_by ?? ''),
    exitCode: r.exit_code === null || r.exit_code === undefined ? null : Number(r.exit_code),
    outcome: String(r.outcome ?? '')
  }))
}

function rowToTask(r: Record<string, unknown>): CallTaskRow {
  return {
    id: String(r.id),
    callId: (r.call_id as string | null) ?? null,
    sessionId: String(r.session_id ?? ''),
    workspaceDir: String(r.workspace_dir ?? ''),
    prompt: String(r.prompt ?? ''),
    status: r.status as CallTaskStatus,
    terminalStatus: (r.terminal_status as CallTaskStatus | null) ?? null,
    summary: String(r.summary ?? ''),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    terminalAt: (r.terminal_at as number | null) ?? null,
    callbackAttempts: Number(r.callback_attempts ?? 0),
    lastCallbackAt: (r.last_callback_at as number | null) ?? null
  }
}
