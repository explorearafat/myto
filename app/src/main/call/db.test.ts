import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { __setDbPathForTest, closeDb } from '../db/db'
import {
  getCallTask,
  insertCallAudit,
  insertCallTask,
  listCallAudit,
  listCallTasks,
  pendingCallbackTasks,
  staleCallingTasks,
  updateCallTask
} from './db'

beforeEach(() => {
  __setDbPathForTest(':memory:')
})

afterEach(() => {
  closeDb()
})

describe('call_tasks', () => {
  it('inserts, updates, and lists tasks', () => {
    insertCallTask({
      id: 'task-1',
      callId: 'call-1',
      sessionId: 's1',
      workspaceDir: 'C:\\work',
      prompt: 'fix the build',
      status: 'running',
      summary: ''
    })
    expect(getCallTask('task-1')?.status).toBe('running')
    expect(getCallTask('task-1')?.terminalStatus).toBeNull()

    updateCallTask('task-1', { status: 'completed', terminalStatus: 'completed', summary: 'done', terminalAt: 5 })
    const updated = getCallTask('task-1')
    expect(updated?.status).toBe('completed')
    expect(updated?.terminalStatus).toBe('completed')
    expect(updated?.summary).toBe('done')

    expect(listCallTasks()).toHaveLength(1)
  })

  it('only owes callbacks for terminal tasks not yet delivered', () => {
    insertCallTask({
      id: 't-done',
      callId: null,
      sessionId: 's',
      workspaceDir: 'w',
      prompt: 'p',
      status: 'completed',
      summary: ''
    })
    updateCallTask('t-done', { status: 'completed', terminalStatus: 'completed' })
    insertCallTask({
      id: 't-run',
      callId: null,
      sessionId: 's',
      workspaceDir: 'w',
      prompt: 'p',
      status: 'running',
      summary: ''
    })
    insertCallTask({
      id: 't-acked',
      callId: null,
      sessionId: 's',
      workspaceDir: 'w',
      prompt: 'p',
      status: 'acknowledged',
      summary: ''
    })
    updateCallTask('t-acked', { status: 'acknowledged', terminalStatus: 'completed' })

    const pending = pendingCallbackTasks()
    expect(pending.map((t) => t.id)).toEqual(['t-done'])
  })

  it('surfaces stale calling tasks for boot reconciliation', () => {
    insertCallTask({
      id: 't-calling',
      callId: 'call-x',
      sessionId: 's',
      workspaceDir: 'w',
      prompt: 'p',
      status: 'calling',
      summary: ''
    })
    updateCallTask('t-calling', { status: 'calling', terminalStatus: 'completed' })
    expect(staleCallingTasks().map((t) => t.id)).toEqual(['t-calling'])
  })
})

describe('call_audit', () => {
  it('records every execution with its tier and approval', () => {
    insertCallAudit({
      callId: 'call-1',
      taskId: null,
      command: 'git status',
      tier: 'read_only',
      approvedBy: 'auto',
      exitCode: 0,
      outcome: 'done'
    })
    insertCallAudit({
      callId: 'call-1',
      taskId: 'task-1',
      command: 'Remove-Item x',
      tier: 'destructive',
      approvedBy: 'voice',
      exitCode: 1,
      outcome: 'done'
    })
    const rows = listCallAudit()
    expect(rows).toHaveLength(2)
    expect(rows[0].command).toBe('Remove-Item x') // newest first
    expect(rows[0].tier).toBe('destructive')
    expect(rows[1].approvedBy).toBe('auto')
  })
})
