import type { ChatMode, ScheduledTask } from '../../shared/types'
import { getDb } from './db'

/**
 * Typed access to the `scheduled_tasks` table (#12). A scheduled task is a stored
 * prompt the main-process scheduler ({@link ../scheduler}) fires on a cron cadence,
 * opening a fresh chat each time (the table has no session FK — a task isn't tied to
 * any one conversation). This module is pure persistence: the cron math and the
 * firing live in the scheduler; the IPC layer computes `next_run_at` before writing.
 *
 * Only *durable* tasks land here (the UI creates nothing else), so `durable` is
 * always written 1 — the column is kept for the session-only variant the scheduler
 * may hold in memory later.
 */

/** Shape of a raw `scheduled_tasks` row as sqlite hands it back. */
interface TaskRow {
  id: string
  name: string
  prompt: string
  cron: string
  enabled: number
  durable: number
  mode: string | null
  created_at: number
  updated_at: number
  last_run_at: number | null
  next_run_at: number | null
}

function toTask(r: TaskRow): ScheduledTask {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    cron: r.cron,
    enabled: r.enabled !== 0,
    mode: r.mode === 'cowork' ? 'cowork' : 'chat',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at
  }
}

/** The columns an insert/update supplies (keys computed by the caller). */
export interface NewScheduledTask {
  id: string
  name: string
  prompt: string
  cron: string
  enabled: boolean
  mode: ChatMode
  createdAt: number
  updatedAt: number
  nextRunAt: number | null
}

/** Insert one task row and return the persisted task. */
export function insertScheduledTask(t: NewScheduledTask): ScheduledTask {
  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks
         (id, name, prompt, cron, enabled, durable, mode, created_at, updated_at, last_run_at, next_run_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?)`
    )
    .run(
      t.id,
      t.name,
      t.prompt,
      t.cron,
      t.enabled ? 1 : 0,
      t.mode,
      t.createdAt,
      t.updatedAt,
      t.nextRunAt
    )
  return getScheduledTask(t.id)!
}

/** One task by id, or null if unknown. */
export function getScheduledTask(id: string): ScheduledTask | null {
  const row = getDb().prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as
    | TaskRow
    | undefined
  return row ? toTask(row) : null
}

/** All tasks, most-recently-updated first. */
export function listScheduledTasks(): ScheduledTask[] {
  const rows = getDb()
    .prepare(`SELECT * FROM scheduled_tasks ORDER BY updated_at DESC`)
    .all() as unknown as TaskRow[]
  return rows.map(toTask)
}

/** Enabled tasks whose `next_run_at` is at or before `now` (the scheduler's due set). */
export function listDueScheduledTasks(now: number): ScheduledTask[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC`
    )
    .all(now) as unknown as TaskRow[]
  return rows.map(toTask)
}

/** Fields an update may patch. Undefined keys are left untouched. */
export interface ScheduledTaskPatch {
  name?: string
  prompt?: string
  cron?: string
  enabled?: boolean
  mode?: ChatMode
  updatedAt: number
  /** Passed when the cron/enabled changed so the schedule is recomputed. */
  nextRunAt?: number | null
}

/**
 * Patch a task's editable fields. Only the keys present are written (COALESCE keeps
 * the stored value for the rest). Returns the updated task, or null if unknown.
 */
export function updateScheduledTask(id: string, patch: ScheduledTaskPatch): ScheduledTask | null {
  if (!getScheduledTask(id)) return null
  getDb()
    .prepare(
      `UPDATE scheduled_tasks SET
         name        = COALESCE(?, name),
         prompt      = COALESCE(?, prompt),
         cron        = COALESCE(?, cron),
         enabled     = COALESCE(?, enabled),
         mode        = COALESCE(?, mode),
         next_run_at = CASE WHEN ? THEN ? ELSE next_run_at END,
         updated_at  = ?
       WHERE id = ?`
    )
    .run(
      patch.name ?? null,
      patch.prompt ?? null,
      patch.cron ?? null,
      patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
      patch.mode ?? null,
      'nextRunAt' in patch ? 1 : 0,
      patch.nextRunAt ?? null,
      patch.updatedAt,
      id
    )
  return getScheduledTask(id)
}

/** Record a fire: stamp `last_run_at` and set the recomputed `next_run_at`. */
export function markScheduledTaskFired(id: string, lastRunAt: number, nextRunAt: number | null): void {
  getDb()
    .prepare(`UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?`)
    .run(lastRunAt, nextRunAt, id)
}

/** Delete a task by id. */
export function deleteScheduledTask(id: string): void {
  getDb().prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id)
}
