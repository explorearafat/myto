import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { __setDbPathForTest, closeDb } from '@main/db/db'
import {
  deleteScheduledTask,
  getScheduledTask,
  insertScheduledTask,
  listDueScheduledTasks,
  listScheduledTasks,
  markScheduledTaskFired,
  updateScheduledTask,
  type NewScheduledTask
} from '@main/db/scheduled-tasks'

/** Durable-task CRUD over the throwaway-file DB seam (fresh DB per test). */
let dir: string
let n = 7000
const tick = (): number => (n += 1000)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'myto-tasks-'))
})
afterAll(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  closeDb()
  __setDbPathForTest(join(dir, `t-${n}.db`))
})

const task = (over: Partial<NewScheduledTask> = {}): NewScheduledTask => ({
  id: 't1',
  name: 'Nightly summary',
  prompt: 'summarise today',
  cron: '0 9 * * *',
  enabled: true,
  mode: 'cowork',
  createdAt: tick(),
  updatedAt: tick(),
  nextRunAt: 1_000_000,
  ...over
})

describe('scheduled-tasks DB', () => {
  it('round-trips a task in the camelCase shape', () => {
    const created = insertScheduledTask(task())
    expect(created.id).toBe('t1')
    expect(created.enabled).toBe(true)
    expect(created.mode).toBe('cowork')
    expect(created.nextRunAt).toBe(1_000_000)
    expect(created.lastRunAt).toBeNull()
    expect(getScheduledTask('t1')).toEqual(created)
  })

  it('lists most-recently-updated first', () => {
    insertScheduledTask(task({ id: 'a', updatedAt: 100 }))
    insertScheduledTask(task({ id: 'b', updatedAt: 300 }))
    insertScheduledTask(task({ id: 'c', updatedAt: 200 }))
    expect(listScheduledTasks().map((t) => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('patches only supplied fields and leaves the rest', () => {
    insertScheduledTask(task({ id: 'p', name: 'old', prompt: 'keep me', enabled: true }))
    const updated = updateScheduledTask('p', { name: 'new', enabled: false, updatedAt: tick() })
    expect(updated!.name).toBe('new')
    expect(updated!.enabled).toBe(false)
    expect(updated!.prompt).toBe('keep me') // untouched
  })

  it('updates next_run_at only when the key is present in the patch', () => {
    insertScheduledTask(task({ id: 'q', nextRunAt: 5000 }))
    // No nextRunAt key → left as-is.
    updateScheduledTask('q', { name: 'x', updatedAt: tick() })
    expect(getScheduledTask('q')!.nextRunAt).toBe(5000)
    // Present key → written (even null).
    updateScheduledTask('q', { updatedAt: tick(), nextRunAt: null })
    expect(getScheduledTask('q')!.nextRunAt).toBeNull()
  })

  it('returns null when updating an unknown id', () => {
    expect(updateScheduledTask('nope', { updatedAt: tick() })).toBeNull()
  })

  it('lists only enabled, due tasks in due order', () => {
    insertScheduledTask(task({ id: 'due1', enabled: true, nextRunAt: 100 }))
    insertScheduledTask(task({ id: 'due2', enabled: true, nextRunAt: 50 }))
    insertScheduledTask(task({ id: 'off', enabled: false, nextRunAt: 10 }))
    insertScheduledTask(task({ id: 'future', enabled: true, nextRunAt: 10_000 }))
    insertScheduledTask(task({ id: 'nonull', enabled: true, nextRunAt: null }))
    expect(listDueScheduledTasks(1000).map((t) => t.id)).toEqual(['due2', 'due1'])
  })

  it('marks a fire (last_run_at + next_run_at)', () => {
    insertScheduledTask(task({ id: 'f' }))
    markScheduledTaskFired('f', 42_000, 99_000)
    const t = getScheduledTask('f')!
    expect(t.lastRunAt).toBe(42_000)
    expect(t.nextRunAt).toBe(99_000)
  })

  it('deletes a task', () => {
    insertScheduledTask(task({ id: 'd' }))
    deleteScheduledTask('d')
    expect(getScheduledTask('d')).toBeNull()
  })
})
