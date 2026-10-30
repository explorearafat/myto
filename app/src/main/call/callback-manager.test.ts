import { describe, expect, it, vi } from 'vitest'

// The callback-manager module graph touches Electron (auth-flow's BrowserWindow
// usage) and the settings store — both stubbed so the pure script-building
// logic under test stays isolated.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../settings', () => ({
  getSettings: () => ({
    call: {
      enabled: true,
      autoAnswer: true,
      answerDelayMs: 5500,
      turn: { urls: [], username: '', credential: '' },
      permissionMode: 'ask',
      callbacks: { enabled: true, retryLimit: 2, retryAfterMin: 5 }
    },
    cowork: { workspaceDir: '' }
  })
}))

import { callbackScript } from './callback-manager'
import type { CallTaskRow } from './db'

const base: CallTaskRow = {
  id: 'task-1',
  callId: null,
  sessionId: 's1',
  workspaceDir: 'C:\\work',
  prompt: 'fix the build',
  status: 'completed',
  terminalStatus: 'completed',
  summary: 'All 12 tests pass now.',
  createdAt: 0,
  updatedAt: 0,
  terminalAt: 0,
  callbackAttempts: 0,
  lastCallbackAt: null
}

describe('callbackScript', () => {
  it('speaks the completion script', () => {
    const script = callbackScript(base)
    expect(script).toContain("I've finished working on your project")
    expect(script).toContain('All 12 tests pass now.')
  })
  it('speaks the failure script', () => {
    const script = callbackScript({ ...base, status: 'failed', terminalStatus: 'failed' })
    expect(script).toContain('encountered an issue')
    expect(script).toContain('need your input')
  })
  it('speaks the blocked script', () => {
    const script = callbackScript({ ...base, status: 'blocked', terminalStatus: 'blocked' })
    expect(script).toContain('need your input')
  })
})
