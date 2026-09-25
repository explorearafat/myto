import { beforeEach, describe, expect, it } from 'vitest'
import { useTerminalStore } from './useTerminalStore'
import type { CommandRun } from '@shared/types'

const run = (command: string, output = 'ok'): CommandRun => ({ command, output, exitCode: 0 })

beforeEach(() => {
  useTerminalStore.setState({ open: false, entries: [] })
})

describe('useTerminalStore', () => {
  it('append records the command and reveals the pane', () => {
    useTerminalStore.getState().append(run('npm test'))
    expect(useTerminalStore.getState().open).toBe(true)
    expect(useTerminalStore.getState().entries.map((e) => e.command)).toEqual(['npm test'])
  })

  it('keeps the transcript in order across appends', () => {
    useTerminalStore.getState().append(run('npm install'))
    useTerminalStore.getState().append(run('npm run build'))
    expect(useTerminalStore.getState().entries.map((e) => e.command)).toEqual([
      'npm install',
      'npm run build'
    ])
  })

  it('bounds the transcript, dropping the oldest past the cap', () => {
    for (let i = 0; i < 250; i++) useTerminalStore.getState().append(run(`cmd-${i}`))
    const entries = useTerminalStore.getState().entries
    expect(entries).toHaveLength(200)
    // The 50 oldest were dropped; the newest is kept last.
    expect(entries[0].command).toBe('cmd-50')
    expect(entries.at(-1)!.command).toBe('cmd-249')
  })

  it('clear empties the transcript but leaves the pane open', () => {
    useTerminalStore.getState().append(run('npm test'))
    useTerminalStore.getState().clear()
    expect(useTerminalStore.getState().entries).toEqual([])
    expect(useTerminalStore.getState().open).toBe(true)
  })

  it('show/close toggle only visibility, never the transcript', () => {
    useTerminalStore.getState().append(run('npm test'))
    useTerminalStore.getState().close()
    expect(useTerminalStore.getState().open).toBe(false)
    expect(useTerminalStore.getState().entries).toHaveLength(1)
    useTerminalStore.getState().show()
    expect(useTerminalStore.getState().open).toBe(true)
    expect(useTerminalStore.getState().entries).toHaveLength(1)
  })
})
