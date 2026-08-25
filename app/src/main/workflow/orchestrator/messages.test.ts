import { describe, expect, it } from 'vitest'
import {
  ORCHESTRATOR,
  blocked,
  dependencyReady,
  message,
  retryRequired,
  started,
  statusFor,
  taskAssigned,
  taskCompleted,
  taskFailed
} from '@main/workflow/orchestrator/messages'

const base = { taskId: 't1', agentId: 'agent-1', role: 'backend', summary: 'do the thing' }

describe('message factories', () => {
  it('builds a generic message from the common fields', () => {
    const m = message('FINDING', base, { findings: [] })
    expect(m).toMatchObject({ type: 'FINDING', taskId: 't1', agentId: 'agent-1', role: 'backend' })
  })

  it('taskAssigned carries dependencies + ready status', () => {
    const m = taskAssigned(base, { dependencies: ['t0'], recipient: 'backend' })
    expect(m.type).toBe('TASK_ASSIGNED')
    expect(m.status).toBe('ready')
    expect(m.dependencies).toEqual(['t0'])
    expect(m.recipient).toBe('backend')
  })

  it('started marks the task running', () => {
    expect(started(base).status).toBe('running')
  })

  it('taskCompleted carries filesChanged + completed status', () => {
    const m = taskCompleted(base, { filesChanged: ['a.ts', 'b.ts'] })
    expect(m.type).toBe('TASK_COMPLETED')
    expect(m.status).toBe('completed')
    expect(m.filesChanged).toEqual(['a.ts', 'b.ts'])
  })

  it('taskFailed carries errors + failed status', () => {
    const m = taskFailed(base, ['it broke'])
    expect(m.type).toBe('TASK_FAILED')
    expect(m.status).toBe('failed')
    expect(m.errors).toEqual(['it broke'])
  })

  it('retryRequired carries a reason as nextAction + retrying status', () => {
    const m = retryRequired(base, { recipient: 'backend', reason: 'tests still red', parentTaskId: 't0' })
    expect(m.type).toBe('RETRY_REQUIRED')
    expect(m.status).toBe('retrying')
    expect(m.nextAction).toBe('tests still red')
    expect(m.parentTaskId).toBe('t0')
  })

  it('dependencyReady + blocked set the expected statuses', () => {
    expect(dependencyReady(base, ['t0']).status).toBe('ready')
    expect(blocked(base, 'dep failed').status).toBe('blocked')
  })

  it('exposes the orchestrator sender constant', () => {
    expect(ORCHESTRATOR).toBe('orchestrator')
  })
})

describe('statusFor', () => {
  it('maps task states to message types', () => {
    expect(statusFor('completed')).toBe('TASK_COMPLETED')
    expect(statusFor('failed')).toBe('TASK_FAILED')
    expect(statusFor('running')).toBe('STARTED')
    expect(statusFor('retrying')).toBe('RETRY_REQUIRED')
    expect(statusFor('blocked')).toBe('BLOCKED')
    expect(statusFor('ready')).toBe('DEPENDENCY_READY')
    expect(statusFor('pending')).toBe('TASK_ASSIGNED')
  })
})
