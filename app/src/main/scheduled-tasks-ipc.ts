import { BrowserWindow, ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { ChatMode, ScheduledTask, ScheduledTaskInput } from '../shared/types'
import {
  deleteScheduledTask,
  getScheduledTask,
  insertScheduledTask,
  listScheduledTasks,
  markScheduledTaskFired,
  updateScheduledTask
} from './db/scheduled-tasks'
import { computeNextRun, createScheduler, parseCron } from './scheduler'

/*
 * Scheduled-tasks IPC (#12).
 *
 * The renderer edits the durable task list through invoke handlers here; the
 * main-process {@link createScheduler} watches the clock and, when a task comes due,
 * this module pushes a {@link IpcChannel.ScheduledTaskFire} to every window. The
 * renderer turns that into a fresh run with the task's stored prompt — the scheduler
 * itself never touches the model or a session, keeping it electron-free and testable.
 */

/** Push a fire event (a task came due, or Run now) to every open window. */
function broadcastFire(task: ScheduledTask): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IpcChannel.ScheduledTaskFire, {
      taskId: task.id,
      name: task.name,
      prompt: task.prompt,
      mode: task.mode
    })
  }
}

const scheduler = createScheduler({ onFire: broadcastFire })

/** A short, stable id for a new task. */
function newTaskId(): string {
  return `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** A default label from the prompt when the user leaves the name blank. */
function deriveName(prompt: string): string {
  const line = prompt.trim().split('\n')[0].trim()
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'Scheduled task'
}

function coerceMode(mode: unknown): ChatMode {
  return mode === 'cowork' ? 'cowork' : 'chat'
}

/** Validate + normalise a create/update payload. Throws on a malformed cron. */
function sanitizeInput(raw: unknown): ScheduledTaskInput {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : ''
  const cron = typeof o.cron === 'string' ? o.cron.trim() : ''
  if (!prompt) throw new Error('A scheduled task needs a prompt.')
  if (!parseCron(cron)) throw new Error(`"${cron}" is not a valid 5-field cron expression.`)
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : deriveName(prompt)
  const enabled = o.enabled !== false // default on
  return { name, prompt, cron, enabled, mode: coerceMode(o.mode) }
}

function create(raw: unknown): ScheduledTask {
  const input = sanitizeInput(raw)
  const now = Date.now()
  return insertScheduledTask({
    id: newTaskId(),
    ...input,
    createdAt: now,
    updatedAt: now,
    nextRunAt: input.enabled ? computeNextRun(input.cron, now) : null
  })
}

function update(id: unknown, raw: unknown): ScheduledTask | null {
  if (typeof id !== 'string') return null
  const existing = getScheduledTask(id)
  if (!existing) return null
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const now = Date.now()

  // Only fields present in the patch change; validate a cron if one was supplied.
  const cron = typeof o.cron === 'string' ? o.cron.trim() : undefined
  if (cron !== undefined && !parseCron(cron)) {
    throw new Error(`"${cron}" is not a valid 5-field cron expression.`)
  }
  const enabled = typeof o.enabled === 'boolean' ? o.enabled : undefined
  const name = typeof o.name === 'string' ? o.name.trim() || existing.name : undefined
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim() || existing.prompt : undefined
  const mode = o.mode === undefined ? undefined : coerceMode(o.mode)

  // Recompute next_run_at whenever the cron or the enabled flag moved.
  const effectiveCron = cron ?? existing.cron
  const effectiveEnabled = enabled ?? existing.enabled
  const scheduleChanged = cron !== undefined || enabled !== undefined
  const nextRunAt = effectiveEnabled ? computeNextRun(effectiveCron, now) : null

  return updateScheduledTask(id, {
    name,
    prompt,
    cron,
    enabled,
    mode,
    updatedAt: now,
    ...(scheduleChanged ? { nextRunAt } : {})
  })
}

/** Fire a task immediately without disturbing its next scheduled run. */
function runNow(id: unknown): void {
  if (typeof id !== 'string') return
  const task = getScheduledTask(id)
  if (!task) return
  broadcastFire(task)
  // Stamp the manual run but keep next_run_at so the schedule isn't skipped.
  markScheduledTaskFired(id, Date.now(), task.nextRunAt)
}

/** Register the scheduled-task handlers and start the cron tick. */
export function registerScheduledTasksIpc(): void {
  ipcMain.handle(IpcChannel.ScheduledTasksList, () => listScheduledTasks())
  ipcMain.handle(IpcChannel.ScheduledTasksCreate, (_event, input: unknown) => create(input))
  ipcMain.handle(IpcChannel.ScheduledTasksUpdate, (_event, id: unknown, input: unknown) =>
    update(id, input)
  )
  ipcMain.handle(IpcChannel.ScheduledTasksRemove, (_event, id: unknown) => {
    if (typeof id === 'string') deleteScheduledTask(id)
  })
  ipcMain.handle(IpcChannel.ScheduledTasksRunNow, (_event, id: unknown) => runNow(id))
  scheduler.start()
}
