import type { ScheduledTask, WorkMode } from '../../shared/types'
import type { ScheduledTaskStore } from '../scheduler'
import { getDb } from './db'

/**
 * DB-backed {@link ScheduledTaskStore} for *durable* scheduled tasks (Phase 4).
 *
 * The {@link file://../scheduler.ts Scheduler} owns the in-memory task list and
 * all scheduling logic; this module is only the persistence seam it writes
 * through, so durable tasks survive a restart. Session-only tasks never reach
 * here. Kept electron-free (queries go through the injected DB path) and shaped
 * like {@link file://./projects.ts projects.ts}: main process is the single
 * writer, rows map to camelCase, and `enabled`/`durable` round-trip as 0/1 ints.
 */

interface Row {
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

/** Map a DB row to the shared {@link ScheduledTask} shape. */
function fromRow(r: Row): ScheduledTask {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    cron: r.cron,
    enabled: r.enabled !== 0,
    durable: r.durable !== 0,
    ...(r.mode ? { mode: r.mode as WorkMode } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.last_run_at != null ? { lastRunAt: r.last_run_at } : {}),
    ...(r.next_run_at != null ? { nextRunAt: r.next_run_at } : {})
  }
}

/** All durable tasks (loaded once when the Scheduler is constructed). */
export function listScheduledTasks(): ScheduledTask[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, prompt, cron, enabled, durable, mode,
              created_at, updated_at, last_run_at, next_run_at
       FROM scheduled_tasks
       ORDER BY created_at`
    )
    // Nullable columns (mode/last_run_at/next_run_at) don't structurally overlap
    // the sqlite row index type, so narrow through `unknown` — the SELECT above
    // fixes the shape.
    .all() as unknown as Row[]
  return rows.map(fromRow)
}

/** Insert or replace a durable task (keyed by its scheduler-minted id). */
export function upsertScheduledTask(task: ScheduledTask): void {
  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks
         (id, name, prompt, cron, enabled, durable, mode, created_at, updated_at, last_run_at, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name        = excluded.name,
         prompt      = excluded.prompt,
         cron        = excluded.cron,
         enabled     = excluded.enabled,
         durable     = excluded.durable,
         mode        = excluded.mode,
         updated_at  = excluded.updated_at,
         last_run_at = excluded.last_run_at,
         next_run_at = excluded.next_run_at`
    )
    .run(
      task.id,
      task.name,
      task.prompt,
      task.cron,
      task.enabled ? 1 : 0,
      task.durable ? 1 : 0,
      task.mode ?? null,
      task.createdAt,
      task.updatedAt,
      task.lastRunAt ?? null,
      task.nextRunAt ?? null
    )
}

/** Delete a durable task by id (no-op if absent). */
export function removeScheduledTask(id: string): void {
  getDb().prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id)
}

/** The {@link ScheduledTaskStore} the main process hands the Scheduler. */
export const scheduledTaskStore: ScheduledTaskStore = {
  list: listScheduledTasks,
  upsert: upsertScheduledTask,
  remove: removeScheduledTask
}
