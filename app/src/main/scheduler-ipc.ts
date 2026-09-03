import { BrowserWindow, ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { ScheduledTask, ScheduledTaskInput, WorkMode } from '../shared/types'
import { Scheduler } from './scheduler'
import { scheduledTaskStore } from './db/scheduledTasks'

/**
 * Scheduled-tasks IPC (Phase 4) — the renderer-facing door onto the single
 * {@link Scheduler} instance, plus its lifecycle (start ticking on app ready,
 * stop on quit).
 *
 * The scheduler owns the task list and all cron logic; here we only:
 *  - construct it once with the real clock, the DB-backed durable store, and a
 *    `fire` that broadcasts {@link IpcChannel.SchedulerTaskFired} to every
 *    renderer (the renderer opens a fresh chat and sends the prompt — reusing the
 *    ordinary run path so a scheduled run still pauses at sensitive tools rather
 *    than acting silently), and
 *  - expose thin CRUD handlers.
 *
 * `add`/`update` deliberately let an invalid-cron error propagate so the invoke
 * rejects and the Settings UI can show it; everything else is defensive.
 */

/** Ticks often enough to never miss a minute boundary (cron's finest granularity). */
const TICK_INTERVAL_MS = 30_000

let scheduler: Scheduler | null = null

/** Broadcast a fired task to every live renderer so one of them runs it. */
function broadcastFired(task: ScheduledTask): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannel.SchedulerTaskFired, task)
  }
}

/** Validate/normalize an untrusted IPC payload into a {@link ScheduledTaskInput}. */
function coerceInput(raw: unknown): ScheduledTaskInput {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid task input')
  const o = raw as Record<string, unknown>
  if (typeof o.name !== 'string' || typeof o.prompt !== 'string' || typeof o.cron !== 'string') {
    throw new Error('Task requires name, prompt, and cron')
  }
  const input: ScheduledTaskInput = { name: o.name, prompt: o.prompt, cron: o.cron }
  if (typeof o.enabled === 'boolean') input.enabled = o.enabled
  if (typeof o.durable === 'boolean') input.durable = o.durable
  if (o.mode === 'code' || o.mode === 'cowork') input.mode = o.mode as WorkMode
  return input
}

/** Lazily build the single scheduler instance (durable tasks rehydrated from the DB). */
function ensureScheduler(): Scheduler {
  if (!scheduler) {
    scheduler = new Scheduler({
      clock: { now: () => Date.now() },
      store: scheduledTaskStore,
      fire: broadcastFired
    })
  }
  return scheduler
}

/**
 * Register IPC handlers and start the tick loop. Called once on app ready, after
 * the DB path is set (the store reads durable tasks on first construction).
 */
export function registerSchedulerIpc(): void {
  const sched = ensureScheduler()

  ipcMain.handle(IpcChannel.SchedulerList, (): ScheduledTask[] => sched.list())

  ipcMain.handle(IpcChannel.SchedulerAdd, (_event, input: unknown): ScheduledTask =>
    sched.add(coerceInput(input))
  )

  ipcMain.handle(
    IpcChannel.SchedulerUpdate,
    (_event, id: unknown, input: unknown): ScheduledTask | null => {
      if (typeof id !== 'string') throw new Error('Invalid task id')
      return sched.update(id, coerceInput(input))
    }
  )

  ipcMain.handle(
    IpcChannel.SchedulerSetEnabled,
    (_event, id: unknown, enabled: unknown): ScheduledTask | null => {
      if (typeof id !== 'string' || typeof enabled !== 'boolean') {
        throw new Error('Invalid setEnabled arguments')
      }
      return sched.setEnabled(id, enabled)
    }
  )

  ipcMain.handle(IpcChannel.SchedulerRemove, (_event, id: unknown): void => {
    if (typeof id !== 'string') return
    sched.remove(id)
  })

  sched.start(TICK_INTERVAL_MS)
}

/** Stop the tick loop on app shutdown (durable tasks are already persisted). */
export function stopScheduler(): void {
  scheduler?.stop()
}
